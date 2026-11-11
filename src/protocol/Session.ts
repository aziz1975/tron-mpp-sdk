import { Method, PaymentRequest, z } from 'mppx'
import { keccak256, toBytes } from 'viem'
import type { Address, Hex } from 'viem'
import * as P from './Primitives.js'
import { InvalidRequestError, SessionError } from './Errors.js'

const Format = z.enum(['hash', 'permit2', 'authorization'])
export const RequestSchema = z.object({
  amount: P.Uint128Schema, currency: P.TokenAddressSchema, recipient: P.AddressSchema,
  unitType: z.optional(z.string()), suggestedDeposit: z.optional(P.Uint128Schema),
  description: z.optional(z.string()), externalId: z.optional(z.string()),
  methodDetails: z.object({ chainId: P.ChainIdSchema, escrowContract: P.AddressSchema,
    channelId: z.optional(P.Bytes32Schema), minVoucherDelta: z.optional(P.Uint128Schema),
    feePayer: z.optional(z.boolean()), credentialTypes: z.optional(z.array(Format).check(z.minLength(1))),
    permit2Contract: z.optional(P.AddressSchema),
  }),
})
export type Request = z.infer<typeof RequestSchema>
const Authorization = z.object({ from: P.AddressSchema, to: P.AddressSchema, value: P.Uint128Schema,
  validAfter: P.Uint256Schema, validBefore: P.Uint256Schema, nonce: P.Bytes32Schema })
const Permit = z.object({ from: P.AddressSchema, permitted: z.object({ token: P.AddressSchema, amount: P.Uint128Schema }),
  nonce: P.Uint256Schema, deadline: P.Uint256Schema,
  witness: z.union([
    z.object({ payee: P.AddressSchema, salt: P.Bytes32Schema, authorizedSigner: P.AddressSchema }),
    z.object({ channelId: P.Bytes32Schema }),
  ]),
})
const FundingFields = { signature: P.ContractSignatureSchema, salt: z.optional(P.Bytes32Schema), authorizedSigner: z.optional(P.AddressSchema) }
export const FundingSchema = z.discriminatedUnion('type', [
  z.object({ ...FundingFields, action: z.enum(['open', 'topUp']), type: z.literal('authorization'), authorization: Authorization }),
  z.object({ ...FundingFields, action: z.enum(['open', 'topUp']), type: z.literal('permit2'), authorization: Permit }),
])
export type Funding = z.infer<typeof FundingSchema>
/** Unsigned funding instructions. Preparation must not sign or broadcast. */
export const FundingIntentSchema = z.discriminatedUnion('type', [
  z.object({ action: z.enum(['open', 'topUp']), type: z.literal('authorization'), authorization: Authorization, salt: z.optional(P.Bytes32Schema), authorizedSigner: z.optional(P.AddressSchema) }),
  z.object({ action: z.enum(['open', 'topUp']), type: z.literal('permit2'), authorization: Permit, salt: z.optional(P.Bytes32Schema), authorizedSigner: z.optional(P.AddressSchema) }),
])
export type FundingIntent = z.infer<typeof FundingIntentSchema>
export const PaymentPlanSchema = z.union([
  z.object({ action: z.literal('open'), type: z.literal('hash'), deposit: P.Uint128Schema, cumulativeAmount: P.Uint128Schema, authorizedSigner: z.optional(P.AddressSchema) }),
  z.object({ action: z.literal('topUp'), type: z.literal('hash'), channelId: P.Bytes32Schema, additionalDeposit: P.Uint128Schema }),
  z.object({ action: z.literal('voucher'), channelId: P.Bytes32Schema, cumulativeAmount: P.Uint128Schema, deposit: z.optional(FundingIntentSchema) }),
  z.object({ action: z.literal('close'), channelId: P.Bytes32Schema, cumulativeAmount: P.Uint128Schema }),
  z.object({ action: z.literal('open'), type: z.literal('permit2'), channelId: P.Bytes32Schema, authorization: Permit,
    cumulativeAmount: P.Uint128Schema, salt: P.Bytes32Schema, authorizedSigner: z.optional(P.AddressSchema) }),
  z.object({ action: z.literal('open'), type: z.literal('authorization'), channelId: P.Bytes32Schema, authorization: Authorization,
    cumulativeAmount: P.Uint128Schema, salt: P.Bytes32Schema, authorizedSigner: z.optional(P.AddressSchema) }),
  z.object({ action: z.literal('topUp'), type: z.literal('permit2'), channelId: P.Bytes32Schema, authorization: Permit, additionalDeposit: P.Uint128Schema }),
  z.object({ action: z.literal('topUp'), type: z.literal('authorization'), channelId: P.Bytes32Schema, authorization: Authorization, additionalDeposit: P.Uint128Schema, salt: P.Bytes32Schema }),
])
export type PaymentPlan = z.infer<typeof PaymentPlanSchema>
export type ClientPolicy = { maxCumulativeAmount: string; expires?: string | undefined }
export function assertClientPolicy(plan: PaymentPlan | undefined, policy: ClientPolicy): void {
  const limit = BigInt(P.Uint128Schema.parse(policy.maxCumulativeAmount))
  if (plan && 'cumulativeAmount' in plan && BigInt(plan.cumulativeAmount) > limit) throw new InvalidRequestError('Voucher exceeds client cumulative limit.')
  if (policy.expires !== undefined && (!Number.isFinite(Date.parse(policy.expires)) || Date.parse(policy.expires) <= Date.now())) throw new InvalidRequestError('Session challenge expired or expiry is invalid.')
}
// Optional for trusted low-level accounting calls; required by the HTTP verifier.
const RequestAuthorizationFields = { requestAuthorization: z.optional(z.object({ nonce: P.Bytes32Schema, signature: P.ContractSignatureSchema })) }
const VoucherFields = { ...RequestAuthorizationFields, channelId: P.Bytes32Schema, cumulativeAmount: P.Uint128Schema, signature: P.ContractSignatureSchema }
export const PayloadSchema = z.union([
  z.object({ ...VoucherFields, action: z.literal('voucher'), deposit: z.optional(FundingSchema) }),
  z.object({ ...VoucherFields, action: z.literal('close') }),
  z.object({ ...VoucherFields, action: z.literal('open'), type: z.literal('hash'), hash: P.Bytes32Schema, salt: P.Bytes32Schema, authorizedSigner: z.optional(P.AddressSchema) }),
  z.object({ ...RequestAuthorizationFields, action: z.literal('topUp'), type: z.literal('hash'), channelId: P.Bytes32Schema, hash: P.Bytes32Schema, additionalDeposit: P.Uint128Schema }),
  z.object({ ...RequestAuthorizationFields, action: z.literal('open'), type: z.literal('permit2'), channelId: P.Bytes32Schema, authorization: Permit,
    signature: P.ContractSignatureSchema, voucherSignature: P.ContractSignatureSchema, cumulativeAmount: P.Uint128Schema, salt: P.Bytes32Schema, authorizedSigner: z.optional(P.AddressSchema) }),
  z.object({ ...RequestAuthorizationFields, action: z.literal('open'), type: z.literal('authorization'), channelId: P.Bytes32Schema, authorization: Authorization,
    signature: P.SignatureSchema, voucherSignature: P.SignatureSchema, cumulativeAmount: P.Uint128Schema, salt: P.Bytes32Schema, authorizedSigner: z.optional(P.AddressSchema) }),
  z.object({ ...RequestAuthorizationFields, action: z.literal('topUp'), type: z.literal('permit2'), channelId: P.Bytes32Schema, authorization: Permit,
    signature: P.ContractSignatureSchema, additionalDeposit: P.Uint128Schema, salt: z.optional(P.Bytes32Schema) }),
  z.object({ ...RequestAuthorizationFields, action: z.literal('topUp'), type: z.literal('authorization'), channelId: P.Bytes32Schema, authorization: Authorization,
    signature: P.SignatureSchema, additionalDeposit: P.Uint128Schema, salt: P.Bytes32Schema }),
])
export type Payload = z.infer<typeof PayloadSchema>
export type Challenge = { id: string; realm: string; expires?: string | undefined; request: Request }
export function requestAuthorizationTypedData(challenge: Challenge, payload: Payload, nonce: Hex): P.TypedData {
  const { requestAuthorization: _authorization, ...body } = PayloadSchema.parse(payload)
  const request = RequestSchema.parse(challenge.request)
  return P.sessionRequestTypedData({ ...request.methodDetails, channelId: body.channelId, nonce,
    challengeHash: keccak256(toBytes(PaymentRequest.serialize({ id: challenge.id, realm: challenge.realm, expires: challenge.expires ?? '', request }))),
    payloadHash: keccak256(toBytes(PaymentRequest.serialize(body))),
  })
}
export const method = Method.from({ name: 'tron', intent: 'session', schema: { credential: { payload: PayloadSchema }, request: RequestSchema } })
export type Channel = {
  payer: Address; payee: Address; token: Address; authorizedSigner: Address;
  deposit: string; settled: string; closeRequestedAt: string; finalized: boolean
}
export type Adapter = {
  chainId: number
  escrowContract: string
  /** Must query the deployed contract; minimum permitted grace period is 900 seconds. */
  gracePeriod: () => Promise<number>
  channel: (id: Hex) => Promise<Channel | null>
  /** Optional channel snapshot backed by the adapter's required confirmation depth. */
  confirmedChannel?: (id: Hex) => Promise<Channel | null>
  /** Require successful mined receipt plus a matching escrow event for this channel/action/amount. */
  verifyTransaction: (hash: Hex, action: 'open' | 'topUp', channelId: Hex, amount?: string) => Promise<void>
  fund?: (request: Request, channelId: Hex, funding: Funding) => Promise<Hex>
  /** Return only after the operation succeeds at the required confirmation depth. */
  close: (channelId: Hex, cumulativeAmount: string, signature: Hex) => Promise<P.Settlement>
  settle: (channelId: Hex, cumulativeAmount: string, signature: Hex) => Promise<P.Settlement>
  /** Report success or failure only after the required confirmation depth. Never submits. */
  transactionStatus?: (hash: Hex) => Promise<'pending' | 'success' | 'reverted'>
  /** Optional ERC-1271 support; callback must check code and current isValidSignature result. */
  contractSignature?: (signer: Address, digest: Hex, signature: Hex) => Promise<boolean>
}
export type Wallet = {
  adapter: Pick<Adapter, 'chainId' | 'escrowContract' | 'channel'>
  payer?: string | undefined
  /** Sign the off-chain SessionRequest proof using the voucher signer, or funder for top-ups. */
  signRequest: (data: P.TypedData, action: Payload['action']) => Promise<Hex>
  /** Execute exactly this validated unsigned plan; enforce policy before signing or funding. */
  createPayload: (request: Request, plan: PaymentPlan, policy: ClientPolicy) => Promise<Payload>
}
export function fundingTypedData(request: Request, channelId: Hex, funding: Funding | FundingIntent, authorizationDomain?: P.AuthorizationDomain): P.TypedData {
  const a = funding.authorization
  if (funding.type === 'authorization' && 'value' in a) {
    if (!authorizationDomain) throw new InvalidRequestError('Token is not configured for EIP-3009.')
    return P.transferAuthorizationTypedData({ chainId: request.methodDetails.chainId, token: request.currency,
      domain: authorizationDomain, authorization: a, receive: true })
  }
  if (!('permitted' in a) || !request.methodDetails.permit2Contract) throw new InvalidRequestError('Missing TRON Permit2 configuration.')
  const open = funding.action === 'open'
  const witnessName = open ? 'ChannelOpenWitness' : 'ChannelTopUpWitness'
  return {
    domain: { name: 'Permit2', chainId: request.methodDetails.chainId, verifyingContract: request.methodDetails.permit2Contract },
    primaryType: 'PermitWitnessTransferFrom',
    types: {
      TokenPermissions: P.TokenPermissions,
      [witnessName]: open ? [{ name: 'payee', type: 'address' }, { name: 'salt', type: 'bytes32' }, { name: 'authorizedSigner', type: 'address' }] : [{ name: 'channelId', type: 'bytes32' }],
      PermitWitnessTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: witnessName }],
    },
    message: { permitted: a.permitted, spender: request.methodDetails.escrowContract, nonce: a.nonce, deadline: a.deadline, witness: a.witness },
  }
}

export function assertFundingTerms(request: Request, channelId: Hex, funding: Funding | FundingIntent): void {
  if (!request.methodDetails.feePayer || !(request.methodDetails.credentialTypes ?? ['hash']).includes(funding.type)) throw new InvalidRequestError('Funding format not advertised.')
  const a = funding.authorization
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (funding.action === 'open') {
    if (!funding.salt) throw new InvalidRequestError('Open requires salt.')
    const expected = P.computeChannelId({ payer: a.from, payee: request.recipient, token: request.currency,
      salt: funding.salt, authorizedSigner: funding.authorizedSigner, escrowContract: request.methodDetails.escrowContract, chainId: request.methodDetails.chainId })
    if (channelId !== expected) throw new InvalidRequestError('Channel ID mismatch.')
  }
  if ('value' in a) {
    if (!funding.salt) throw new InvalidRequestError('EIP-3009 funding requires salt.')
    if (!P.isSameAddress(a.to, request.methodDetails.escrowContract) || BigInt(a.validAfter) >= now || BigInt(a.validBefore) <= now) throw new InvalidRequestError('Authorization terms or deadline mismatch.')
    const expected = funding.action === 'open' ? P.authorizationNonce({ from: a.from, payee: request.recipient, token: request.currency,
      salt: funding.salt, authorizedSigner: funding.authorizedSigner }) : P.topUpNonce({ channelId, additionalDeposit: a.value, from: a.from, salt: funding.salt })
    if (a.nonce !== expected) throw new InvalidRequestError('Authorization nonce mismatch.')
  } else {
    if (!P.isSameAddress(a.permitted.token, request.currency) || BigInt(a.deadline) <= now) throw new InvalidRequestError('Permit token or deadline mismatch.')
    if (funding.action === 'open') {
      if (!('payee' in a.witness) || !P.isSameAddress(a.witness.payee, request.recipient) || a.witness.salt !== funding.salt ||
          !P.isSameAddress(a.witness.authorizedSigner, funding.authorizedSigner ?? P.zeroAddress)) throw new InvalidRequestError('Open witness mismatch.')
    } else if (!('channelId' in a.witness) || a.witness.channelId !== channelId) throw new InvalidRequestError('TopUp witness mismatch.')
  }
  if (BigInt('value' in a ? a.value : a.permitted.amount) <= 0n) throw new InvalidRequestError('Deposit must be positive.')
}
export async function validateFunding(request: Request, channelId: Hex, funding: Funding, domain?: P.AuthorizationDomain, contractVerifier?: P.ContractVerifier): Promise<void> {
  assertFundingTerms(request, channelId, funding)
  const a = funding.authorization
  if (!await P.verifySigner(fundingTypedData(request, channelId, funding, domain), funding.signature, a.from, contractVerifier)) throw new SessionError('signer-mismatch', 402, 'Funding signer mismatch.')
}

