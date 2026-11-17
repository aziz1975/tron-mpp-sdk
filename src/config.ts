import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { TokenAddressSchema } from './protocol/index.js'

/** Read the session escrow configured in the SDK package's .env file. */
export function getSessionEscrowAddress() {
  const path = new URL('../.env', import.meta.url)
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('SDK .env is missing; create it from .env.example and set TRON_SESSION_ESCROW_ADDRESS.')
    throw error
  }
  const value = parseEnv(contents).TRON_SESSION_ESCROW_ADDRESS?.trim()
  if (!value) throw new Error('Missing TRON_SESSION_ESCROW_ADDRESS in SDK .env.')
  try { return TokenAddressSchema.parse(value) } catch {
    throw new Error('Invalid TRON_SESSION_ESCROW_ADDRESS in SDK .env.')
  }
}
