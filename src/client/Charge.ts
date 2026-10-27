import { Credential, Method } from 'mppx'
import { parseUnits } from 'viem'

import * as Methods from '../Methods.js'
import * as Types from '../Types.js'

export function charge(parameters: charge.Parameters) {
  return Method.toClient(Methods.charge, {
    async createCredential({ challenge }) {
      const request = Types.ChargeRequestSchema.parse(challenge.request)

      assertClientPolicy(parameters, request)

      const payload = Types.TransactionPayloadSchema.parse(await parameters.signer({
        challengeId: challenge.id,
        request,
      }))

      return Credential.serialize(
        Credential.from({
          challenge,
          payload,
          source: Types.toSource({
            address: payload.payer,
            network: request.methodDetails.network,
          }),
        }),
      )
    },
  })
}

export declare namespace charge {
  type Parameters = {
    /** Signs and broadcasts a TRON payment for a challenge request. */
    signer: Types.ChargeSigner
    /** Optional maximum display-unit amount the client is willing to pay. */
    maxAmount?: string | undefined
    /** Optional maximum atomic amount the client is willing to pay. */
    maxAtomicAmount?: string | undefined
    /** Optional allowlist of supported TRON networks, for example `mainnet` or `nile`. */
    networks?: readonly string[] | undefined
    /** Optional allowlist of accepted currencies, for example `TRX` or a TRC-20 address. */
    currencies?: readonly string[] | undefined
    /** Trusted token decimals keyed by TRC-20 contract address, required for token maxAmount. */
    tokenDecimals?: Readonly<Record<string, number>> | undefined
  }
}

function assertClientPolicy(parameters: charge.Parameters, request: Types.ChargeRequest) {
  const { maxAmount, maxAtomicAmount, networks, currencies } = parameters
  Types.assertCanonicalCurrency(request)

  if (networks && !networks.includes(request.methodDetails.network)) {
    throw new Error(`TRON network is not allowed: ${request.methodDetails.network}.`)
  }

  if (currencies && !currencies.includes(request.currency)) {
    throw new Error(`TRON currency is not allowed: ${request.currency}.`)
  }

  if (maxAtomicAmount !== undefined) {
    Types.assertAtomicAmount(maxAtomicAmount, 'maxAtomicAmount')
    if (BigInt(request.amount) > BigInt(maxAtomicAmount)) {
      throw new Error('TRON charge amount exceeds maxAtomicAmount.')
    }
  }

  if (maxAmount !== undefined) {
    const asset = request.methodDetails.asset
    const decimals = asset.type === 'native' ? 6 : parameters.tokenDecimals?.[asset.contractAddress]
    if (decimals === undefined || !Types.DecimalsSchema.safeParse(decimals).success) {
      throw new Error('Trusted token decimals are required for maxAmount.')
    }
    if (asset.decimals !== decimals) throw new Error('TRON token decimals do not match client policy.')
    if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(maxAmount)) throw new Error('Invalid maxAmount.')
    if ((maxAmount.split('.')[1]?.length ?? 0) > decimals) {
      throw new Error('maxAmount exceeds the asset decimal precision.')
    }
    const maxUnits = parseUnits(maxAmount, decimals)
    if (BigInt(request.amount) > maxUnits) throw new Error('TRON charge amount exceeds maxAmount.')
  }
}
