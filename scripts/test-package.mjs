import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { build } from 'tsup'
import { chains, normalizeAddress } from '../dist/index.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const env = parseEnv(readFileSync(join(root, '.env'), 'utf8'))
const expected = [
  [chains.nile, env.TRON_SESSION_ESCROW_ADDRESS_NILE],
  [chains.mainnet, env.TRON_SESSION_ESCROW_ADDRESS_MAINNET],
].map(([chainId, address]) => [chainId, address?.trim() ? normalizeAddress(address.trim()) : null])
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
import { getSessionEscrowAddress } from ${JSON.stringify(`${manifest.name}/config`)}
import { createConfiguredSession } from ${JSON.stringify(`${manifest.name}/session`)}
const options = {
  currency: '0x3333333333333333333333333333333333333333',
  permit2Contract: '0x5555555555555555555555555555555555555555',
}
for (const [chainId, escrowContract] of ${JSON.stringify(expected)}) {
  if (escrowContract === null) {
    const error = new RegExp('No session escrow configured for TRON chain ID ' + chainId)
    assert.throws(() => getSessionEscrowAddress(chainId), error)
    assert.throws(() => createConfiguredSession({ chainId }, options), error)
    continue
  }
  assert.equal(getSessionEscrowAddress(chainId), escrowContract)
  assert.deepEqual(createConfiguredSession({ chainId }, options).metadata, { chainId, escrowContract })
}
console.log('Escrow selection uses the embedded addresses without SDK or app .env files')
`)
const run = file => execFileSync(process.execPath, [file], {
  cwd: work,
  env: { ...process.env, TRON_SESSION_ESCROW_ADDRESS_NILE: 'invalid-runtime-value', TRON_SESSION_ESCROW_ADDRESS_MAINNET: 'invalid-runtime-value' },
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
