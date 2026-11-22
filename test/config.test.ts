import { describe, expect, it, vi } from 'vitest'
import { chains, normalizeAddress, zeroAddress } from '../src/protocol/index.js'
import { getSessionEscrowAddress } from '../src/config.js'
import { readBuildEscrowAddresses } from '../scripts/escrow-config.js'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('node:fs', () => ({ readFileSync: read }))
const path = new URL('file:///sdk/.env')
const nile = 'TDt4Dwx56E2wqQUgSXonQrwebxNiXPvT8F'
const mainnet = `0x${'77'.repeat(20)}`

describe('SDK build-time escrow configuration', () => {
  it('reads and normalizes the address for each chain from the specified SDK file', () => {
    read.mockReturnValueOnce(`TRON_SESSION_ESCROW_ADDRESS_NILE=${nile}\nTRON_SESSION_ESCROW_ADDRESS_MAINNET=${mainnet}\n`)
    expect(readBuildEscrowAddresses(path)).toEqual({ [chains.nile]: normalizeAddress(nile), [chains.mainnet]: mainnet })
    expect(read).toHaveBeenLastCalledWith(path, 'utf8')
  })
  it('allows a build with only one deployment', () => {
    read.mockReturnValueOnce(`TRON_SESSION_ESCROW_ADDRESS_NILE=${nile}\nTRON_SESSION_ESCROW_ADDRESS_MAINNET=\n`)
    expect(readBuildEscrowAddresses(path)).toEqual({ [chains.nile]: normalizeAddress(nile) })
    read.mockReturnValueOnce(`TRON_SESSION_ESCROW_ADDRESS_MAINNET=${mainnet}\n`)
    expect(readBuildEscrowAddresses(path)).toEqual({ [chains.mainnet]: mainnet })
  })
  it('rejects missing files, empty configuration and invalid supplied addresses', () => {
    read.mockImplementationOnce(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) })
    expect(() => readBuildEscrowAddresses(path)).toThrow('SDK .env is missing')
    read.mockReturnValueOnce('TRON_SESSION_ESCROW_ADDRESS_NILE=\nTRON_SESSION_ESCROW_ADDRESS_MAINNET=\n')
    expect(() => readBuildEscrowAddresses(path)).toThrow('Set TRON_SESSION_ESCROW_ADDRESS_NILE or TRON_SESSION_ESCROW_ADDRESS_MAINNET')
    read.mockReturnValueOnce('TRON_SESSION_ESCROW_ADDRESS_NILE=invalid\n')
    expect(() => readBuildEscrowAddresses(path)).toThrow('Invalid TRON_SESSION_ESCROW_ADDRESS_NILE')
    read.mockReturnValueOnce(`TRON_SESSION_ESCROW_ADDRESS_NILE=${nile}\nTRON_SESSION_ESCROW_ADDRESS_MAINNET=${zeroAddress}\n`)
    expect(() => readBuildEscrowAddresses(path)).toThrow('Invalid TRON_SESSION_ESCROW_ADDRESS_MAINNET')
  })
  it('preserves unexpected file read errors', () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
    read.mockImplementationOnce(() => { throw denied })
    expect(() => readBuildEscrowAddresses(path)).toThrow(denied)
  })
  it('returns the embedded value without reading files or consulting runtime environment variables', () => {
    vi.stubEnv('TRON_SESSION_ESCROW_ADDRESS_NILE', 'invalid-runtime-value')
    vi.stubEnv('TRON_SESSION_ESCROW_ADDRESS_MAINNET', 'invalid-runtime-value')
    try {
      read.mockClear().mockImplementation(() => { throw new Error('No runtime filesystem access allowed') })
      expect(getSessionEscrowAddress(chains.nile)).toBe(`0x${'66'.repeat(20)}`)
      expect(getSessionEscrowAddress(chains.mainnet)).toBe(mainnet)
      expect(getSessionEscrowAddress()).toBe(getSessionEscrowAddress(chains.nile))
      expect(() => getSessionEscrowAddress(chains.shasta)).toThrow(`No session escrow configured for TRON chain ID ${chains.shasta}`)
      expect(read).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
