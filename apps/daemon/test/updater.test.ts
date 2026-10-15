import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { checkForUpdate, isNewer, parseManifest, signatureValid, signedText, type Manifest } from '../src/updater.ts'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'landed-update-'))
  roots.push(dir)
  return dir
}

const release = generateKeyPairSync('ed25519')
const publicKey = release.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const stranger = generateKeyPairSync('ed25519')

/** A Landed.app with a build id, zipped the way build-mac.mjs does. */
function publish(build: string, key = release.privateKey) {
  const dir = tmp()
  const app = join(dir, 'Landed.app')
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'Resources', 'build.json'), JSON.stringify({ version: '0.11.0', build }))
  writeFileSync(join(app, 'Contents', 'Resources', 'landed-daemon.mjs'), `// ${build}`)
  const zipPath = join(dir, 'Landed-mac.zip')
  execFileSync('ditto', ['-c', '-k', '--keepParent', app, zipPath])
  const zip = readFileSync(zipPath)
  const m = { version: '0.11.0', build, sha256: createHash('sha256').update(zip).digest('hex'), size: zip.length }
  const manifest: Manifest = { ...m, signature: sign(null, Buffer.from(signedText(m)), key).toString('base64') }
  return { zip, manifest }
}

function server(release: { zip: Buffer; manifest: unknown }, calls: string[] = []) {
  return (async (url: string) => {
    calls.push(String(url))
    if (String(url).endsWith('.json')) return new Response(JSON.stringify(release.manifest), { status: 200 })
    return new Response(new Uint8Array(release.zip), { status: 200 })
  }) as unknown as typeof fetch
}

function installedApp() {
  const dir = tmp()
  const target = join(dir, 'Applications', 'Landed.app')
  mkdirSync(join(target, 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(target, 'Contents', 'Resources', 'build.json'), JSON.stringify({ build: '20261015T080000Z-aaaaaaa' }))
  return { dir, target }
}

test('build ids order by time; manifests are validated', () => {
  assert.equal(isNewer('20261015T090000Z-bbbbbbb', '20261015T080000Z-aaaaaaa'), true)
  assert.equal(isNewer('20261015T080000Z-ccccccc', '20261015T080000Z-aaaaaaa'), false, 'same time, other commit: no downgrade loop')
  assert.equal(isNewer('20261014T235959Z-ddddddd', '20261015T080000Z-aaaaaaa'), false)
  assert.equal(parseManifest({ build: 'latest', sha256: 'x', size: 1, signature: 's' }), null)
  const { manifest } = publish('20261015T090000Z-bbbbbbb')
  assert.deepEqual(parseManifest(manifest), manifest)
  assert.equal(signatureValid(manifest, publicKey), true)
  assert.equal(signatureValid({ ...manifest, size: manifest.size + 1 }, publicKey), false)
})

test('a newer signed build replaces the app and relaunches it', async () => {
  const { dir, target } = installedApp()
  const steps: string[] = []
  const result = await checkForUpdate('https://landed.example/', { build: '20261015T080000Z-aaaaaaa', publicKey, dir }, {
    fetch: server(publish('20261015T090000Z-bbbbbbb')), log: () => {}, workDir: join(dir, 'updates'), target: () => target,
    quitApp: () => steps.push('quit'), register: (app) => steps.push(`register ${app}`), relaunch: (app) => steps.push(`open ${app}`),
    notify: (m) => steps.push(m),
  })
  assert.equal(result, 'updated')
  assert.equal(JSON.parse(readFileSync(join(target, 'Contents', 'Resources', 'build.json'), 'utf8')).build, '20261015T090000Z-bbbbbbb')
  assert.deepEqual(steps, ['quit', `register ${target}`, 'Landed updated to 0.11.0', `open ${target}`])
  assert.equal(existsSync(`${target}.old`), false)
  assert.equal(existsSync(join(dir, 'updates', '20261015T090000Z-bbbbbbb')), false, 'work files cleaned up')
})

test('not signed with this install\'s key, tampered, or not newer: nothing is installed', async () => {
  const { dir, target } = installedApp()
  const installed = { build: '20261015T080000Z-aaaaaaa', publicKey, dir }
  const never = { quitApp: () => assert.fail('quit'), relaunch: () => assert.fail('relaunch'), register: () => assert.fail('register'), notify: () => {} }
  const base = { log: () => {}, workDir: join(dir, 'updates'), target: () => target, ...never }

  const forged = publish('20261015T090000Z-bbbbbbb', stranger.privateKey)
  assert.equal(await checkForUpdate('https://landed.example', installed, { ...base, fetch: server(forged) }), 'bad-signature')

  const real = publish('20261015T090000Z-bbbbbbb')
  const tampered = { ...real, zip: Buffer.concat([real.zip, Buffer.from('x')]) }
  assert.equal(await checkForUpdate('https://landed.example', installed, { ...base, fetch: server(tampered) }), 'bad-download')

  const calls: string[] = []
  assert.equal(await checkForUpdate('https://landed.example', { ...installed, build: '20261015T090000Z-bbbbbbb' }, { ...base, fetch: server(real, calls) }), 'up-to-date')
  assert.deepEqual(calls, ['https://landed.example/api/downloads/landed-mac.json'], 'no download when up to date')

  const missing = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
  assert.equal(await checkForUpdate('https://landed.example', installed, { ...base, fetch: missing }), 'no-release')
  assert.equal(JSON.parse(readFileSync(join(target, 'Contents', 'Resources', 'build.json'), 'utf8')).build, '20261015T080000Z-aaaaaaa')
})
