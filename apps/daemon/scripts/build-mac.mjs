#!/usr/bin/env node
// Builds Landed.app for macOS: the daemon bundled into one file, inside a
// small AppleScript applet that owns the landed:// URL scheme.
//
//   open Landed.app            → `landed-daemon.mjs setup` (background service)
//   landed://connect?…  (from Landed's "Connect this computer")
//                              → `landed-daemon.mjs open-url <url>` (asks first)
//
// Output: dist/Landed.app and dist/Landed-mac.zip (served by the Landed server
// at /api/downloads/landed-mac.zip). Needs macOS (osacompile, codesign).
//
//   node scripts/build-mac.mjs            # build
//   node scripts/build-mac.mjs --install  # …and copy to ~/Applications (this Mac)
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(root, '..', '..')
const dist = join(root, 'dist')
const app = join(dist, 'Landed.app')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
const infoPlist = () => join(app, 'Contents', 'Info.plist')
const plist = (...args) => run('/usr/libexec/PlistBuddy', ['-c', args.join(' '), infoPlist()])
/** Set a top-level key, whether or not osacompile wrote it. */
const plistPut = (key, type, value) => {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, infoPlist()], { stdio: 'ignore' })
  } catch {
    // wasn't there
  }
  plist('Add', `:${key}`, type, ...(value === undefined ? [] : [value]))
}

if (process.platform !== 'darwin') {
  console.error('Landed.app can only be built on macOS.')
  process.exit(1)
}

// The Chrome extension is shipped inside Landed.app. Chrome still requires
// one explicit "Load unpacked" / Web Store install, but the local model host
// and the matching extension version now arrive in one download.
execFileSync('pnpm', ['--filter', '@landed/extension', 'build'], { cwd: repo, stdio: 'inherit' })
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

// 1. The daemon, bundled: plain JavaScript, any Node 20+.
const bundle = await rolldown({ input: join(root, 'src', 'cli.ts'), platform: 'node', logLevel: 'warn' })
await bundle.write({ file: join(dist, 'landed-daemon.mjs'), format: 'esm' })

// 2. The applet. It finds Node through a login shell (plus the usual places)
//    and hands everything to the daemon.
const script = `
on run
  landed("setup")
end run

on open location theURL
  landed("open-url " & quoted form of theURL)
end open location

on landed(args)
  set daemonJS to POSIX path of (path to me) & "Contents/Resources/landed-daemon.mjs"
  set cmd to "export PATH=\\"$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin\\"; node " & quoted form of daemonJS & " " & args
  try
    do shell script "/bin/zsh -lc " & quoted form of cmd
  on error errMsg
    if errMsg contains "command not found: node" then
      display dialog "Landed needs Node.js (version 20 or newer). Install it from nodejs.org, then open Landed again." buttons {"OK"} default button "OK" with title "Landed" with icon caution
    else
      display dialog errMsg buttons {"OK"} default button "OK" with title "Landed" with icon caution
    end if
  end try
end landed
`
const source = join(tmpdir(), `landed-applet-${process.pid}.applescript`)
writeFileSync(source, script)
run('osacompile', ['-o', app, source])
rmSync(source)

// 3. Identity + the landed:// scheme; no Dock icon while it works.
plistPut('CFBundleIdentifier', 'string', 'dev.landed.connector')
plistPut('CFBundleName', 'string', 'Landed')
plistPut('CFBundleShortVersionString', 'string', version)
plistPut('CFBundleVersion', 'string', version)
plistPut('LSUIElement', 'bool', 'true')
plistPut('CFBundleURLTypes', 'array')
plist('Add', ':CFBundleURLTypes:0', 'dict')
plist('Add', ':CFBundleURLTypes:0:CFBundleURLName', 'string', 'Landed')
plist('Add', ':CFBundleURLTypes:0:CFBundleURLSchemes', 'array')
plist('Add', ':CFBundleURLTypes:0:CFBundleURLSchemes:0', 'string', 'landed')
copyFileSync(join(dist, 'landed-daemon.mjs'), join(app, 'Contents', 'Resources', 'landed-daemon.mjs'))
const extension = join(repo, 'apps', 'extension', 'dist')
if (!existsSync(extension)) throw new Error('extension build did not produce apps/extension/dist')
cpSync(extension, join(app, 'Contents', 'Resources', 'extension'), { recursive: true })

// 4. Editing Info.plist breaks the applet's signature: sign it again (ad hoc).
run('codesign', ['--force', '--deep', '--sign', '-', app])
run('ditto', ['-c', '-k', '--keepParent', app, join(dist, 'Landed-mac.zip')])
console.log(`built ${app} and ${join(dist, 'Landed-mac.zip')}`)

if (process.argv.includes('--install')) {
  const target = join(homedir(), 'Applications', 'Landed.app')
  mkdirSync(dirname(target), { recursive: true })
  rmSync(target, { recursive: true, force: true })
  cpSync(app, target, { recursive: true })
  run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', target])
  console.log(`installed ${target}`)
}
