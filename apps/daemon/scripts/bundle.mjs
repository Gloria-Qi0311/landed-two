// Bundles the Node daemon (src/cli.ts) into one ESM file for Landed.app.
// build-mac.mjs ships it; test/bundle.test.ts checks the bundle loads.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export async function bundleDaemon(file) {
  const bundle = await rolldown({
    input: join(root, 'src', 'cli.ts'),
    platform: 'node',
    logLevel: 'warn',
    // Prefer a package's ESM build. jsonc-parser's "main" is a UMD wrapper whose
    // require('./impl/format') the bundler leaves in place, so the bundle
    // crashed on load with "Cannot find module './impl/format'".
    resolve: { mainFields: ['module', 'main'] },
  })
  await bundle.write({ file, format: 'esm' })
  await bundle.close()
}
