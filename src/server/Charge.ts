import { Errors, Method, Receipt, Store } from 'mppx'

import * as Methods from '../Methods.js'
import * as Types from '../Types.js'
import { verifyPaymentProof } from '../Proof.js'

export function charge(
  parameters: charge.Parameters,
): Method.Server<typeof Methods.charge, charge.Defaults>
export function charge(parameters: charge.Parameters): Method.AnyServer {
  const defaults = createDefaults(parameters)
  const replayStore = Store.from(
    parameters.store ?? Store.memory(),
    parameters.storeKeyPrefix ? { keyPrefix: parameters.storeKeyPrefix } : undefined,
  ) as Store.AtomicStore<charge.StoreItemMap>

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
      const payload = Types.TransactionPayloadSchema.parse(credential.payload)
      const request = Types.ChargeRequestSchema.parse(credential.challenge.request)
      Types.assertCanonicalCurrency(request)
      if (!await verifyPaymentProof({
        challengeId: credential.challenge.id,
        request,
        ...payload,
      })) {
        throw new Errors.VerificationFailedError({ reason: 'TRON payer signature is invalid' })
      }

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

      await claimPayment(replayStore, {
        challengeId: credential.challenge.id,
        network: request.methodDetails.network,
        txId: verified.reference,
      })

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
  type StoreItemMap = { [key: `tron:charge:${string}`]: number } & {
    [key: `tron:challenge:${string}`]: string
  }

  type Parameters = {
    /** Verifies that the submitted TRON transaction paid the original Challenge. */
    verifier: Types.ChargeVerifier
    /** Default asset accepted by this route. */
    asset: Types.AssetInput
    /** Default TRON network accepted by this route, for example `mainnet` or `nile`. */
    network: string
    /** Default receiving TRON address. */
    recipient: Types.TronAddress
    /** Must match TRX or the configured TRC-20 contract address when provided. */
    currency?: string | undefined
    /** Native TRX always uses 6 decimals. */
    decimals?: 6 | undefined
    /** Minimum confirmations required by verifier implementations that support confirmations. */
    minConfirmations?: number | undefined
    /**
     * Atomic store enforcing single-use challenge IDs and transaction IDs.
     * Defaults to an in-memory store. Provide a shared persistent store in production.
     */
    store?: Store.AtomicStore | undefined
    /** Optional prefix for replay-protection keys, useful for tenant isolation. */
    storeKeyPrefix?: string | undefined
  }

  type Defaults = {
    asset: Types.NormalizedAsset
    currency: string
    decimals?: 6 | undefined
    minConfirmations?: number | undefined
    network: string
    recipient: Types.TronAddress
  }
}

async function claimPayment(
  store: Store.AtomicStore<charge.StoreItemMap>,
  payment: { challengeId: string; network: string; txId: Types.TransactionId },
) {
  const challengeKey = `tron:challenge:${payment.challengeId}` as const
  const reservation = globalThis.crypto.randomUUID()
  const reserved = await store.update(challengeKey, (current) => {
    if (current !== null) return { op: 'noop', result: false }
    return { op: 'set', value: reservation, result: true }
  })
  if (!reserved) {
    throw new Errors.VerificationFailedError({ reason: 'TRON challenge has already been used' })
  }

  try {
    // Keep the existing transaction key format so persisted replay history remains valid.
    const transactionKey = `tron:charge:${payment.network}:${payment.txId.toLowerCase()}` as const
    const claimed = await store.update(transactionKey, (current) => {
      if (current !== null) return { op: 'noop', result: false }
      return { op: 'set', value: Date.now(), result: true }
    })
    if (!claimed) {
      throw new Errors.VerificationFailedError({ reason: 'TRON transaction has already been used' })
    }
  } catch (error) {
    // A rejected payment must not consume its challenge. Only release our own reservation.
    await store.update(challengeKey, (current) => ({
      op: current === reservation ? 'delete' : 'noop',
      result: undefined,
    }))
    throw error
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
