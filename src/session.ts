import { randomBytes } from 'node:crypto'
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from 'viem'
import { getSessionEscrowAddress } from './config.js'
import { TransactionOutcomeUnknownError, TransactionRevertedError } from './protocol/Errors.js'
import * as P from './protocol/Primitives.js'
import type * as S from './protocol/Session.js'
import { session as clientSession, type SessionParameters } from './client/Session.js'
import { createSessionAdapter, createSessionRelayer, createSessionWallet, escrowAbi } from './tronweb/Session.js'
import { waitForReceipt, type ConfirmationOptions, type TronTransport } from './tronweb/Transport.js'

export type SubmissionHooks = {
  /** Persist a reservation after simulation succeeds and before broadcasting. */
  beforeSubmit?: () => void | Promise<void>
  /** Persist the hash before waiting for confirmation. */
  onSubmitted?: (hash: Hex) => void | Promise<void>
}
export type ConfiguredSessionOptions = ConfirmationOptions & { currency: string; permit2Contract: string }
const views = parseAbi([
  'function PERMIT2() view returns (address)', 'function allowedTokens(address) view returns (bool)',
  'function domainSeparator() view returns (bytes32)', 'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function approve(address,uint256) returns (bool)',
])

/** Node.js session operations bound once to the escrow in the SDK package's .env. */
export function createConfiguredSession(transport: TronTransport, options: ConfiguredSessionOptions) {
  const escrow = getSessionEscrowAddress(), chainId = P.ChainIdSchema.parse(transport.chainId)
  const currency = P.TokenAddressSchema.parse(options.currency), permit2 = P.normalizeAddress(options.permit2Contract)
  const adapter = createSessionAdapter(transport, escrow, options)
  let wallet: ReturnType<typeof createSessionWallet> | undefined
  const getWallet = () => wallet ??= createSessionWallet(transport, escrow, options)
  const submit = async (to: Address, data: Hex, hooks: SubmissionHooks = {}) => {
    await transport.call(to, data)
    await hooks.beforeSubmit?.()
    const hash = await transport.send(to, data)
    try { await hooks.onSubmitted?.(hash) }
    catch (cause) { throw new TransactionOutcomeUnknownError(hash, cause) }
    try { await waitForReceipt(transport, hash, options) }
    catch (cause) {
      if (cause instanceof TransactionRevertedError) throw cause
      if (cause instanceof TransactionOutcomeUnknownError && cause.hash === hash) throw cause
      throw new TransactionOutcomeUnknownError(hash, cause)
    }
    return hash
  }
  return {
    adapter,
    get wallet() { return getWallet() },
    /** Read-only deployment metadata for diagnostics. */
    metadata: Object.freeze({ chainId, escrowContract: escrow }),
    /** Includes the escrow so saved state cannot silently move to another deployment. */
    stateBinding(p: { serverUrl: string; recipient: string; payer: string }) {
      return JSON.stringify([chainId, p.serverUrl, currency, P.normalizeAddress(p.recipient), escrow, permit2, P.normalizeAddress(p.payer)])
    },
    assertRequest(request: S.Request) {
      if (request.methodDetails.chainId !== chainId || !P.isSameAddress(request.methodDetails.escrowContract, escrow)) {
        throw new Error('Session challenge does not match SDK escrow/network policy.')
      }
    },
    client(parameters: Omit<SessionParameters, 'chainIds' | 'currencies' | 'escrowContracts' | 'wallet'>): ReturnType<typeof clientSession> {
      return clientSession({ ...parameters, chainIds: [chainId], currencies: [currency], escrowContracts: [escrow], wallet: getWallet() })
    },
    computeChannelId(p: { payer: string; payee: string; salt: Hex; authorizedSigner?: string }) {
      return P.computeChannelId({ ...p, token: currency, chainId, escrowContract: escrow })
    },
    /** Merchant signs; the configured transport relays settlement and close. */
    serverAdapter(sign: P.TypedSigner): S.Adapter {
      const relay = createSessionRelayer(transport, escrow, options)
      const settle = async (action: 'settle' | 'close', channelId: Hex, cumulativeAmount: string, voucherSignature: Hex) => {
        const nonce = BigInt(`0x${randomBytes(32).toString('hex')}`).toString()
        const deadline = String(Math.floor(Date.now() / 1000) + 300)
        const payeeSignature = await sign(P.payeeAuthorizationTypedData({ action, chainId, escrowContract: escrow, channelId, cumulativeAmount, nonce, deadline }))
        return relay({ action, channelId, cumulativeAmount, nonce, deadline, voucherSignature, payeeSignature })
      }
      return { ...adapter, settle: (id, amount, signature) => settle('settle', id, amount, signature), close: (id, amount, signature) => settle('close', id, amount, signature) }
    },
    async inspect() {
      const [configured, allowed, gracePeriod, domain, permitDomain] = await Promise.all([
        transport.call(escrow, encodeFunctionData({ abi: views, functionName: 'PERMIT2' })),
        transport.call(escrow, encodeFunctionData({ abi: views, functionName: 'allowedTokens', args: [currency] })),
        adapter.gracePeriod(), transport.call(escrow, encodeFunctionData({ abi: views, functionName: 'domainSeparator' })),
        transport.call(permit2, encodeFunctionData({ abi: views, functionName: 'DOMAIN_SEPARATOR' })),
      ])
      if (!P.isSameAddress(decodeAbiParameters([{ type: 'address' }], configured)[0], permit2)) throw new Error('Escrow PERMIT2() does not match the configured Permit2 contract.')
      if (!decodeAbiParameters([{ type: 'bool' }], allowed)[0]) throw new Error('The escrow does not allow the configured currency.')
      if (!Number.isSafeInteger(gracePeriod) || gracePeriod < 900) throw new Error('Escrow close grace period must be at least 900 seconds.')
      const domainHash = (name: string, version?: string) => keccak256(encodeAbiParameters(
        version ? [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }] : [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        version ? [keccak256(toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), keccak256(toBytes(name)), keccak256(toBytes(version)), BigInt(chainId), escrow] : [keccak256(toBytes('EIP712Domain(string name,uint256 chainId,address verifyingContract)')), keccak256(toBytes(name)), BigInt(chainId), permit2],
      ))
      if (domain !== domainHash('EVM Payment Channel', '1') || permitDomain !== domainHash('Permit2')) throw new Error('Deployed signing domains do not match the configured network.')
      return { escrow, permit2, gracePeriod }
    },
    force(action: 'requestClose' | 'withdraw', channelId: Hex, hooks?: SubmissionHooks) {
      return submit(escrow, encodeFunctionData({ abi: escrowAbi, functionName: action, args: [channelId] }), hooks)
    },
    approve(amount: string, hooks?: SubmissionHooks) {
      return submit(currency, encodeFunctionData({ abi: views, functionName: 'approve', args: [permit2, BigInt(P.Uint128Schema.parse(amount))] }), hooks)
    },
  }
}
