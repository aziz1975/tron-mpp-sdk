import { decodeAbiParameters, decodeErrorResult, encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from 'viem'
import * as S from '../protocol/Session.js'
import { ContractCallRevertedError, InvalidRequestError, SessionError, SessionSimulationError, TransactionRevertedError, TransactionNotSubmittedError, TransactionOutcomeUnknownError } from '../protocol/Errors.js'
import * as P from '../protocol/Primitives.js'
import { logAddress, tokenAbi } from './Token.js'
import { createContractSignatureVerifier, waitForReceipt, transactionStatus, type TronTransport, type ConfirmationOptions } from './Transport.js'

export const escrowAbi = parseAbi([
  'function CLOSE_GRACE_PERIOD() view returns (uint256)',
  'function channels(bytes32) view returns (address payer,address payee,address token,address authorizedSigner,uint128 deposit,uint128 settled,uint64 closeRequestedAt,bool finalized)',
  'function open(address,address,uint128,bytes32,address) returns (bytes32)',
  'function topUp(bytes32,uint128)', 'function settle(bytes32,uint128,bytes)', 'function close(bytes32,uint128,bytes)',
  'function requestClose(bytes32)', 'function withdraw(bytes32)',
  'function settleWithAuthorization(bytes32,uint128,uint256,uint256,bytes,bytes)',
  'function closeWithAuthorization(bytes32,uint128,uint256,uint256,bytes,bytes)',
  'function openWithPermit2(address,address,uint128,bytes32,address,address,uint256,uint256,bytes) returns (bytes32)',
  'function topUpWithPermit2(bytes32,uint128,address,uint256,uint256,bytes)',
  'function openWithAuthorization(address,address,uint128,bytes32,address,address,uint256,uint256,bytes32,bytes) returns (bytes32)',
  'function topUpWithAuthorization(bytes32,uint128,address,bytes32,uint256,uint256,bytes32,bytes)',
])

const escrowErrors = parseAbi([
  'error AmountExceedsDeposit()', 'error ChannelNotFound()', 'error ChannelFinalized()', 'error InvalidSignature()',
  'error NotPayee()', 'error NotPayer()', 'error TokenTransferFailed()',
])
function simulationFailure(cause: unknown): Error {
  if (!(cause instanceof ContractCallRevertedError)) return new TransactionNotSubmittedError(cause)
  let name: string | undefined
  try { name = decodeErrorResult({ abi: escrowErrors, data: cause.data }).errorName } catch { /* Unknown revert uses the standard fallback. */ }
  const problem: Record<string, [string, number, string]> = {
    AmountExceedsDeposit: ['amount-exceeds-deposit', 402, 'Amount exceeds the channel deposit.'],
    ChannelNotFound: ['channel-not-found', 410, 'Channel not found.'],
    ChannelFinalized: ['channel-finalized', 410, 'Channel finalized.'],
    InvalidSignature: ['invalid-signature', 402, 'Signature invalid.'],
    NotPayee: ['signer-mismatch', 402, 'Caller is not the channel payee.'],
    NotPayer: ['signer-mismatch', 402, 'Caller is not the channel payer.'],
    TokenTransferFailed: ['insufficient-balance', 402, 'Token transfer failed.'],
  }
  const [code, status, detail] = problem[name ?? ''] ?? ['transaction-reverted', 409, 'Contract simulation reverted.']
  return new SessionSimulationError(code, status, detail)
}

export function createSessionAdapter(transport: TronTransport, escrowContract: string, options: ConfirmationOptions = {}): S.Adapter {
  const escrow = P.normalizeAddress(escrowContract)
  const confirm = async (hash: Hex) => {
    try { return await waitForReceipt(transport, hash, options) }
    catch (error) {
      if (error instanceof TransactionRevertedError) throw new SessionError(error.code, error.status, error.message)
      throw error
    }
  }
  const send = async (data: Hex): Promise<P.Settlement> => {
    try { await transport.call(escrow, data) }
    catch (cause) { throw simulationFailure(cause) }
    let hash: Hex
    try { hash = await transport.send(escrow, data) }
    catch (error) {
      if (error instanceof TransactionNotSubmittedError || error instanceof TransactionOutcomeUnknownError) throw error
      throw new TransactionOutcomeUnknownError(undefined, error)
    }
    try { await confirm(hash) }
    catch (error) {
      if (error instanceof SessionError && error.code === 'transaction-reverted') throw error
      throw new TransactionOutcomeUnknownError(hash, error)
    }
    return { hash }
  }
  return {
    chainId: transport.chainId, escrowContract: escrow,
    transactionStatus: hash => transactionStatus(transport, hash, options),
    async gracePeriod() { return Number(BigInt(await transport.call(escrow, encodeFunctionData({ abi: escrowAbi, functionName: 'CLOSE_GRACE_PERIOD' })))) },
    async channel(id) {
      const result = await transport.call(escrow, encodeFunctionData({ abi: escrowAbi, functionName: 'channels', args: [id] }))
      const decoded = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
        { type: 'uint128' }, { type: 'uint128' }, { type: 'uint64' }, { type: 'bool' }], result)
      if (P.isSameAddress(decoded[0], P.zeroAddress)) return null
      return { payer: decoded[0], payee: decoded[1], token: decoded[2], authorizedSigner: decoded[3],
        deposit: decoded[4].toString(), settled: decoded[5].toString(), closeRequestedAt: decoded[6].toString(), finalized: decoded[7] }
    },
    async verifyTransaction(hash, action, channelId, amount) {
      const info = await confirm(hash)
      const topic = keccak256(toBytes(action === 'open'
        ? 'ChannelOpened(bytes32,address,address,address,uint128)' : 'ChannelToppedUp(bytes32,uint128)')).slice(2)
      const found = (info.log ?? []).find(l => P.isSameAddress(logAddress(l.address), escrow) &&
        l.topics[0]?.replace(/^0x/, '').toLowerCase() === topic &&
        l.topics[1]?.replace(/^0x/, '').toLowerCase() === channelId.slice(2))
      if (!found) throw new InvalidRequestError('Transaction did not execute the expected escrow action for this channel.')
      if (amount !== undefined) {
        // Deposit amount is the final non-indexed word in both reference escrow events.
        const data = found.data.replace(/^0x/, '')
        if (data.length < 64 || BigInt(`0x${data.slice(-64)}`) !== BigInt(amount)) throw new InvalidRequestError('Escrow deposit event amount mismatch.')
      }
    },
    async fund(request, channelId, funding) {
      const a = funding.authorization
      const amount = BigInt('value' in a ? a.value : a.permitted.amount)
      let data: Hex
      if (funding.type === 'permit2' && 'permitted' in a) {
        data = funding.action === 'open'
          ? encodeFunctionData({ abi: escrowAbi, functionName: 'openWithPermit2', args: [request.recipient, request.currency, amount,
            funding.salt!, funding.authorizedSigner ?? P.zeroAddress, a.from, BigInt(a.nonce), BigInt(a.deadline), funding.signature] })
          : encodeFunctionData({ abi: escrowAbi, functionName: 'topUpWithPermit2', args: [channelId, amount, a.from, BigInt(a.nonce), BigInt(a.deadline), funding.signature] })
      } else if ('value' in a) {
        data = funding.action === 'open'
          ? encodeFunctionData({ abi: escrowAbi, functionName: 'openWithAuthorization', args: [request.recipient, request.currency, amount,
            funding.salt!, funding.authorizedSigner ?? P.zeroAddress, a.from, BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, funding.signature] })
          : encodeFunctionData({ abi: escrowAbi, functionName: 'topUpWithAuthorization', args: [channelId, amount, a.from, funding.salt!, BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, funding.signature] })
      } else throw new InvalidRequestError('Funding format mismatch.')
      return (await send(data)).hash
    },
    async close(id, cumulative, signature) { return send(encodeFunctionData({ abi: escrowAbi, functionName: 'close', args: [id, BigInt(cumulative), signature] })) },
    async settle(id, cumulative, signature) { return send(encodeFunctionData({ abi: escrowAbi, functionName: 'settle', args: [id, BigInt(cumulative), signature] })) },
    contractSignature: createContractSignatureVerifier(transport),
  }
}

/** Relayed payee operations use the escrow's shared nonce set across settle and close. */
export function createSessionRelayer(transport: TronTransport, escrowContract: string, options: ConfirmationOptions = {}) {
  return async (p: { action: 'settle' | 'close'; channelId: Hex; cumulativeAmount: string;
    nonce: string; deadline: string; payeeSignature: Hex; voucherSignature: Hex }): Promise<P.Settlement> => {
    const to = P.normalizeAddress(escrowContract)
    const data = encodeFunctionData({ abi: escrowAbi, functionName: p.action === 'settle' ? 'settleWithAuthorization' : 'closeWithAuthorization',
      args: [p.channelId, BigInt(P.Uint128Schema.parse(p.cumulativeAmount)), BigInt(P.Uint256Schema.parse(p.nonce)), BigInt(P.Uint256Schema.parse(p.deadline)), p.payeeSignature, p.voucherSignature] })
    try { await transport.call(to, data) }
    catch (cause) { throw simulationFailure(cause) }
    const hash = await transport.send(to, data)
    try { await waitForReceipt(transport, hash, options) }
    catch (error) {
      if (error instanceof TransactionRevertedError) throw new SessionError(error.code, error.status, error.message)
      throw new TransactionOutcomeUnknownError(hash, error)
    }
    return { hash }
  }
}

/** Explicit client-funded wallet operations. Each open/topUp performs an exact token approval. */
export function createSessionWallet(transport: TronTransport, escrowContract: string, options: ConfirmationOptions & { voucherSigner?: P.TypedSigner; authorizationDomain?: P.AuthorizationDomain } = {}) {
  const escrow = P.normalizeAddress(escrowContract)
  const adapter = createSessionAdapter(transport, escrow, options)
  const approve = async (token: Address, deposit: string) => {
    const hash = await transport.send(token, encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [escrow, BigInt(deposit)] }))
    await waitForReceipt(transport, hash, options)
  }
  const voucher = async (channelId: Hex, cumulativeAmount: string) => {
    const sign = options.voucherSigner ?? transport.signTypedData
    if (!sign) throw new InvalidRequestError('Wallet typed-data signing required.')
    return sign(P.voucherTypedData({ chainId: transport.chainId, escrowContract: escrow, channelId, cumulativeAmount }))
  }
  const open = async (request: S.Request, deposit: string, initialAmount: string, authorizedSigner = P.zeroAddress, guard = () => {}): Promise<S.Payload> => {
      guard()
      if (request.methodDetails.chainId !== transport.chainId || !P.isSameAddress(request.methodDetails.escrowContract, escrow)) throw new InvalidRequestError('Wallet network or escrow mismatch.')
      P.Uint128Schema.parse(deposit)
      P.Uint128Schema.parse(initialAmount)
      if (BigInt(deposit) <= 0n || BigInt(initialAmount) > BigInt(deposit)) throw new InvalidRequestError('Invalid deposit or initial voucher.')
      if (!transport.payer) throw new InvalidRequestError('Payer account required.')
      const salt = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')}` as Hex
      const id = P.computeChannelId({ payer: transport.payer, payee: request.recipient, token: request.currency, salt, authorizedSigner, escrowContract: escrow, chainId: transport.chainId })
      const signature = await voucher(id, initialAmount)
      guard()
      await approve(request.currency, deposit)
      guard()
      const hash = await transport.send(escrow, encodeFunctionData({ abi: escrowAbi, functionName: 'open', args: [request.recipient, request.currency, BigInt(deposit), salt, authorizedSigner] }))
      await adapter.verifyTransaction(hash, 'open', id, deposit)
      return { action: 'open', type: 'hash', channelId: id, hash, cumulativeAmount: initialAmount, signature, salt, authorizedSigner }
    }
  const topUp = async (request: S.Request, channelId: Hex, additionalDeposit: string, guard = () => {}): Promise<S.Payload> => {
      guard()
      if (request.methodDetails.chainId !== transport.chainId || !P.isSameAddress(request.methodDetails.escrowContract, escrow)) throw new InvalidRequestError('Wallet network or escrow mismatch.')
      P.Uint128Schema.parse(additionalDeposit)
      if (BigInt(additionalDeposit) === 0n) throw new InvalidRequestError('Deposit must be positive.')
      await approve(request.currency, additionalDeposit)
      guard()
      const hash = await transport.send(escrow, encodeFunctionData({ abi: escrowAbi, functionName: 'topUp', args: [channelId, BigInt(additionalDeposit)] }))
      await adapter.verifyTransaction(hash, 'topUp', channelId, additionalDeposit)
      return { action: 'topUp', type: 'hash', channelId, hash, additionalDeposit }
    }
  const signedFunding = async (request: S.Request, id: Hex, intent: S.FundingIntent, guard: () => void): Promise<S.Funding> => {
    S.assertFundingTerms(request, id, intent)
    if (!transport.payer || !P.isSameAddress(intent.authorization.from, transport.payer)) throw new InvalidRequestError('Funding wallet payer mismatch.')
    if (!transport.signTypedData) throw new InvalidRequestError('Funding typed-data signing required.')
    if (intent.type === 'permit2') {
      const configured = await transport.call(escrow, encodeFunctionData({ abi: parseAbi(['function PERMIT2() view returns (address)']), functionName: 'PERMIT2' }))
      const [address] = decodeAbiParameters([{ type: 'address' }], configured)
      if (!request.methodDetails.permit2Contract || !P.isSameAddress(address, request.methodDetails.permit2Contract)) throw new InvalidRequestError('Permit2 does not match the deployed escrow.')
    }
    guard()
    S.assertFundingTerms(request, id, intent)
    const signature = await transport.signTypedData(S.fundingTypedData(request, id, intent, options.authorizationDomain))
    return S.FundingSchema.parse({ ...intent, signature })
  }
  return {
    adapter,
    payer: transport.payer,
    open: (request: S.Request, deposit: string, initialAmount: string, authorizedSigner = P.zeroAddress) => open(request, deposit, initialAmount, authorizedSigner),
    topUp: (request: S.Request, channelId: Hex, additionalDeposit: string) => topUp(request, channelId, additionalDeposit),
    async createPayload(requestInput: S.Request, planInput: S.PaymentPlan, policy: S.ClientPolicy): Promise<S.Payload> {
      const request = S.RequestSchema.parse(requestInput)
      const plan = S.PaymentPlanSchema.parse(planInput)
      const guard = () => S.assertClientPolicy(plan, policy)
      guard()
      if (request.methodDetails.chainId !== transport.chainId || !P.isSameAddress(request.methodDetails.escrowContract, escrow)) throw new InvalidRequestError('Wallet network or escrow mismatch.')
      if ('type' in plan && !(request.methodDetails.credentialTypes ?? ['hash']).includes(plan.type)) throw new InvalidRequestError('Session credential type not advertised.')
      if (plan.action === 'open' && plan.type === 'hash') return open(request, plan.deposit, plan.cumulativeAmount, plan.authorizedSigner, guard)
      if (plan.action === 'topUp' && plan.type === 'hash') return topUp(request, plan.channelId, plan.additionalDeposit, guard)
      if (plan.action === 'open') {
        const a = plan.authorization
        if (BigInt(plan.cumulativeAmount) > BigInt('value' in a ? a.value : a.permitted.amount)) throw new InvalidRequestError('Initial voucher exceeds deposit.')
      }
      if (plan.action === 'voucher' || plan.action === 'close') {
        const deposit = plan.action === 'voucher' && plan.deposit ? await signedFunding(request, plan.channelId, plan.deposit, guard) : undefined
        guard()
        const signature = await voucher(plan.channelId, plan.cumulativeAmount)
        return S.PayloadSchema.parse({ ...plan, signature, ...(deposit ? { deposit } : {}) })
      }
      if (plan.action === 'topUp') {
        const a = plan.authorization
        if (plan.additionalDeposit !== ('value' in a ? a.value : a.permitted.amount)) throw new InvalidRequestError('TopUp amount mismatch.')
      }
      const funding = await signedFunding(request, plan.channelId, S.FundingIntentSchema.parse(plan), guard)
      if (plan.action === 'topUp') {
        return S.PayloadSchema.parse({ ...plan, signature: funding.signature })
      }
      guard()
      return S.PayloadSchema.parse({ ...plan, signature: funding.signature, voucherSignature: await voucher(plan.channelId, plan.cumulativeAmount) })
    },
    async voucher(channelId: Hex, cumulativeAmount: string): Promise<S.Payload> { return { action: 'voucher', channelId, cumulativeAmount, signature: await voucher(channelId, cumulativeAmount) } },
    async close(channelId: Hex, cumulativeAmount: string): Promise<S.Payload> { return { action: 'close', channelId, cumulativeAmount, signature: await voucher(channelId, cumulativeAmount) } },
    async requestClose(id: Hex) { const hash = await transport.send(escrow, encodeFunctionData({ abi: escrowAbi, functionName: 'requestClose', args: [id] })); await waitForReceipt(transport, hash, options); return hash },
    async withdraw(id: Hex) { const hash = await transport.send(escrow, encodeFunctionData({ abi: escrowAbi, functionName: 'withdraw', args: [id] })); await waitForReceipt(transport, hash, options); return hash },
  }
}
