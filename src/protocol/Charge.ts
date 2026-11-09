import { Method, z } from 'mppx'
import type { Address, Hex } from 'viem'
import * as P from './Primitives.js'

export const CredentialTypeSchema = z.enum(['permit2', 'authorization', 'transaction', 'hash'])
export type CredentialType = z.infer<typeof CredentialTypeSchema>
const PermissionSchema = z.object({ token: P.AddressSchema, amount: P.Uint256Schema })
const TransferSchema = z.object({ to: P.AddressSchema, requestedAmount: P.Uint256Schema })
export const Permit2PayloadSchema = z.object({
  type: z.literal('permit2'),
  permit: z.object({ permitted: z.array(PermissionSchema).check(z.minLength(1), z.maxLength(11)), nonce: P.Uint256Schema, deadline: P.Uint256Schema }),
  transferDetails: z.array(TransferSchema).check(z.minLength(1), z.maxLength(11)),
  witness: z.object({ challengeHash: P.Bytes32Schema, externalId: z.string() }),
  signature: P.ContractSignatureSchema,
})
export const AuthorizationPayloadSchema = z.object({
  type: z.literal('authorization'), from: P.AddressSchema, to: P.AddressSchema,
  value: P.Uint256Schema, validAfter: P.Uint256Schema, validBefore: P.Uint256Schema,
  nonce: P.Bytes32Schema, signature: P.SignatureSchema,
})
export const HashPayloadSchema = z.object({ type: z.literal('hash'), hash: P.Bytes32Schema })
/** TRON adaptation: a signed protobuf transaction envelope, never Ethereum RLP. */
export const TransactionPayloadSchema = z.object({ type: z.literal('transaction'), signature: z.string().check(z.minLength(1), z.maxLength(131072)) })
export const PayloadSchema = z.discriminatedUnion('type', [Permit2PayloadSchema, AuthorizationPayloadSchema, HashPayloadSchema, TransactionPayloadSchema])
export type Payload = z.infer<typeof PayloadSchema>
export type Permit2Payload = z.infer<typeof Permit2PayloadSchema>
export type AuthorizationPayload = z.infer<typeof AuthorizationPayloadSchema>
export const RequestSchema = z.object({
  amount: P.Uint256Schema.check(z.refine(v => BigInt(v) > 0n)),
  currency: P.TokenAddressSchema, recipient: P.AddressSchema,
  description: z.optional(z.string()), externalId: z.optional(z.string()),
  methodDetails: z.object({
    chainId: P.ChainIdSchema, permit2Address: z.optional(P.AddressSchema),
    spender: z.optional(P.AddressSchema),
    credentialTypes: z._default(z.array(CredentialTypeSchema).check(z.minLength(1)), ['transaction', 'hash']),
    decimals: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(255))),
    splits: z.optional(z.array(z.object({ recipient: P.AddressSchema, amount: P.Uint256Schema, memo: z.optional(z.string().check(z.maxLength(256))) })).check(z.minLength(1), z.maxLength(10))),
  }),
})
export type Request = z.infer<typeof RequestSchema>
export type Challenge = { id: string; realm: string; expires?: string | undefined; request: Request }
export const method = Method.from({ name: 'tron', intent: 'charge', schema: { credential: { payload: PayloadSchema }, request: RequestSchema } })

export function transfers(request: Request): P.Transfer[] {
  const splits = request.methodDetails.splits ?? []
  const total = splits.reduce((sum, s) => sum + BigInt(s.amount), 0n)
  if (total >= BigInt(request.amount)) throw new Error('Splits must total less than the charge amount.')
  return [{ to: request.recipient, amount: (BigInt(request.amount) - total).toString() }, ...splits.map(s => ({ to: s.recipient, amount: s.amount }))]
}
export function assertType(request: Request, type: CredentialType): void {
  if (!request.methodDetails.credentialTypes.includes(type)) throw new Error('Credential type was not advertised.')
  if (request.methodDetails.splits?.length && type !== 'permit2') throw new Error('Splits require Permit2.')
  transfers(request)
}
export function assertChallengeActive(challenge: Pick<Challenge, 'expires'>, now = Date.now()): void {
  if (challenge.expires !== undefined) {
    const expires = Date.parse(challenge.expires)
    if (!Number.isFinite(expires) || expires <= now) throw new Error('Challenge expired or expiry is invalid.')
  }
}
export function permitTypedData(challenge: Challenge, payload: Permit2Payload): P.TypedData {
  const { permit2Address, spender, chainId } = challenge.request.methodDetails
  if (!permit2Address || !spender) throw new Error('Permit2 contract and spender must be explicitly configured on TRON.')
  const batch = payload.permit.permitted.length > 1
  return {
    domain: { name: 'Permit2', chainId, verifyingContract: permit2Address },
    primaryType: batch ? 'PermitBatchWitnessTransferFrom' : 'PermitWitnessTransferFrom',
    types: {
      TokenPermissions: P.TokenPermissions, PaymentWitness: P.PaymentWitness,
      [batch ? 'PermitBatchWitnessTransferFrom' : 'PermitWitnessTransferFrom']: [
        { name: 'permitted', type: batch ? 'TokenPermissions[]' : 'TokenPermissions' },
        { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'PaymentWitness' },
      ],
    },
    message: { permitted: batch ? payload.permit.permitted : payload.permit.permitted[0], spender,
      nonce: payload.permit.nonce, deadline: payload.permit.deadline, witness: payload.witness },
  }
}

export async function validatePayload(p: {
  challenge: Challenge; payload: Payload; payer?: Address | undefined; authorizationDomain?: P.AuthorizationDomain | undefined;
  contractSignature?: P.ContractVerifier | undefined; now?: number
}): Promise<void> {
  const { challenge, payload, payer } = p
  const request = challenge.request
  assertType(request, payload.type)
  assertChallengeActive(challenge, p.now ?? Date.now())
  const now = BigInt(Math.floor((p.now ?? Date.now()) / 1000))
  if (payload.type !== 'hash' && !payer) throw new Error('Payment signer is required.')
  if (payload.type === 'permit2') {
    const expected = transfers(request)
    if (BigInt(payload.permit.deadline) <= now) throw new Error('Permit expired.')
    if (challenge.expires && BigInt(payload.permit.deadline) > BigInt(Math.floor(Date.parse(challenge.expires) / 1000))) throw new Error('Permit outlives challenge.')
    if (payload.witness.challengeHash !== P.challengeHash(challenge) || payload.witness.externalId !== (request.externalId ?? '')) throw new Error('Permit witness mismatch.')
    if (payload.permit.permitted.length !== expected.length || payload.transferDetails.length !== expected.length) throw new Error('Permit transfer count mismatch.')
    expected.forEach((transfer, i) => {
      const permission = payload.permit.permitted[i]!
      const detail = payload.transferDetails[i]!
      if (!P.isSameAddress(permission.token, request.currency) || !P.isSameAddress(detail.to, transfer.to) ||
          detail.requestedAmount !== transfer.amount || BigInt(permission.amount) < BigInt(transfer.amount)) throw new Error('Permit transfer mismatch.')
    })
    if (!await P.verifySigner(permitTypedData(challenge, payload), payload.signature, payer!, p.contractSignature)) throw new Error('Permit signer mismatch.')
  } else if (payload.type === 'authorization') {
    if (!p.authorizationDomain) throw new Error('Token has not been configured for EIP-3009.')
    if (!P.isSameAddress(payload.from, payer!) || !P.isSameAddress(payload.to, request.recipient) || payload.value !== request.amount ||
        payload.nonce !== P.challengeHash(challenge)) throw new Error('Authorization terms mismatch.')
    if (BigInt(payload.validAfter) >= now || BigInt(payload.validBefore) <= now) throw new Error('Authorization outside validity window.')
    if (!P.isSameAddress(await P.recoverSigner(P.transferAuthorizationTypedData({ chainId: request.methodDetails.chainId,
      token: request.currency, domain: p.authorizationDomain, authorization: payload }), payload.signature), payer!)) throw new Error('Authorization signer mismatch.')
  }
}

export type Adapter = {
  /** Must be bound to the configured TRON node/network. */
  chainId: number
  payer?: string
  signTypedData?: P.TypedSigner
  contractSignature?: P.ContractVerifier
  tokenState: (token: Address, owner: Address, spender?: Address) => Promise<P.TokenState>
  nonceUsed: (permit2: Address, owner: Address, nonce: bigint) => Promise<boolean>
  /** Recover the owner of a validated signed transaction when source is omitted. */
  transactionPayer?: (envelope: string) => Promise<Address>
  /** Preflight must not broadcast. */
  simulate: (challenge: Challenge, payload: Payload, payer: Address) => Promise<void>
  submit: (challenge: Challenge, payload: Exclude<Payload, { type: 'hash' }>, payer: Address) => Promise<Hex>
  /** Require a mined successful receipt and every ordered transfer. Throw
   * VerificationFailedError for definitive evidence mismatches, and
   * TransactionOutcomeUnknownError while confirmation remains uncertain. */
  verify: (hash: Hex, request: Request, payer?: Address) => Promise<P.Settlement>
  /** Broadcast a transfer from the client, or return a signed unbroadcast envelope. */
  createTransaction?: (request: Request, broadcast: boolean) => Promise<Hex | string>
}
