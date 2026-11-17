import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { TokenAddressSchema } from '../src/protocol/Primitives.js'

/** Build input only. Never imported by the published runtime entry points. */
export function readBuildEscrowAddress(path: URL) {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('SDK .env is missing; create it from .env.example and set TRON_SESSION_ESCROW_ADDRESS before building.')
    throw error
  }
  const value = parseEnv(contents).TRON_SESSION_ESCROW_ADDRESS?.trim()
  if (!value) throw new Error('Missing TRON_SESSION_ESCROW_ADDRESS in SDK .env.')
  try { return TokenAddressSchema.parse(value) } catch {
    throw new Error('Invalid TRON_SESSION_ESCROW_ADDRESS in SDK .env.')
  }
}
