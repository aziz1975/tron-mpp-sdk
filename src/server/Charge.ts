import { Errors, Method, Receipt } from 'mppx'

import * as Methods from '../Methods.js'
import * as Types from '../Types.js'

export function charge(
  parameters: charge.Parameters,
): Method.Server<typeof Methods.charge, charge.Defaults>
export function charge(parameters: charge.Parameters): Method.AnyServer {
  const defaults = createDefaults(parameters)

  return Method.toServer<typeof Methods.charge, charge.Defaults>(Methods.charge, {
    defaults,
    stableBinding(request) {
      return {
        amount: request.amount,
        currency: request.currency,
        methodDetails: request.methodDetails,
        recipient: request.recipient,
      }
    },
    async verify({ credential }) {
      const payload = credential.payload as Types.TransactionPayload
      const request = credential.challenge.request as Types.ChargeRequest

      const expectedSource = Types.toSource({
        address: payload.payer,
        network: request.methodDetails.network,
      })
      if (credential.source && credential.source !== expectedSource) {
        throw new Errors.VerificationFailedError({ reason: 'TRON credential source mismatch' })
      }

      const verified = await parameters.verifier({
        credential: {
          payload,
        },
        request,
      })

      if (verified.reference !== payload.txId) {
        throw new Errors.VerificationFailedError({ reason: 'TRON transaction reference mismatch' })
      }
      if (verified.payer !== payload.payer) {
        throw new Errors.VerificationFailedError({ reason: 'TRON payer mismatch' })
      }

      return Receipt.from({
        method: Types.paymentMethod,
        reference: verified.reference,
        status: 'success',
        timestamp: verified.timestamp ?? new Date().toISOString(),
      })
    },
  })
}

export declare namespace charge {
  type Parameters = {
    /** Verifies that the submitted TRON transaction paid the original Challenge. */
    verifier: Types.ChargeVerifier
    /** Default asset accepted by this route. */
    asset: Types.AssetInput
    /** Default TRON network accepted by this route, for example `mainnet` or `nile`. */
    network: string
    /** Default receiving TRON address. */
    recipient: Types.TronAddress
    /** Optional override for the Challenge currency field. Defaults to TRX or the TRC-20 address. */
    currency?: string | undefined
    /** Optional decimal override for native TRX. TRX defaults to 6. */
    decimals?: number | undefined
    /** Minimum confirmations required by verifier implementations that support confirmations. */
    minConfirmations?: number | undefined
  }

  type Defaults = {
    asset: Types.NormalizedAsset
    currency: string
    decimals?: number | undefined
    minConfirmations?: number | undefined
    network: string
    recipient: Types.TronAddress
  }
}

function createDefaults(parameters: charge.Parameters): charge.Defaults {
  const asset = Types.normalizeAsset(parameters.asset, parameters.decimals)
  return {
    asset,
    currency: parameters.currency ?? Types.currencyOf(asset),
    ...(parameters.decimals !== undefined ? { decimals: parameters.decimals } : {}),
    ...(parameters.minConfirmations !== undefined
      ? { minConfirmations: parameters.minConfirmations }
      : {}),
    network: parameters.network,
    recipient: parameters.recipient,
  }
}
