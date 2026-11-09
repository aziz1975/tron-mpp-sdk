import { charge } from './Charge.js'
import { session } from './Session.js'

export { Mppx } from 'mppx/client'
export { signVoucher } from './Session.js'
export type { ChargeParameters } from './Charge.js'
export type { SessionParameters } from './Session.js'

/** TRC-20 payment methods: one-time charges and escrow-backed sessions. */
export const tron = { charge, session } as const
