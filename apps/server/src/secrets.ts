// AES-256-GCM for ai_provider_keys.secret_ciphertext (replaces Supabase Vault).
// Format: base64(iv[12] | tag[16] | ciphertext).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
}

export function decryptSecret(key: Buffer, encoded: string): string {
  const buf = Buffer.from(encoded, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
  decipher.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
}
