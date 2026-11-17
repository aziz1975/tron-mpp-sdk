import type { Address } from 'viem'

// Replaced with a validated address by tsup when building the SDK.
declare const __TRON_SESSION_ESCROW_ADDRESS__: Address

/** Return the escrow embedded from the SDK's .env at build time. */
export function getSessionEscrowAddress(): Address {
  return __TRON_SESSION_ESCROW_ADDRESS__
}
