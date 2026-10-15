import nodemailer from 'nodemailer'
import type { CloudflareEmailConfig, EmailConfig, SmtpEmailConfig } from './config.ts'

export type PasswordResetEmail = {
  to: string
  resetUrl: string
  expiresInMinutes: number
}

export type PasswordResetSender = (message: PasswordResetEmail) => Promise<void>

type CloudflareSendResponse = {
  success?: boolean
  errors?: { message?: string }[]
  result?: { delivered?: string[]; queued?: string[]; permanent_bounces?: string[] } | null
}

const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function passwordResetContent(resetUrl: string, expiresInMinutes: number) {
  const subject = 'Reset your Landed password'
  const text = [
    'Reset your Landed password',
    '',
    `Open this link to choose a new password: ${resetUrl}`,
    '',
    `This link expires in ${expiresInMinutes} minutes and can only be used once.`,
    'If you did not request this, you can ignore this email.',
  ].join('\n')
  const safeUrl = escapeHtml(resetUrl)
  const html = `<!doctype html>
<html><body style="margin:0;background:#f6f6f4;color:#20201e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px">
    <div style="font-size:18px;font-weight:700;margin-bottom:24px">Landed<span style="color:#e35243">.</span></div>
    <div style="background:#fff;border:1px solid #e5e4df;border-radius:12px;padding:28px">
      <h1 style="font-size:22px;line-height:1.25;margin:0 0 12px">Reset your password</h1>
      <p style="font-size:14px;line-height:1.6;margin:0 0 22px;color:#5c5b56">Use the button below to choose a new Landed password.</p>
      <a href="${safeUrl}" style="display:inline-block;background:#3f46c8;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 16px;border-radius:8px">Reset password</a>
      <p style="font-size:12px;line-height:1.6;margin:22px 0 0;color:#77756e">This link expires in ${expiresInMinutes} minutes and works once. If you did not request it, you can ignore this email.</p>
    </div>
  </div>
</body></html>`
  return { subject, text, html }
}

/** Cloudflare Email Sending REST client for the Node server on the Mac mini. */
export function cloudflarePasswordResetSender(config: CloudflareEmailConfig): PasswordResetSender {
  return async ({ to, resetUrl, expiresInMinutes }) => {
    const { subject, text, html } = passwordResetContent(resetUrl, expiresInMinutes)

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/email/sending/send`
    let lastError = 'email delivery failed'
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to,
          from: { address: config.fromAddress, name: config.fromName },
          subject,
          text,
          html,
        }),
      })
      const payload = await response.json().catch(() => null) as CloudflareSendResponse | null
      const bounced = payload?.result?.permanent_bounces ?? []
      if (response.ok && payload?.success === true && bounced.length === 0) return
      lastError = payload?.errors?.map((error) => error.message).filter(Boolean).join('; ')
        || (bounced.length ? 'recipient permanently bounced' : `email service returned ${response.status}`)
      if (response.status !== 429 && response.status < 500) break
      if (attempt < 2) await wait(250 * (2 ** attempt))
    }
    throw new Error(lastError)
  }
}

type MailTransport = {
  sendMail(message: {
    from: { address: string; name: string }
    to: string
    subject: string
    text: string
    html: string
  }): Promise<unknown>
}

/** Standards-based SMTP sender: works with a local relay or any mail host. */
export function smtpPasswordResetSender(config: SmtpEmailConfig, injectedTransport?: MailTransport): PasswordResetSender {
  const transport = injectedTransport ?? nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
  })
  return async ({ to, resetUrl, expiresInMinutes }) => {
    const content = passwordResetContent(resetUrl, expiresInMinutes)
    await transport.sendMail({
      from: { address: config.fromAddress, name: config.fromName },
      to,
      ...content,
    })
  }
}

export function createPasswordResetSender(config: EmailConfig): PasswordResetSender {
  return config.provider === 'smtp'
    ? smtpPasswordResetSender(config)
    : cloudflarePasswordResetSender(config)
}
