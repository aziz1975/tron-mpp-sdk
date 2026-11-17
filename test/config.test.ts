import { describe, expect, it, vi } from 'vitest'
import { normalizeAddress, zeroAddress } from '../src/protocol/index.js'
import { getSessionEscrowAddress } from '../src/config.js'
import { readBuildEscrowAddress } from '../scripts/escrow-config.js'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('node:fs', () => ({ readFileSync: read }))
const path = new URL('file:///sdk/.env')

describe('SDK build-time escrow configuration', () => {
  it('reads and normalizes the address from the specified SDK file', () => {
    read.mockReturnValue('TRON_SESSION_ESCROW_ADDRESS=TDt4Dwx56E2wqQUgSXonQrwebxNiXPvT8F\n')
    expect(readBuildEscrowAddress(path)).toBe(normalizeAddress('TDt4Dwx56E2wqQUgSXonQrwebxNiXPvT8F'))
    expect(read).toHaveBeenLastCalledWith(path, 'utf8')
  })
  it('rejects missing files and missing, invalid or zero addresses at build time', () => {
    read.mockImplementationOnce(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) })
    expect(() => readBuildEscrowAddress(path)).toThrow('SDK .env is missing')
    for (const contents of ['OTHER=value', 'TRON_SESSION_ESCROW_ADDRESS=  ']) {
      read.mockReturnValueOnce(contents)
      expect(() => readBuildEscrowAddress(path)).toThrow('Missing TRON_SESSION_ESCROW_ADDRESS')
    }
    for (const value of ['invalid', zeroAddress]) {
      read.mockReturnValueOnce(`TRON_SESSION_ESCROW_ADDRESS=${value}`)
      expect(() => readBuildEscrowAddress(path)).toThrow('Invalid TRON_SESSION_ESCROW_ADDRESS')
    }
  })
  it('preserves unexpected file read errors', () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
    read.mockImplementationOnce(() => { throw denied })
    expect(() => readBuildEscrowAddress(path)).toThrow(denied)
  })
  it('returns the embedded value without reading files or consulting runtime environment variables', () => {
    const previous = process.env.TRON_SESSION_ESCROW_ADDRESS
    try {
      process.env.TRON_SESSION_ESCROW_ADDRESS = 'invalid-runtime-value'
      read.mockClear().mockImplementation(() => { throw new Error('No runtime filesystem access allowed') })
      expect(getSessionEscrowAddress()).toBe(`0x${'66'.repeat(20)}`)
      expect(read).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.TRON_SESSION_ESCROW_ADDRESS
      else process.env.TRON_SESSION_ESCROW_ADDRESS = previous
    }
  })
})
