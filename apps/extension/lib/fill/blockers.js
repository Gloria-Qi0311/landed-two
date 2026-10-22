// @ts-check
// lib/fill/blockers.js — human-only stops for Apply Assist. We recognize the
// three things #99 says Landed must never work around: signing in, creating an
// account, and a CAPTCHA. Detection happens before any field is filled.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { deepAll, isRendered } = F;

const visible = (selector) => deepAll(selector).filter((el) => isRendered(el));
const pageText = () => String(document.body?.innerText || document.body?.textContent || '')
  .replace(/\s+/g, ' ').trim().slice(0, 20_000);

const CAPTCHA = [
  'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="challenges.cloudflare.com"]',
  '.g-recaptcha', '.h-captcha', '.cf-turnstile', '[data-sitekey]',
  'input[name*="captcha" i]', 'input[id*="captcha" i]',
].join(',');

/** A CAPTCHA the person has to deal with now: on screen, with some size, not
 *  hidden. Lever, Greenhouse and Ashby embed invisible ones (a zero-height
 *  hCaptcha, Google's "size=invisible" badge in the corner, hidden challenge
 *  frames) that only act on submit; counting those stopped every fill there
 *  before a single field. */
function showsChallenge(el) {
  if (!isRendered(el)) return false;
  const src = el.getAttribute('src') || '';
  if (/[?&]size=invisible\b/.test(src) || el.getAttribute('data-size') === 'invisible' || el.closest('.grecaptcha-badge')) return false;
  for (let n = el, depth = 0; n && n.nodeType === 1 && depth < 10; n = n.parentElement, depth++) {
    const style = getComputedStyle(n);
    if (style.visibility === 'hidden' || style.display === 'none' || (style.opacity !== '' && Number(style.opacity) === 0)) return false;
  }
  const rect = (el.getClientRects && el.getClientRects()[0]) || el.getBoundingClientRect();
  return !!rect && rect.width > 0 && rect.height > 0;
}

/** @returns {{ kind: 'login' | 'account' | 'captcha', message: string } | null} */
function detectApplyBlocker() {
  const captcha = deepAll(CAPTCHA).filter(showsChallenge);
  const text = pageText();
  // A challenge page says so; the bare word "captcha" is often only a
  // "protected by hCaptcha" footer.
  const challengePage = /\b(verify (?:that )?you(?:'re| are) (?:a )?human|security check|are you a robot)\b|人机验证|验证码/i.test(text)
    && visible('input, iframe, [role="checkbox"], button').length > 0;
  if (captcha.length > 0 || challengePage) {
    return { kind: 'captcha', message: 'This page has a CAPTCHA. Complete it yourself; Landed will not bypass it.' };
  }

  const passwords = visible('input[type="password"]');
  if (passwords.length === 0) return null;
  const account = passwords.length > 1
    || /\b(create (?:an )?account|sign up|register|set (?:a )?password|join now)\b|创建账户|创建账号|注册/i.test(text);
  return account
    ? { kind: 'account', message: 'This application requires an account. Create it yourself, then Landed can continue filling.' }
    : { kind: 'login', message: 'This application requires you to sign in. Sign in yourself, then Landed can continue filling.' };
}

Object.assign(F, { detectApplyBlocker });
})(typeof window !== 'undefined' ? window : globalThis);
