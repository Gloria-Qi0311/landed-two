// Print a 6-digit OTP code for a given email, bypassing email delivery.
// Useful during dev when Supabase shared SMTP rate-limits or your inbox eats
// the email. Uses the admin API (service_role) to generate the same OTP that
// would have been emailed.
//
// Usage:
//   node scripts/dev-otp.js you@example.com
//
// Or as a pnpm script (already wired):
//   pnpm dev:otp you@example.com
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from root .env.local.
// service_role bypasses RLS and can mint OTPs for any email — DEV ONLY.
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

async function loadEnv() {
  const text = await readFile(resolve(REPO_ROOT, '.env.local'), 'utf8');
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/dev-otp.js <email>');
    process.exit(1);
  }

  const env = await loadEnv();
  const url = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });

  if (error) {
    console.error('generateLink failed:', error.message);
    process.exit(1);
  }

  const code = data?.properties?.email_otp;
  if (!code) {
    console.error('No OTP returned — full response:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(`\n  ${email}`);
  console.log(`  OTP code: \x1b[1;32m${code}\x1b[0m`);
  console.log(`\n  Paste this into the Landed login screen. Expires in ~1 hour.\n`);
}

main().catch((e) => {
  console.error('dev-otp.js failed:', e);
  process.exit(1);
});
