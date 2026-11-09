import { charge } from './Charge.js'
import { session } from './Session.js'

export { Expires, Mppx, Store } from 'mppx/server'
export type { ChargeParameters, ChargeMethod } from './Charge.js'
export { SessionManager, needVoucherEvent, receiptEvent } from './Session.js'
export type { SessionParameters, SessionState } from './Session.js'

/** TRC-20 payment methods: one-time charges and escrow-backed sessions. */
export const tron = { charge, session } as const
