import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsup'
import { getSessionEscrowAddress } from '../dist/config.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const expected = getSessionEscrowAddress()
const work = mkdtempSync(join(tmpdir(), 'tron-sdk-package-'))
const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work, '--cache', join(work, 'npm-cache')], { cwd: root, encoding: 'utf8' }))[0]
assert(!packed.files.some(({ path }) => /(^|\/)\.env(?:\.|$)/.test(path)), 'The npm package must not include .env files')
const consumer = join(work, 'consumer'), installed = join(consumer, 'node_modules', manifest.name)
mkdirSync(installed, { recursive: true })
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
execFileSync('tar', ['-xzf', join(work, packed.filename), '--strip-components=1', '-C', installed])
assert(!existsSync(join(installed, '.env')))
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
  const link = join(consumer, 'node_modules', name)
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(join(root, 'node_modules', name), link, 'junction')
}
const entry = join(consumer, 'check.mjs')
writeFileSync(entry, `
import assert from 'node:assert/strict'
import { getSessionEscrowAddress } from 'tron-mpp-sdk/config'
import { createConfiguredSession } from 'tron-mpp-sdk/session'
assert.equal(getSessionEscrowAddress(), ${JSON.stringify(expected)})
const session = createConfiguredSession({ chainId: 3448148188 }, {
  currency: '0x3333333333333333333333333333333333333333',
  permit2Contract: '0x5555555555555555555555555555555555555555',
})
assert.equal(session.metadata.escrowContract, ${JSON.stringify(expected)})
console.log('Embedded escrow works without SDK or app .env files')
`)
const run = file => execFileSync(process.execPath, [file], {
  cwd: work,
  env: { ...process.env, TRON_SESSION_ESCROW_ADDRESS: 'invalid-runtime-value' },
  encoding: 'utf8',
})
process.stdout.write(`Installed package: ${run(entry)}`)
await build({
  entry: [entry], outDir: join(consumer, 'bundle'), format: ['esm'], platform: 'node',
  bundle: true, noExternal: [manifest.name],
  external: Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }),
  config: false, silent: true,
})
process.stdout.write(`Bundled package: ${run(join(consumer, 'bundle', 'check.js'))}`)
console.log(`Package verified: ${join(work, packed.filename)}`)
