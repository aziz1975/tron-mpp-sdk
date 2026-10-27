import { z } from 'mppx'

export const paymentMethod = 'tron' as const
export const chargeIntent = 'charge' as const
export const sourceNamespace = 'tron' as const

export const nativeAssetType = 'native' as const
export const trc20AssetType = 'trc20' as const
export const transactionCredentialType = 'transaction' as const

export const tronAddressPattern = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
export const tronHexAddressPattern = /^41[0-9a-fA-F]{40}$/
export const transactionIdPattern = /^[0-9a-fA-F]{64}$/
export const atomicAmountPattern = /^\d+$/
export const DecimalsSchema = z.number().check(z.int(), z.minimum(0), z.maximum(255))

export const AtomicAmountSchema = z.string().check(z.regex(atomicAmountPattern, 'Invalid atomic amount'))
export type AtomicAmount = z.infer<typeof AtomicAmountSchema>

export const TronAddressSchema = z.string().check(z.regex(tronAddressPattern, 'Invalid TRON address'))
export type TronAddress = z.infer<typeof TronAddressSchema>

export const TronHexAddressSchema = z
  .string()
  .check(z.regex(tronHexAddressPattern, 'Invalid TRON hex address'))
export type TronHexAddress = z.infer<typeof TronHexAddressSchema>

export const TransactionIdSchema = z
  .string()
  .check(z.regex(transactionIdPattern, 'Invalid TRON transaction id'))
export type TransactionId = z.infer<typeof TransactionIdSchema>

export const NativeAssetSchema = z.object({
  decimals: z.optional(z.literal(6)),
  symbol: z.optional(z.literal('TRX')),
  type: z.literal(nativeAssetType),
})
export type NativeAsset = z.infer<typeof NativeAssetSchema>

export const Trc20AssetSchema = z.object({
  contractAddress: TronAddressSchema,
  decimals: DecimalsSchema,
  symbol: z.string().check(z.minLength(1)),
  type: z.literal(trc20AssetType),
})
export type Trc20Asset = z.infer<typeof Trc20AssetSchema>

export const AssetSchema = z.union([NativeAssetSchema, Trc20AssetSchema])
export type Asset = z.infer<typeof AssetSchema>

export const NormalizedNativeAssetSchema = z.object({
  decimals: z.literal(6),
  symbol: z.literal('TRX'),
  type: z.literal(nativeAssetType),
})
export type NormalizedNativeAsset = z.infer<typeof NormalizedNativeAssetSchema>

export const NormalizedAssetSchema = z.union([NormalizedNativeAssetSchema, Trc20AssetSchema])
export type NormalizedAsset = z.infer<typeof NormalizedAssetSchema>

export const MethodDetailsSchema = z.object({
  asset: NormalizedAssetSchema,
  minConfirmations: z.optional(z.number().check(z.int(), z.minimum(0))),
  network: z.string().check(z.minLength(1)),
})
export type MethodDetails = z.infer<typeof MethodDetailsSchema>

export const ChargeRequestSchema = z.object({
  amount: AtomicAmountSchema,
  currency: z.string().check(z.minLength(1)),
  description: z.optional(z.string()),
  externalId: z.optional(z.string()),
  methodDetails: MethodDetailsSchema,
  recipient: TronAddressSchema,
})
export type ChargeRequest = z.infer<typeof ChargeRequestSchema>

export const ChargeRequestInputSchema = z.object({
  amount: z.amount(),
  asset: AssetSchema,
  currency: z.optional(z.string().check(z.minLength(1))),
  decimals: z.optional(z.literal(6)),
  description: z.optional(z.string()),
  externalId: z.optional(z.string()),
  minConfirmations: z.optional(z.number().check(z.int(), z.minimum(0))),
  network: z.string().check(z.minLength(1)),
  recipient: TronAddressSchema,
})
export type ChargeRequestInput = z.infer<typeof ChargeRequestInputSchema>

export const TransactionPayloadSchema = z.object({
  payer: TronAddressSchema,
  signature: z.string().check(z.regex(/^(0x)?[0-9a-fA-F]{130}$/, 'Invalid payer signature')),
  txId: TransactionIdSchema,
  type: z.literal(transactionCredentialType),
})
export type TransactionPayload = z.infer<typeof TransactionPayloadSchema>

export const ChargePayloadSchema = TransactionPayloadSchema
export type ChargePayload = z.infer<typeof ChargePayloadSchema>

export type AssetInput = Asset

export type ChargeSigner = (parameters: {
  challengeId: string
  request: ChargeRequest
}) => Promise<TransactionPayload>

export type VerifiedPayment = {
  payer: TronAddress
  reference: TransactionId
  timestamp?: string | undefined
}

export type ChargeVerifier = (parameters: {
  credential: {
    payload: TransactionPayload
  }
  request: ChargeRequest
}) => Promise<VerifiedPayment>

export function normalizeAsset(asset: AssetInput, decimals?: number | undefined): NormalizedAsset {
  AssetSchema.parse(asset)
  if (asset.type === nativeAssetType) {
    if (decimals !== undefined && decimals !== 6) throw new Error('TRX requires 6 decimals.')
    return {
      decimals: 6,
      symbol: 'TRX',
      type: nativeAssetType,
    }
  }
  return asset
}

export function currencyOf(asset: NormalizedAsset): string {
  return asset.type === nativeAssetType ? 'TRX' : asset.contractAddress
}

export function assertCanonicalCurrency(request: ChargeRequest) {
  if (request.currency !== currencyOf(request.methodDetails.asset)) {
    throw new Error('TRON currency does not match the payment asset.')
  }
}

export function toSource(parameters: { address: TronAddress; network: string }) {
  return `did:pkh:${sourceNamespace}:${parameters.network}:${parameters.address}` as const
}

export function assertAtomicAmount(value: string, label: string) {
  if (!atomicAmountPattern.test(value)) throw new Error(`${label} must be an unsigned integer.`)
}

export function assertSameAddress(actual: string, expected: string, reason: string) {
  if (actual === expected) return
  throw new Error(reason)
}
