import { Credential, Method } from 'mppx'
import type { Hex } from 'viem'
import * as C from '../protocol/Charge.js'
import * as P from '../protocol/Primitives.js'
import { TransactionOutcomeUnknownError } from '../protocol/Errors.js'

export type ChargeParameters = {
  adapter: C.Adapter
  chainIds: readonly number[]
  currencies: readonly string[]
  /** Trusted primary and split recipients, checked before any signing or broadcast. */
  recipients: readonly string[]
  maxAtomicAmount: string
  credentialTypes?: readonly C.CredentialType[]
  /** Trusted contracts/spenders; never approve a contract obtained only from a challenge. */
  permit2?: { address: string; spender: string }
  authorizationDomain?: P.AuthorizationDomain
}
export function charge(parameters: ChargeParameters) {
  const currencies = parameters.currencies.map(currency => P.TokenAddressSchema.parse(currency))
  const recipients = parameters.recipients.map(P.normalizeAddress)
  if (!recipients.length) throw new Error('Configure at least one trusted payment recipient.')
  return Method.toClient(C.method, {
    async createCredential({ challenge }) {
      C.assertChallengeActive(challenge)
      const request = C.RequestSchema.parse(challenge.request)
      const { adapter } = parameters
      if (!parameters.chainIds.includes(request.methodDetails.chainId) || adapter.chainId !== request.methodDetails.chainId) throw new Error('Unsupported TRON chain.')
      if (!currencies.some(c => P.isSameAddress(c, request.currency))) throw new Error('Token is not allowed.')
      if (BigInt(request.amount) > BigInt(P.Uint256Schema.parse(parameters.maxAtomicAmount))) throw new Error('Charge exceeds maxAtomicAmount.')
      if (C.transfers(request).some(t => !recipients.some(r => P.isSameAddress(r, t.to)))) throw new Error('Payment recipient is not allowed.')
      const payer = P.normalizeAddress(adapter.payer ?? '')
      const c = { ...challenge, request }
      const type = request.methodDetails.credentialTypes.find(t => {
        if (parameters.credentialTypes && !parameters.credentialTypes.includes(t)) return false
        if (request.methodDetails.splits?.length && t !== 'permit2') return false
        if (t === 'permit2') return Boolean(adapter.signTypedData && parameters.permit2 &&
          request.methodDetails.permit2Address && request.methodDetails.spender &&
          P.isSameAddress(parameters.permit2.address, request.methodDetails.permit2Address) &&
          P.isSameAddress(parameters.permit2.spender, request.methodDetails.spender))
        if (t === 'authorization') return Boolean(adapter.signTypedData && parameters.authorizationDomain)
        return Boolean(adapter.createTransaction)
      })
      if (!type) throw new Error('No supported credential type.')
      C.assertType(request, type)
      let payload: C.Payload
      if (type === 'permit2') {
        const state = await adapter.tokenState(request.currency, payer, request.methodDetails.permit2Address)
        if (state.balance < BigInt(request.amount) || state.allowance < BigInt(request.amount)) throw new Error('Insufficient token balance or Permit2 approval.')
        const nonce = BigInt(`0x${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')}`)
        if (await adapter.nonceUsed(request.methodDetails.permit2Address!, payer, nonce)) throw new Error('Permit nonce already used.')
        const unsigned = {
          type: 'permit2' as const,
          permit: { permitted: C.transfers(request).map(t => ({ token: request.currency, amount: t.amount })), nonce: nonce.toString(), deadline: deadline(challenge.expires) },
          transferDetails: C.transfers(request).map(t => ({ to: t.to, requestedAmount: t.amount })),
          witness: { challengeHash: P.challengeHash(challenge), externalId: request.externalId ?? '' },
          signature: '0x' as Hex,
        }
        payload = { ...unsigned, signature: await adapter.signTypedData!(C.permitTypedData(c, unsigned)) }
      } else if (type === 'authorization') {
        const authorization = { from: payer, to: request.recipient, value: request.amount, validAfter: '0', validBefore: deadline(challenge.expires), nonce: P.challengeHash(challenge) }
        payload = { type, ...authorization, signature: await adapter.signTypedData!(P.transferAuthorizationTypedData({
          chainId: adapter.chainId, token: request.currency, domain: parameters.authorizationDomain!, authorization,
        })) }
      } else if (type === 'hash') {
        C.assertChallengeActive(challenge)
        payload = { type, hash: P.Bytes32Schema.parse(await adapter.createTransaction!(request, true)) }
      } else {
        C.assertChallengeActive(challenge)
        payload = { type, signature: await adapter.createTransaction!(request, false) }
      }
      try {
        payload = C.PayloadSchema.parse(payload)
        await C.validatePayload({ challenge: c, payload, payer, authorizationDomain: parameters.authorizationDomain, contractSignature: adapter.contractSignature })
        return Credential.serialize(Credential.from({ challenge, payload, source: P.formatSource(payer, adapter.chainId) }))
      } catch (error) {
        if (payload.type === 'hash') throw new TransactionOutcomeUnknownError(payload.hash, error)
        throw error
      }
    },
  })
}
function deadline(expires?: string): string {
  const value = Math.floor(Math.min(Date.now() + 300_000, expires ? Date.parse(expires) : Infinity) / 1000)
  if (!Number.isSafeInteger(value) || value <= Date.now() / 1000) throw new Error('Challenge has expired.')
  return value.toString()
}
