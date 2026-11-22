import type { Address } from 'viem'
import { chains } from './protocol/Primitives.js'

// Replaced with validated deployments by tsup when building the SDK.
declare const __TRON_SESSION_ESCROW_ADDRESSES__: Readonly<Partial<Record<number, Address>>>

/** Return the embedded escrow for a chain. Omitting the chain ID selects Nile for compatibility. */
export function getSessionEscrowAddress(chainId: number = chains.nile): Address {
  const address = __TRON_SESSION_ESCROW_ADDRESSES__[chainId]
  if (typeof address !== 'string') throw new Error(`No session escrow configured for TRON chain ID ${chainId}.`)
  return address
}
