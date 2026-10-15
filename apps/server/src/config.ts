// Runtime config, read once from the environment (`.env` next to package.json
// is loaded by the npm scripts via --env-file-if-exists).
import { fileURLToPath } from 'node:url'

type EmailSender = {
  fromAddress: string
  fromName: string
}

export type CloudflareEmailConfig = EmailSender & {
  provider: 'cloudflare'
  accountId: string
  apiToken: string
}

export type SmtpEmailConfig = EmailSender & {
  provider: 'smtp'
  host: string
  port: number
  secure: boolean
  user?: string
  password?: string
}

export type EmailConfig = CloudflareEmailConfig | SmtpEmailConfig

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
  // The public origin (e.g. https://landed.example.com) for OAuth/MCP
  // metadata and password-reset links. Unset: taken from each request.
  publicUrl?: string | null
  // Transactional mail. Null keeps password recovery explicitly unavailable.
  email?: EmailConfig | null
}

function emailConfig(): EmailConfig | null {
  const transport = process.env.EMAIL_TRANSPORT?.trim().toLowerCase() ?? ''
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? ''
  const apiToken = process.env.CLOUDFLARE_EMAIL_API_TOKEN?.trim() ?? ''
  const smtpHost = process.env.SMTP_HOST?.trim() ?? ''
  const smtpUser = process.env.SMTP_USER?.trim() ?? ''
  const smtpPassword = process.env.SMTP_PASS ?? ''
  const fromAddress = process.env.EMAIL_FROM?.trim() ?? ''
  const anyEmailSetting = [transport, accountId, apiToken, smtpHost, smtpUser, smtpPassword, fromAddress].some(Boolean)
  if (!anyEmailSetting) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddress)) throw new Error('EMAIL_FROM must be a valid email address')
  const fromName = process.env.EMAIL_FROM_NAME?.trim() || 'Landed'

  const inferred = transport || (smtpHost ? 'smtp' : accountId || apiToken ? 'cloudflare' : '')
  if (inferred === 'cloudflare') {
    if (!accountId || !apiToken) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_API_TOKEN must be set for EMAIL_TRANSPORT=cloudflare')
    }
    return { provider: 'cloudflare', accountId, apiToken, fromAddress, fromName }
  }
  if (inferred === 'smtp') {
    if (!smtpHost) throw new Error('SMTP_HOST must be set for EMAIL_TRANSPORT=smtp')
    if (!!smtpUser !== !!smtpPassword) throw new Error('SMTP_USER and SMTP_PASS must be set together')
    const port = Number(process.env.SMTP_PORT ?? 587)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be an integer from 1 to 65535')
    const secureRaw = process.env.SMTP_SECURE?.trim().toLowerCase()
    if (secureRaw && secureRaw !== 'true' && secureRaw !== 'false') throw new Error('SMTP_SECURE must be true or false')
    return {
      provider: 'smtp', host: smtpHost, port,
      secure: secureRaw ? secureRaw === 'true' : port === 465,
      user: smtpUser || undefined, password: smtpPassword || undefined,
      fromAddress, fromName,
    }
  }
  throw new Error('EMAIL_TRANSPORT must be smtp or cloudflare')
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
    publicUrl: process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : null,
    email: emailConfig(),
    webDist: process.env.WEB_DIST === ''
      ? null
      : (process.env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url))),
  }
}
