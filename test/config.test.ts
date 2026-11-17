import { describe, expect, it, vi } from 'vitest'
import { normalizeAddress } from '../src/protocol/index.js'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('node:fs', () => ({ readFileSync: read }))
import { getSessionEscrowAddress } from '../src/config.js'

describe('SDK escrow configuration', () => {
  it('loads and normalizes the SDK file without consulting the app environment', () => {
    read.mockReturnValue('TRON_SESSION_ESCROW_ADDRESS=TDt4Dwx56E2wqQUgSXonQrwebxNiXPvT8F\n')
    expect(getSessionEscrowAddress()).toBe(normalizeAddress('TDt4Dwx56E2wqQUgSXonQrwebxNiXPvT8F'))
    expect(String(read.mock.calls.at(-1)?.[0])).toMatch(/\/\.env$/)
  })
  it('reports missing files and missing or invalid addresses', () => {
    read.mockImplementationOnce(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) })
    expect(getSessionEscrowAddress).toThrow('SDK .env is missing')
    read.mockReturnValueOnce('OTHER=value')
    expect(getSessionEscrowAddress).toThrow('Missing TRON_SESSION_ESCROW_ADDRESS')
    read.mockReturnValueOnce('TRON_SESSION_ESCROW_ADDRESS=invalid')
    expect(getSessionEscrowAddress).toThrow('Invalid TRON_SESSION_ESCROW_ADDRESS')
  })
})
