#!/usr/bin/env node
// Builds Landed.app for macOS: a native SwiftUI menu-bar app plus the daemon
// and browser bridge. The app owns landed:// and installs the background
// service, while Apply Assist stays available from the menu bar.
//
// Output: dist/Landed.app and dist/Landed-mac.zip (served by the Landed server
// at /api/downloads/landed-mac.zip). Needs macOS (swiftc, codesign).
//
//   node scripts/build-mac.mjs            # build
//   node scripts/build-mac.mjs --install  # …and copy to ~/Applications
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(root, '..', '..')
const dist = join(root, 'dist')
const app = join(dist, 'Landed.app')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })

if (process.platform !== 'darwin') {
  console.error('Landed.app can only be built on macOS.')
  process.exit(1)
}

// The browser bridge is shipped inside Landed.app. Chromium browsers still
// require one explicit Load unpacked / Web Store install.
execFileSync('pnpm', ['--filter', '@landed/extension', 'build'], { cwd: repo, stdio: 'inherit' })
rmSync(dist, { recursive: true, force: true })
mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })

// 1. Bundle the Node daemon into one file.
const bundle = await rolldown({ input: join(root, 'src', 'cli.ts'), platform: 'node', logLevel: 'warn' })
await bundle.write({ file: join(dist, 'landed-daemon.mjs'), format: 'esm' })

// 2. Compile the native menu-bar UI against system frameworks. No Xcode
// project or third-party desktop runtime is needed.
const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`
run('xcrun', [
  'swiftc', '-parse-as-library', '-target', target,
  join(root, 'macos', 'LandedMenuBar.swift'),
  '-o', join(app, 'Contents', 'MacOS', 'Landed'),
  '-framework', 'AppKit', '-framework', 'SwiftUI', '-framework', 'ServiceManagement',
])

writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>Landed</string>
  <key>CFBundleIdentifier</key><string>dev.landed.connector</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Landed</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>Landed</string>
    <key>CFBundleURLSchemes</key><array><string>landed</string></array>
  </dict></array>
</dict></plist>
`)

// 3. Bundle the daemon and matching browser bridge.
copyFileSync(join(dist, 'landed-daemon.mjs'), join(app, 'Contents', 'Resources', 'landed-daemon.mjs'))
const extension = join(repo, 'apps', 'extension', 'dist')
if (!existsSync(extension)) throw new Error('extension build did not produce apps/extension/dist')
cpSync(extension, join(app, 'Contents', 'Resources', 'extension'), { recursive: true })

// 4. Ad-hoc signing is enough for a local build; distribution can replace it
// with Developer ID signing + notarization later.
run('codesign', ['--force', '--deep', '--sign', '-', app])
run('ditto', ['-c', '-k', '--keepParent', app, join(dist, 'Landed-mac.zip')])
console.log(`built ${app} and ${join(dist, 'Landed-mac.zip')}`)

if (process.argv.includes('--install')) {
  const targetApp = join(homedir(), 'Applications', 'Landed.app')
  mkdirSync(dirname(targetApp), { recursive: true })
  rmSync(targetApp, { recursive: true, force: true })
  cpSync(app, targetApp, { recursive: true })
  run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', targetApp])
  console.log(`installed ${targetApp}`)
}
