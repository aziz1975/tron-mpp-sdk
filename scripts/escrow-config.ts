import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import type { Address } from 'viem'
import { chains, TokenAddressSchema } from '../src/protocol/Primitives.js'

/** Build input only. Never imported by the published runtime entry points. */
export function readBuildEscrowAddresses(path: URL) {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('SDK .env is missing. Create it from .env.example before building.')
    throw error
  }
  const env = parseEnv(contents)
  const addresses: Partial<Record<number, Address>> = {}
  for (const [chainId, variable] of [
    [chains.nile, 'TRON_SESSION_ESCROW_ADDRESS_NILE'],
    [chains.mainnet, 'TRON_SESSION_ESCROW_ADDRESS_MAINNET'],
  ] as const) {
    const value = env[variable]?.trim()
    if (!value) continue
    const parsed = TokenAddressSchema.safeParse(value)
    if (!parsed.success) throw new Error(`Invalid ${variable} in SDK .env.`)
    addresses[chainId] = parsed.data
  }
  if (Object.keys(addresses).length === 0) {
    throw new Error('Set TRON_SESSION_ESCROW_ADDRESS_NILE or TRON_SESSION_ESCROW_ADDRESS_MAINNET in SDK .env.')
  }
  return addresses
}
