#!/usr/bin/env node
// scripts/live-check.mjs — fill real application pages and check that every
// field Landed marks green still holds its value after the site's own scripts
// ran. Saved test pages can't show this (they don't run the site's scripts:
// Lever's location box clears typed text that wasn't picked from its list).
//
//   pnpm --filter ./apps/extension live-check            # postings from public job boards
//   pnpm --filter ./apps/extension live-check <url>...   # these application pages
//   LANDED_EXTENSION_DIR=~/.landed/extension …           # check another copy (e.g. the installed one)
//
// A made-up applicant only. It never submits: the fill never clicks Submit,
// every form submit is blocked and counted, and once the fill starts every
// request that isn't a read (POST, PUT…: Ashby and Greenhouse's React forms
// submit with fetch, no submit event) is blocked at the network and counted.
// A GraphQL query is a read; a mutation never is. It needs Google
// Chrome installed and the network; it isn't part of CI (live sites change).
// Exit code 1 when a page has a green field that's empty.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const EXT = process.env.LANDED_EXTENSION_DIR || join(dirname(fileURLToPath(import.meta.url)), '..')
const scripts = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8')).content_scripts[0].js

const APPLICANT = {
  basic: {
    name: 'Alex Rivera', firstName: 'Alex', lastName: 'Rivera', email: 'alex.rivera@example.com',
    phone: '(206) 555-0142', location: 'Seattle, WA', linkedin: 'https://www.linkedin.com/in/alex-rivera-example',
    github: 'https://github.com/alex-rivera-example',
  },
  education: [{ school: 'University of Washington', degree: 'B.S.', major: 'Informatics', startDate: '2022-09', endDate: '2026-06' }],
  experience: [{ company: 'Northwind Robotics', title: 'Product Intern', startDate: '2025-06', endDate: '2025-09', description: 'Ran user interviews.' }],
  skills: ['SQL', 'Python', 'Figma'],
}
const ANSWERS = { answers: { agree_to_terms: false, custom: [], city: 'Seattle', state: 'WA', country: 'United States' } }

// Public boards (no sign-in) to take one open posting from. Workday needs an
// account to reach its form, so it's checked by hand.
const BOARDS = [
  { ats: 'Lever', slug: 'MachinaLabs' },
  { ats: 'Lever', slug: 'palantir' },
  { ats: 'Greenhouse', slug: 'stripe' },
  { ats: 'Greenhouse', slug: 'figma' },
  { ats: 'Ashby', slug: 'ramp' },
  { ats: 'Ashby', slug: 'notion' },
]

async function postingFrom({ ats, slug }) {
  const get = async (url) => (await fetch(url, { signal: AbortSignal.timeout(15_000) })).json()
  if (ats === 'Lever') {
    const jobs = await get(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`)
    return jobs[0] && `${jobs[0].hostedUrl}/apply`
  }
  if (ats === 'Greenhouse') {
    const { jobs } = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`)
    // The embedded form: a company's own careers page may hold no form at all.
    return jobs?.[0] && `https://job-boards.greenhouse.io/embed/job_app?for=${slug}&token=${jobs[0].id}`
  }
  const { jobs } = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`)
  return jobs?.[0] && `${jobs[0].jobUrl}/application`
}

/** The page side: chrome.* stubs the content scripts read (answers, no files). */
function stubExtension(answers) {
  const store = { 'landed:application-answers': answers, 'landed:application-files': {} }
  const area = {
    get(keys, cb) { const r = {}; for (const k of [].concat(keys ?? Object.keys(store))) if (k in store) r[k] = store[k]; cb?.(r); return Promise.resolve(r) },
    set(o, cb) { Object.assign(store, o); cb?.(); return Promise.resolve() },
    remove(_k, cb) { cb?.() },
  }
  window.chrome = window.chrome || {}
  window.chrome.runtime = {
    id: 'live-check', lastError: undefined, getURL: (x) => x,
    onMessage: { addListener(fn) { window.__landedOnMessage = fn } },
    sendMessage(m, cb) { cb?.(m && m.action === 'native-assist' ? { ok: false, error: 'not in live check' } : undefined) },
  }
  window.chrome.storage = { local: area, session: area, onChanged: { addListener() {} } }
  window.__landedSubmits = 0
  window.addEventListener('submit', (e) => { e.preventDefault(); e.stopImmediatePropagation(); window.__landedSubmits++ }, true)
}

/** Green fields as a person sees them: empty ones are what must never happen.
 *  Written apart from the extension's own check (lib/fill/settle.js), so it
 *  doesn't grade itself. */
function audit() {
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim()
  const label = (el) => clean(el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.name || el.id || '?').slice(0, 60)
  const shown = (el) => !!(el.offsetParent || el.getClientRects().length)
  const placeholder = (t) => /^(search|select( one)?|select\s*(\.\.\.|…)|please select|choose( one)?|--|—)?$/i.test(clean(t).replace(/[*✱]/g, ''))
  const dropdown = (el) => el.tagName === 'BUTTON' || ['combobox', 'listbox'].includes(el.getAttribute('role') || '')
    || !!el.getAttribute('aria-haspopup') || ['list', 'both'].includes(el.getAttribute('aria-autocomplete') || '')
  /** What a person sees in the control: its own text, or its box's (one control per box). */
  const seen = (el) => {
    if (el instanceof HTMLSelectElement) { const o = el.options[el.selectedIndex]; return o && el.value ? o.text : '' }
    if (!dropdown(el)) return 'value' in el ? String(el.value || '') : el.textContent
    if ('value' in el && clean(el.value) && el.tagName !== 'BUTTON') return el.value
    if (!placeholder(el.innerText)) return el.innerText
    let box = el.parentElement
    for (let i = 0; box && i < 4 && !['FORM', 'BODY', 'LABEL', 'FIELDSET'].includes(box.tagName); i++, box = box.parentElement) {
      if (box.querySelectorAll('[role="combobox"], [aria-haspopup], select, textarea, input:not([type="hidden"])').length > 1) break
      let text = clean(box.innerText)
      const l = clean(el.labels?.[0]?.innerText || '')
      if (l && text.startsWith(l)) text = text.slice(l.length).trim()
      if (text && !placeholder(text)) return text
    }
    return ''
  }
  // An application form: a resume upload, or several fields in one form.
  const isForm = !!document.querySelector('input[type="file"]')
    || [...document.forms].some((f) => f.querySelectorAll('input:not([type="hidden"]):not([type="submit"]), textarea, select').length >= 4)
  const greenEmpty = []
  let green = 0
  for (const el of document.querySelectorAll('[data-landed-status="filled"]')) {
    if (!shown(el) || (el instanceof HTMLInputElement && ['file', 'radio', 'checkbox', 'hidden'].includes(el.type))) continue
    green++
    if (!clean(seen(el))) greenEmpty.push(label(el))
  }
  return { isForm, green, greenEmpty, yellow: document.querySelectorAll('[data-landed-status="review"]').length, submits: window.__landedSubmits }
}

/** A GraphQL read (Ashby looks up even locations with POST): a query, never
 *  a mutation (submitting is one). */
function graphqlRead(body) {
  try {
    const ops = [].concat(JSON.parse(body || 'null'))
    return ops.length > 0 && ops.every((op) => op && typeof op.query === 'string' && !/^\s*mutation\b/.test(op.query) && /^\s*(query\b|\{)/.test(op.query))
  } catch {
    return false
  }
}

async function check(browser, url) {
  // The extension's own scripts aren't held to a site's Content Security
  // Policy; injected ones are, so the check lifts it for its own page.
  const context = await browser.newContext({ bypassCSP: true })
  const page = await context.newPage()
  // The page loads as usual; from the fill on, only reads go out.
  let filling = false
  const blocked = []
  await context.route('**/*', (route) => {
    const req = route.request()
    if (!filling || ['GET', 'HEAD', 'OPTIONS'].includes(req.method()) || graphqlRead(req.postData())) return route.continue()
    const u = new URL(req.url())
    let op = ''
    try { op = String(JSON.parse(req.postData() || 'null')?.operationName || '') } catch { /* not JSON */ }
    const what = `${req.method()} ${u.host}${u.pathname}${op ? ` (${op})` : ''}`.slice(0, 140)
    // A submission by its name; the rest (Ashby saving each field as a draft,
    // analytics) is blocked too, but isn't one.
    blocked.push({ what, submit: /submit|apply|application$/i.test(op || u.pathname) })
    return route.abort()
  })
  try {
    await page.addInitScript(stubExtension, ANSWERS)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(2500)
    for (const file of scripts) await page.addScriptTag({ content: readFileSync(join(EXT, file), 'utf8') })
    filling = true
    const result = await page.evaluate((resume) => new Promise((resolve) => window.__landedOnMessage({ action: 'fill', resume }, {}, resolve)), APPLICANT)
    await page.waitForTimeout(800)
    const seen = await page.evaluate(audit)
    return { url, ...seen, submits: seen.submits + blocked.filter((b) => b.submit).length, blocked, lost: result.lost || [], optional: (result.optional_blank || []).length, blocker: result.blocker || null }
  } catch (error) {
    return { url, error: String(error.message || error).split('\n')[0] }
  } finally {
    await context.close()
  }
}

const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (await Promise.all(BOARDS.map((b) => postingFrom(b).catch(() => null)))).filter(Boolean)
const browser = await chromium.launch({ channel: 'chrome' })
let bad = 0
for (const url of urls) {
  const r = await check(browser, url)
  if (r.error) { console.log(`?  ${url}\n   couldn't check: ${r.error}`); continue }
  if (!r.isForm) { console.log(`-  ${url}\n   not an application page (no form found): skipped`); continue }
  // A fill that stopped (sign-in, CAPTCHA) or filled nothing proves nothing.
  if (r.blocker || r.green + r.yellow === 0) {
    bad++
    console.log(`✗  ${url}\n   filled nothing${r.blocker ? `: stopped as ${r.blocker.kind} (${r.blocker.message || ''})` : ''}`)
    continue
  }
  const ok = r.greenEmpty.length === 0 && r.submits === 0
  if (!ok) bad++
  console.log(`${ok ? '✓' : '✗'}  ${url}`)
  console.log(`   ${r.green} green · ${r.yellow} yellow · ${r.optional} optional left blank · ${r.submits} submits`)
  const writes = [...new Set(r.blocked.map((b) => `${b.submit ? 'SUBMIT ' : ''}${b.what}`))]
  if (writes.length) console.log(`   blocked writes after the fill started: ${writes.join('; ')}`)
  if (r.lost.length) console.log(`   didn't keep their value (now yellow): ${r.lost.join('; ')}`)
  if (r.greenEmpty.length) console.log(`   GREEN BUT EMPTY: ${r.greenEmpty.join('; ')}`)
}
await browser.close()
process.exit(bad ? 1 : 0)
