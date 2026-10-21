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

/** @returns {{ kind: 'login' | 'account' | 'captcha', message: string } | null} */
function detectApplyBlocker() {
  const captcha = visible([
    'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="challenges.cloudflare.com"]',
    '.g-recaptcha', '.h-captcha', '.cf-turnstile', '[data-sitekey]',
    'input[name*="captcha" i]', 'input[id*="captcha" i]',
  ].join(','));
  const text = pageText();
  const challengePage = /\b(captcha|verify (?:that )?you(?:'re| are) human|security check)\b|人机验证|验证码/i.test(text)
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
