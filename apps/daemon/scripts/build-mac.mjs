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

// Finder and download icon. Keep the source as SVG so every generated ICNS
// size uses the same Landed L + arrival-dot geometry as the product UI.
const iconSource = join(root, 'macos', 'LandedAppIcon.svg')
const iconPng = join(dist, 'LandedAppIcon.png')
const iconset = join(dist, 'Landed.iconset')
run('sips', ['-s', 'format', 'png', iconSource, '--out', iconPng])
mkdirSync(iconset, { recursive: true })
for (const [size, name] of [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
]) {
  run('sips', ['-z', String(size), String(size), iconPng, '--out', join(iconset, name)])
}
run('iconutil', ['-c', 'icns', iconset, '-o', join(app, 'Contents', 'Resources', 'Landed.icns')])
rmSync(iconset, { recursive: true, force: true })
rmSync(iconPng, { force: true })

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
  '-framework', 'AppKit', '-framework', 'SwiftUI', '-framework', 'SafariServices', '-framework', 'ServiceManagement',
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
  <key>CFBundleIconFile</key><string>Landed.icns</string>
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

// 4. When full Xcode is present, convert the shared MV3 resources into a
// Safari Web Extension and embed its .appex. Build hosts without Xcode (the
// headless Mac mini) still build the Chromium-capable app; deploy.sh replaces
// its download zip with the full local build afterwards.
const xcodeDeveloper = '/Applications/Xcode.app/Contents/Developer'
const safariConverter = join(xcodeDeveloper, 'usr', 'bin', 'safari-web-extension-converter')
if (existsSync(safariConverter)) {
  const safariSource = join(dist, 'safari-extension-source')
  const safariProjectRoot = join(dist, 'safari-project')
  const safariDerived = join(dist, 'safari-derived')
  cpSync(extension, safariSource, { recursive: true })
  const safariManifestPath = join(safariSource, 'manifest.json')
  const safariManifest = JSON.parse(readFileSync(safariManifestPath, 'utf8'))
  delete safariManifest.key
  delete safariManifest.side_panel
  safariManifest.permissions = safariManifest.permissions.filter((permission) => permission !== 'sidePanel')
  safariManifest.action = { ...safariManifest.action, default_popup: 'popup/index.html' }
  writeFileSync(safariManifestPath, `${JSON.stringify(safariManifest, null, 2)}\n`)

  const xcodeEnv = { ...process.env, DEVELOPER_DIR: xcodeDeveloper }
  execFileSync(safariConverter, [
    safariSource,
    '--project-location', safariProjectRoot,
    '--app-name', 'Landed',
    '--bundle-identifier', 'dev.landed.connector',
    '--swift', '--macos-only', '--copy-resources', '--no-open', '--no-prompt',
  ], { stdio: 'inherit', env: xcodeEnv })
  const generated = join(safariProjectRoot, 'Landed')
  const projectFile = join(generated, 'Landed.xcodeproj', 'project.pbxproj')
  const project = readFileSync(projectFile, 'utf8')
    .replaceAll('dev.landed.connector.Extension', 'dev.landed.connector.SafariExtension')
    .replaceAll('dev.landed.Landed', 'dev.landed.connector')
    .replace(/MACOSX_DEPLOYMENT_TARGET = [^;]+;/g, 'MACOSX_DEPLOYMENT_TARGET = 13.0;')
  writeFileSync(projectFile, project)
  copyFileSync(
    join(root, 'macos', 'SafariWebExtensionHandler.swift'),
    join(generated, 'Landed Extension', 'SafariWebExtensionHandler.swift'),
  )
  execFileSync(join(xcodeDeveloper, 'usr', 'bin', 'xcodebuild'), [
    '-project', join(generated, 'Landed.xcodeproj'),
    '-scheme', 'Landed',
    '-configuration', 'Release',
    '-derivedDataPath', safariDerived,
    'CODE_SIGN_STYLE=Manual', 'CODE_SIGN_IDENTITY=-', 'DEVELOPMENT_TEAM=',
    `MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${version.replace(/\D/g, '')}`,
    `CODE_SIGN_ENTITLEMENTS=${join(root, 'macos', 'LandedSafariExtension.entitlements')}`,
    'build',
  ], { stdio: 'inherit', env: xcodeEnv })
  const plugins = join(app, 'Contents', 'PlugIns')
  mkdirSync(plugins, { recursive: true })
  cpSync(
    join(safariDerived, 'Build', 'Products', 'Release', 'Landed Extension.appex'),
    join(plugins, 'Landed Safari Extension.appex'),
    { recursive: true },
  )
  rmSync(safariSource, { recursive: true, force: true })
  rmSync(safariProjectRoot, { recursive: true, force: true })
  rmSync(safariDerived, { recursive: true, force: true })
} else {
  console.warn('Full Xcode not found; building without the embedded Safari extension.')
}

// 5. Ad-hoc signing is enough for a local build; distribution can replace it
// with Developer ID signing + notarization later. Sign the nested extension
// explicitly so a recursive parent signature cannot discard its sandboxed
// loopback-network entitlement.
const embeddedSafari = join(app, 'Contents', 'PlugIns', 'Landed Safari Extension.appex')
if (existsSync(embeddedSafari)) {
  run('codesign', [
    '--force', '--sign', '-', '--options', 'runtime',
    '--entitlements', join(root, 'macos', 'LandedSafariExtension.entitlements'),
    embeddedSafari,
  ])
}
run('codesign', ['--force', '--sign', '-', app])
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
