// Runtime config, read once from the environment (`.env` next to package.json
// is loaded by the npm scripts via --env-file-if-exists).
import { fileURLToPath } from 'node:url'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} must be set (see apps/server/.env.example)`)
  return v
}

export type Config = {
  databaseUrl: string
  host: string
  port: number
  // 32-byte key (base64) for AES-256-GCM over ai_provider_keys secrets.
  secretsKey: Buffer
  // Mark the session cookie Secure. True in production behind Cloudflare
  // Tunnel (browser sees https); false for plain-http local dev.
  cookieSecure: boolean
  // 'open': anyone can sign up. 'first-only': only while the users table is
  // empty, so a public deployment can't be signed up to by strangers.
  signup: 'open' | 'first-only'
  // Built web app to serve at /. Null disables static serving (dev uses Vite).
  webDist: string | null
}

export function loadConfig(): Config {
  const secretsKey = Buffer.from(required('SECRETS_KEY'), 'base64')
  if (secretsKey.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64-encoded')
  const signup = process.env.SIGNUP ?? 'first-only'
  if (signup !== 'open' && signup !== 'first-only') throw new Error('SIGNUP must be open | first-only')
  return {
    databaseUrl: required('DATABASE_URL'),
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 8787),
    secretsKey,
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    signup,
    webDist: process.env.WEB_DIST === ''
      ? null
      : (process.env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url))),
  }
}
