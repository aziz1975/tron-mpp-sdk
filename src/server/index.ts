import { charge as charge_ } from './Charge.js'

export { Expires, Mppx, Store } from 'mppx/server'
export { charge } from './Charge.js'
export type { ChargeVerifier, VerifiedPayment } from '../Types.js'

export function tron(parameters: tron.Parameters): ReturnType<typeof charge_> {
  return tron.charge(parameters)
}

export namespace tron {
  export type Parameters = charge_.Parameters
  export const charge = charge_
}
