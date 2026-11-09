import { createBase58check } from '@scure/base'
import { z } from 'mppx'
import {
  encodeAbiParameters, encodePacked, getAddress, hashTypedData, hexToBytes,
  keccak256, recoverTypedDataAddress, sha256,
  type Address, type Hex, type TypedDataDefinition,
} from 'viem'

const base58 = createBase58check((bytes: Uint8Array) => sha256(bytes, 'bytes'))
export const zeroAddress = `0x${'0'.repeat(40)}` as Address
export const chains = { mainnet: 728126428, nile: 3448148188, shasta: 2494104990 } as const

/** Exact domain name required by the session specification. */
const channelDomainName = 'EVM Payment Channel'
function channelDomain(chainId: number, escrowContract: string): TypedData['domain'] {
  return { name: channelDomainName, version: '1', chainId: ChainIdSchema.parse(chainId), verifyingContract: normalizeAddress(escrowContract) }
}

/** The same 20-byte account in TRON Base58Check, 41-prefixed hex, or 20-byte hex. */
export function normalizeAddress(value: string): Address {
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return getAddress(value.toLowerCase())
  if (/^(0x)?41[0-9a-fA-F]{40}$/.test(value)) return getAddress(`0x${value.replace(/^0x/, '').slice(2)}`.toLowerCase())
  const decoded = base58.decode(value)
  if (decoded.length !== 21 || decoded[0] !== 0x41) throw new Error('Invalid TRON address.')
  return getAddress(`0x${Array.from(decoded.slice(1), b => b.toString(16).padStart(2, '0')).join('')}`)
}

export function toBase58Address(value: string): string {
  return base58.encode(hexToBytes(`0x41${normalizeAddress(value).slice(2)}`))
}
export function isSameAddress(a: string, b: string): boolean { return normalizeAddress(a) === normalizeAddress(b) }
export function formatSource(payer: string, chainId: number): string {
  return `did:pkh:tron:${chainId}:${toBase58Address(payer)}`
}
export function parseSource(value: string | undefined, chainId: number): Address {
  const prefix = `did:pkh:tron:${chainId}:`
  if (!value?.startsWith(prefix)) throw new Error('Missing or wrong-chain TRON source.')
  return normalizeAddress(value.slice(prefix.length))
}
export const AddressSchema = z.pipe(z.string(), z.transform(normalizeAddress))
export const TokenAddressSchema = AddressSchema.check(z.refine(value => value !== zeroAddress))
export const Uint256Schema = z.string().check(z.regex(/^(0|[1-9]\d*)$/), z.refine(v => BigInt(v) < 1n << 256n))
export const Uint128Schema = Uint256Schema.check(z.refine(v => BigInt(v) < 1n << 128n))
export const Bytes32Schema = z.pipe(z.string().check(z.regex(/^0x[0-9a-fA-F]{64}$/)), z.transform(v => v.toLowerCase() as Hex))
export const SignatureSchema = z.pipe(z.string().check(z.regex(/^0x[0-9a-fA-F]{130}$/)), z.transform(v => {
  assertSignature(v as Hex)
  return v.toLowerCase() as Hex
}))
/** ERC-1271 wallets may use variable-length signatures. EOA verification still enforces canonical r/s/v. */
export const ContractSignatureSchema = z.pipe(z.string().check(z.regex(/^0x(?:[0-9a-fA-F]{2})+$/), z.maxLength(32770)), z.transform(v => v.toLowerCase() as Hex))
export const ChainIdSchema = z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER))

/** Canonical ECDSA: 65 bytes, v=27/28, nonzero r/s, low s. */
export function assertSignature(signature: Hex): void {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('Expected a 65-byte signature.')
  const r = BigInt(`0x${signature.slice(2, 66)}`)
  const s = BigInt(`0x${signature.slice(66, 130)}`)
  const v = Number.parseInt(signature.slice(130), 16)
  if (r === 0n || r >= 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n ||
      s === 0n || s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n ||
      (v !== 27 && v !== 28)) throw new Error('Noncanonical signature.')
}

export type TypedData = {
  domain: { name: string; version?: string; chainId: number; verifyingContract: Address }
  types: Record<string, readonly { name: string; type: string }[]>
  primaryType: string
  message: Record<string, unknown>
}
export type TypedSigner = (data: TypedData) => Promise<Hex>
export type ContractVerifier = (signer: Address, digest: Hex, signature: Hex) => Promise<boolean>
export function typedDataHash(data: TypedData): Hex {
  return hashTypedData(data as TypedDataDefinition)
}
export async function recoverSigner(data: TypedData, signature: Hex): Promise<Address> {
  assertSignature(signature)
  return recoverTypedDataAddress({ ...data, signature } as Parameters<typeof recoverTypedDataAddress>[0])
}
export async function verifySigner(data: TypedData, signature: Hex, signer: Address, contractVerifier?: ContractVerifier): Promise<boolean> {
  try { if (isSameAddress(await recoverSigner(data, signature), signer)) return true } catch { /* Try a contract wallet. */ }
  return contractVerifier ? contractVerifier(signer, typedDataHash(data), signature) : false
}
export function challengeHash(challenge: { id: string; realm: string }): Hex {
  return keccak256(encodePacked(['string', 'string'], [challenge.id, challenge.realm]))
}
export function computeChannelId(p: {
  payer: string; payee: string; token: string; salt: Hex; authorizedSigner?: string | undefined;
  escrowContract: string; chainId: number
}): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' },
      { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [normalizeAddress(p.payer), normalizeAddress(p.payee), normalizeAddress(p.token), Bytes32Schema.parse(p.salt),
      normalizeAddress(p.authorizedSigner ?? zeroAddress), normalizeAddress(p.escrowContract), BigInt(ChainIdSchema.parse(p.chainId))],
  ))
}
export function voucherTypedData(p: {
  chainId: number; escrowContract: string; channelId: Hex; cumulativeAmount: string
}): TypedData {
  return {
    domain: channelDomain(p.chainId, p.escrowContract),
    types: { Voucher: [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint128' }] },
    primaryType: 'Voucher',
    message: { channelId: Bytes32Schema.parse(p.channelId), cumulativeAmount: BigInt(Uint128Schema.parse(p.cumulativeAmount)) },
  }
}
export function payeeAuthorizationTypedData(p: {
  action: 'settle' | 'close'; chainId: number; escrowContract: string; channelId: Hex;
  cumulativeAmount: string; nonce: string; deadline: string
}): TypedData {
  const primaryType = p.action === 'settle' ? 'SettleAuthorization' : 'CloseAuthorization'
  return {
    domain: channelDomain(p.chainId, p.escrowContract),
    types: { [primaryType]: [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint128' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, primaryType,
    message: { channelId: Bytes32Schema.parse(p.channelId), cumulativeAmount: Uint128Schema.parse(p.cumulativeAmount), nonce: Uint256Schema.parse(p.nonce), deadline: Uint256Schema.parse(p.deadline) },
  }
}
export function authorizationNonce(p: { from: string; payee: string; token: string; salt: Hex; authorizedSigner?: string | undefined }): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }],
    [normalizeAddress(p.from), normalizeAddress(p.payee), normalizeAddress(p.token), p.salt, normalizeAddress(p.authorizedSigner ?? zeroAddress)],
  ))
}
export function topUpNonce(p: { channelId: Hex; additionalDeposit: string; from: string; salt: Hex }): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes32' }],
    [p.channelId, BigInt(Uint128Schema.parse(p.additionalDeposit)), normalizeAddress(p.from), p.salt],
  ))
}

export const TokenPermissions = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }] as const
export const PaymentWitness = [{ name: 'challengeHash', type: 'bytes32' }, { name: 'externalId', type: 'string' }] as const
// Canonical EIP-712 encoding: field separators contain no whitespace.
export const paymentWitnessTypeString = 'PaymentWitness witness)PaymentWitness(bytes32 challengeHash,string externalId)TokenPermissions(address token,uint256 amount)'
export const channelOpenWitnessTypeString = 'ChannelOpenWitness witness)ChannelOpenWitness(address payee,bytes32 salt,address authorizedSigner)TokenPermissions(address token,uint256 amount)'
export const channelTopUpWitnessTypeString = 'ChannelTopUpWitness witness)ChannelTopUpWitness(bytes32 channelId)TokenPermissions(address token,uint256 amount)'

export type AuthorizationDomain = { name: string; version: string }
export function transferAuthorizationTypedData(p: {
  chainId: number; token: string; domain: AuthorizationDomain;
  authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: Hex }
  receive?: boolean
}): TypedData {
  return {
    domain: { ...p.domain, chainId: p.chainId, verifyingContract: normalizeAddress(p.token) },
    primaryType: p.receive ? 'ReceiveWithAuthorization' : 'TransferWithAuthorization',
    types: { [p.receive ? 'ReceiveWithAuthorization' : 'TransferWithAuthorization']: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    message: { ...p.authorization, from: normalizeAddress(p.authorization.from), to: normalizeAddress(p.authorization.to) },
  }
}

export type Transfer = { to: Address; amount: string }
export type Settlement = { hash: Hex; timestamp?: string }
export type TokenState = { balance: bigint; allowance: bigint }
