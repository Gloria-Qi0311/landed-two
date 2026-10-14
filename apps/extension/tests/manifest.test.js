const fs = require('fs')
const path = require('path')
const nodeCrypto = require('crypto')

test('manifest keeps the Native Messaging extension identity stable', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'manifest.json'), 'utf8'))
  const publicKey = Buffer.from(manifest.key, 'base64')
  const hex = nodeCrypto.createHash('sha256').update(publicKey).digest().subarray(0, 16).toString('hex')
  const id = [...hex].map((digit) => 'abcdefghijklmnop'[parseInt(digit, 16)]).join('')
  expect(id).toBe('cffgejoffofpdgncoebljpidlmmmiigb')
  expect(manifest.permissions).toEqual(expect.arrayContaining(['tabs', 'nativeMessaging']))
})
