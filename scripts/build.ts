// Builds the extension into dist/firefox and dist/chrome.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

// The version is the build's UTC time: YYYY.M.D.HHMMSS, e.g. 2026.11.10.183412 (18:34:12).
// Firefox only takes up to four dot-separated numbers without leading zeros, so 09:05:00 is 90500.
// A release passes its tag's version in FIREDIAL_VERSION, so the tag and the build agree.
function calver(now: Date): string {
  const time = now.getUTCHours() * 10_000 + now.getUTCMinutes() * 100 + now.getUTCSeconds()
  return [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate(), time].join('.')
}

// Chrome takes numbers up to 65535 only: the time without seconds, 183412 is 1834. The full
// version is the version_name, which FireDial shows.
function chromeVersion(version: string): string {
  const parts = version.split('.').map(Number)
  if (parts.length === 4) parts[3] = Math.floor((parts[3] ?? 0) / 100)
  if (parts.some((part) => part > 65_535)) throw new Error(`Not a Chrome version: ${version}`)
  return parts.join('.')
}

const version = process.env['FIREDIAL_VERSION'] || calver(new Date())
if (!/^(0|[1-9]\d{0,8})(\.(0|[1-9]\d{0,8})){0,3}$/.test(version)) throw new Error(`Not a Firefox version: ${version}`)

interface Target {
  browser: 'firefox' | 'chrome'
  esbuild: string
  icons: string
  version: Record<string, string>
}

const targets: Target[] = [
  { browser: 'firefox', esbuild: 'firefox142', icons: 'browsers/icons', version: { version } },
  { browser: 'chrome', esbuild: 'chrome134', icons: 'browsers/chrome/icons', version: { version: chromeVersion(version), version_name: version } }
]

rmSync('dist', { recursive: true, force: true })

// FireDial's license, then those of what it bundles: zod in js/, the Onest font in fonts/.
const license = (title: string, file: string): string => `${title}\n\n${readFileSync(file, 'utf8').trimEnd()}\n`
const licenses = [license('FireDial', 'LICENSE'), license('zod', 'node_modules/zod/LICENSE'), license('Onest font', 'src/fonts/OFL.txt')].join('\n\n')

for (const target of targets) {
  const out = `dist/${target.browser}`
  await build({
    entryPoints: ['src/background.ts', 'src/newtab.ts', 'src/theme.ts'],
    outdir: `${out}/js`,
    bundle: true,
    format: 'esm',
    target: target.esbuild
  })
  const file = `browsers/${target.browser}/manifest.json`
  const manifest: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null) throw new Error(`${file} is not an object`)
  mkdirSync(out, { recursive: true })
  writeFileSync(
    `${out}/manifest.json`,
    `${JSON.stringify({ ...manifest, ...target.version }, null, 4)}
`
  )
  cpSync(target.icons, `${out}/icons`, { recursive: true })
  cpSync('src/newtab.html', `${out}/newtab.html`)
  cpSync('src/newtab.css', `${out}/newtab.css`)
  cpSync('src/defaults.json', `${out}/defaults.json`)
  cpSync('src/fonts', `${out}/fonts`, { recursive: true })
  writeFileSync(`${out}/LICENSES.txt`, licenses)
}
console.log(`FireDial ${version}`)
