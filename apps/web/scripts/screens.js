// Capture viewport screenshots of every key route + a few "preview=empty" variants.
// Run via `pnpm --filter @landed/web run screens` (or root `pnpm screens`) AFTER
// `pnpm --filter @landed/web dev` is already running on http://localhost:5173.
//
// Output: /screenshots/<name>.png at repo root.
//
// In a future CI pass, swap chromium.launch() for the playwright test runner with
// a webServer config so this is one command end-to-end. Skipped for now to avoid
// the extra config surface area.
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const OUT_DIR = resolve(REPO_ROOT, 'screenshots');
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

// Screens captured under an authenticated context (signedIn + onboarded set
// before any SPA script runs, via addInitScript).
const SCREENS_AUTH = [
  { name: '01-applications-kanban',   url: '/applications' },
  { name: '02-applications-table',    url: '/applications?view=table' },
  { name: '03-applications-timeline', url: '/applications?view=timeline' },
  { name: '04-applications-cards',    url: '/applications?view=cards' },
  { name: '05-applications-map',      url: '/applications?view=map' },
  { name: '06-sync',          url: '/sync' },
  { name: '07-resume-match',  url: '/resume-match' },
  { name: '08-jd-breakdown',  url: '/jd-breakdown' },
  { name: '09-resumes',       url: '/resumes' },
  // Empty-state previews (via ?preview=empty URL param)
  { name: '10-applications-empty', url: '/applications?preview=empty' },
  { name: '11-sync-empty',         url: '/sync?preview=empty' },
  { name: '12-resume-match-empty', url: '/resume-match?preview=empty' },
  { name: '13-jd-breakdown-empty', url: '/jd-breakdown?preview=empty' },
];

async function snap(page, name, url) {
  await page.goto(BASE_URL + url);
  await page.waitForLoadState('networkidle');
  // Give the UI a beat to settle (animations, font swap, etc.)
  await page.waitForTimeout(300);
  const outPath = resolve(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: outPath, fullPage: false });
  console.log(`✓ ${name.padEnd(28)} → screenshots/${name}.png`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  // ──────────────────────────────────────────────────────────────────────
  // Context 1: NO auth — captures login screen
  // ──────────────────────────────────────────────────────────────────────
  const loginCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const loginPage = await loginCtx.newPage();
  await snap(loginPage, '00-login', '/applications');
  await loginCtx.close();

  // ──────────────────────────────────────────────────────────────────────
  // Context 2: signed in + onboarded — captures everything else
  //
  // addInitScript runs in every new document context BEFORE any SPA script,
  // which means React's useState init (which reads localStorage) sees the
  // values we want. Without this, the first useState call snapshots stale
  // localStorage and React stays signed-out even after a setItem.
  // ──────────────────────────────────────────────────────────────────────
  const authCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  await authCtx.addInitScript(() => {
    localStorage.setItem('landed:signedIn', 'true');
    localStorage.setItem('landed:onboarded_at', new Date().toISOString());
  });
  const authPage = await authCtx.newPage();
  for (const screen of SCREENS_AUTH) {
    await snap(authPage, screen.name, screen.url);
  }
  await authCtx.close();

  await browser.close();
  console.log(`\nCaptured ${1 + SCREENS_AUTH.length} screens to ${OUT_DIR}`);
}

main().catch((e) => {
  console.error('screens.js failed:', e);
  process.exit(1);
});
