import { Errors, Method, PaymentRequest, Receipt, Store } from 'mppx'
import { keccak256, toBytes, type Hex } from 'viem'
import * as S from '../protocol/Session.js'
import * as P from '../protocol/Primitives.js'
import { InvalidRequestError, SessionError, SessionSimulationError, TransactionNotSubmittedError, TransactionOutcomeUnknownError,
  TransactionRevertedError, parseInput, paymentBoundary } from '../protocol/Errors.js'
import { assertIssuedChallenge, challengeTransport } from './Challenges.js'
import { mergeChannel, SessionRepository, type SessionOperation, type SessionState } from './SessionStore.js'
export type { SessionState } from './SessionStore.js'

export type SessionParameters = {
  adapter: S.Adapter
  currency: string
  recipient: string
  authorizationDomain?: P.AuthorizationDomain
  credentialTypes?: readonly ('hash' | 'permit2' | 'authorization')[]
  permit2Contract?: string
  store: Store.AtomicStore
  chargeOnVerify?: boolean
  /** Maximum retained request IDs per channel. New IDs are rejected at the limit. Default: 10,000. */
  maxIdempotencyRecords?: number
  /** Records may be pruned only this long after finalization. Default: 24 hours. */
  requestRetentionMs?: number
}
function fail(code: string, status: number, detail: string): never { throw new SessionError(code, status, detail) }
function live(state: SessionState | null): asserts state is SessionState {
  if (!state) fail('channel-not-found', 410, 'Session accounting not initialized.')
  if (state.closed || state.closing) fail('channel-finalized', 410, 'Channel closing or closed.')
}
function definitiveFailure(error: unknown): boolean {
  return error instanceof TransactionRevertedError || error instanceof TransactionNotSubmittedError || error instanceof SessionSimulationError ||
    (error instanceof SessionError && error.code === 'transaction-reverted')
}

export class SessionManager {
  private readonly records: SessionRepository
  constructor(readonly parameters: SessionParameters) {
    P.TokenAddressSchema.parse(parameters.currency)
    if (typeof parameters.store.update !== 'function') throw new TypeError('An atomic session store is required.')
    const max = parameters.maxIdempotencyRecords ?? 10_000
    const retention = parameters.requestRetentionMs ?? 86_400_000
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('maxIdempotencyRecords must be a positive safe integer.')
    if (!Number.isSafeInteger(retention) || retention < 0) throw new RangeError('requestRetentionMs must be a nonnegative safe integer.')
    this.records = new SessionRepository(parameters.store,
      `tron:session:${parameters.adapter.chainId}:${P.normalizeAddress(parameters.adapter.escrowContract).toLowerCase()}`, max, retention)
  }
  private binding(request: S.Request) { return JSON.stringify([request.amount, request.currency, request.recipient, request.unitType ?? '', request.externalId ?? '', request.methodDetails.minVoucherDelta ?? '0']) }
  state(id: Hex): Promise<SessionState | null> {
    return paymentBoundary(() => this.records.read(parseInput(P.Bytes32Schema, id, 'channel ID')))
  }
  private source(value: string | undefined, chainId: number) {
    try { return P.parseSource(value, chainId) }
    catch (cause) { throw new InvalidRequestError('Missing or wrong-chain TRON source.', cause) }
  }
  private assertRequest(request: S.Request, id: Hex): void {
    const adapter = this.parameters.adapter
    if (request.methodDetails.chainId !== adapter.chainId || !P.isSameAddress(request.methodDetails.escrowContract, adapter.escrowContract) ||
        !P.isSameAddress(request.currency, this.parameters.currency) || !P.isSameAddress(request.recipient, this.parameters.recipient)) fail('challenge-not-found', 402, 'Session route mismatch.')
    if (request.methodDetails.channelId && request.methodDetails.channelId !== id) throw new InvalidRequestError('Resume channel mismatch.')
  }
  private async assertGrace(): Promise<void> {
    const grace = await this.parameters.adapter.gracePeriod()
    if (!Number.isSafeInteger(grace) || grace < 900) throw new Errors.InternalPaymentError({ cause: new Error('Escrow grace period must be at least 900 seconds.') })
  }
  private async channel(request: S.Request, id: Hex, allowPendingClose = false): Promise<S.Channel> {
    this.assertRequest(request, id)
    await this.assertGrace()
    const channel = await this.parameters.adapter.channel(id)
    if (!channel || P.isSameAddress(channel.payer, P.zeroAddress)) fail('channel-not-found', 410, 'Channel not found.')
    if (channel.finalized) fail('channel-finalized', 410, 'Channel finalized.')
    if (!allowPendingClose && channel.closeRequestedAt !== '0') fail('channel-finalized', 410, 'Channel has a pending forced close.')
    if (!P.isSameAddress(channel.payee, request.recipient) || !P.isSameAddress(channel.token, request.currency)) fail('channel-not-found', 410, 'Channel payee or token mismatch.')
    // Invalid node state is an infrastructure failure, not a bad client request.
    P.Uint128Schema.parse(channel.deposit)
    P.Uint128Schema.parse(channel.settled)
    if (BigInt(channel.settled) > BigInt(channel.deposit)) throw new Errors.InternalPaymentError()
    return channel
  }

  accept(requestInput: S.Request, payloadInput: S.Payload, source?: string): Promise<SessionState> {
    return paymentBoundary(() => this.acceptValidated(parseInput(S.RequestSchema, requestInput, 'session request'),
      parseInput(S.PayloadSchema, payloadInput, 'session payload'), source))
  }
  /** HTTP callers must also verify challenge issuance and route binding. */
  acceptRequest(challenge: S.Challenge, payloadInput: S.Payload, source?: string): Promise<SessionState> {
    return paymentBoundary(() => this.acceptValidated(parseInput(S.RequestSchema, challenge.request, 'session request'),
      parseInput(S.PayloadSchema, payloadInput, 'session payload'), source, challenge))
  }
  private async verifyVoucher(request: S.Request, payload: S.Payload, channel: S.Channel, deposit = channel.deposit): Promise<void> {
    if (payload.action === 'topUp') return
    const signature = payload.action === 'open' && payload.type !== 'hash' ? payload.voucherSignature : payload.signature
    const signer = P.isSameAddress(channel.authorizedSigner, P.zeroAddress) ? channel.payer : channel.authorizedSigner
    if (!await P.verifySigner(P.voucherTypedData({ ...request.methodDetails, channelId: payload.channelId, cumulativeAmount: payload.cumulativeAmount }),
      signature, signer, this.parameters.adapter.contractSignature)) fail('invalid-signature', 402, 'Voucher signature invalid.')
    if (BigInt(payload.cumulativeAmount) > BigInt(deposit)) fail('amount-exceeds-deposit', 402, 'Voucher exceeds deposit.')
  }
  private async acceptValidated(request: S.Request, payload: S.Payload, source?: string, challenge?: S.Challenge): Promise<SessionState> {
    const id = payload.channelId
    this.assertRequest(request, id)
    await this.assertGrace()
    let funding: S.Funding | undefined
    if ('type' in payload && payload.type !== 'hash') funding = parseInput(S.FundingSchema, payload, 'funding payload')
    if (payload.action === 'voucher') funding = payload.deposit
    if ('type' in payload && !(request.methodDetails.credentialTypes ?? ['hash']).includes(payload.type)) throw new InvalidRequestError('Credential format not advertised.')
    if (funding) {
      if (!(this.parameters.credentialTypes ?? ['hash']).includes(funding.type)) throw new InvalidRequestError('Funding capability not configured.')
      if (funding.type === 'permit2' && (!this.parameters.permit2Contract || !request.methodDetails.permit2Contract ||
          !P.isSameAddress(request.methodDetails.permit2Contract, this.parameters.permit2Contract))) throw new InvalidRequestError('Untrusted Permit2 contract.')
      if (!this.parameters.adapter.fund) throw new InvalidRequestError('Adapter has no sponsored funding support.')
      if (source && !P.isSameAddress(this.source(source, request.methodDetails.chainId), funding.authorization.from)) fail('signer-mismatch', 402, 'Funding source mismatch.')
    }
    const amount = funding ? ('value' in funding.authorization ? funding.authorization.value : funding.authorization.permitted.amount) : undefined
    if (payload.action === 'topUp' && funding && payload.additionalDeposit !== amount) throw new InvalidRequestError('TopUp amount mismatch.')
    // Check the intended channel, voucher and accounting before spending relayer fees.
    // A sponsored open supplies all participant/signer terms before the channel exists.
    const before: S.Channel = funding?.action === 'open'
      ? { payer: funding.authorization.from, payee: request.recipient, token: request.currency, authorizedSigner: funding.authorizedSigner ?? P.zeroAddress,
        deposit: amount!, settled: '0', closeRequestedAt: '0', finalized: false }
      : await this.channel(request, id, payload.action === 'close')
    const proposedDeposit = BigInt(before.deposit) + (funding?.action === 'topUp' ? BigInt(amount!) : 0n)
    if (proposedDeposit >= 1n << 128n) throw new InvalidRequestError('Deposit exceeds uint128.')
    if (source && funding?.action !== 'topUp' && !P.isSameAddress(this.source(source, request.methodDetails.chainId), before.payer)) fail('signer-mismatch', 402, 'Session source mismatch.')
    const previous = await this.state(id)
    if (previous) {
      live(previous)
      if (previous.binding !== this.binding(request)) throw new InvalidRequestError('Session terms changed.')
    }
    if (payload.action !== 'open' && !previous && funding?.action !== 'open') fail('channel-not-found', 410, 'Session accounting not initialized.')
    await this.verifyVoucher(request, payload, before, proposedDeposit.toString())
    if (payload.action === 'open' && proposedDeposit - BigInt(before.settled) < BigInt(request.amount)) fail('insufficient-balance', 402, 'Deposit does not cover one unit.')
    if (payload.action !== 'topUp') {
      const accepted = BigInt(previous?.acceptedCumulative ?? before.settled)
      const spent = BigInt(previous?.spent ?? before.settled)
      const cumulative = BigInt(payload.cumulativeAmount)
      if (payload.action === 'close' && cumulative < spent) fail('insufficient-balance', 402, 'Close voucher does not cover delivered service.')
      if (payload.action !== 'close' && cumulative > accepted && cumulative - accepted < BigInt(request.methodDetails.minVoucherDelta ?? '0')) fail('delta-too-small', 402, 'Voucher increment below minimum.')
      if (challenge && this.parameters.chargeOnVerify !== false && payload.action !== 'close' &&
          (cumulative > accepted ? cumulative : accepted) - spent < BigInt(request.amount)) fail('insufficient-balance', 402, 'Voucher does not cover one service unit.')
    }
    if (challenge) {
      const proof = payload.requestAuthorization
      if (!proof) fail('invalid-request-authorization', 402, 'A signed session request is required.')
      const signer = payload.action === 'topUp' ? funding?.authorization.from ?? before.payer
        : P.isSameAddress(before.authorizedSigner, P.zeroAddress) ? before.payer : before.authorizedSigner
      if (!await P.verifySigner(S.requestAuthorizationTypedData(challenge, payload, proof.nonce), proof.signature, signer,
        this.parameters.adapter.contractSignature)) fail('invalid-request-authorization', 402, 'Session request signature invalid.')
    }
    if (funding) await this.fund(request, id, funding, amount!)
    if ('type' in payload && payload.type === 'hash') {
      this.source(source, request.methodDetails.chainId)
      if (!(this.parameters.credentialTypes ?? ['hash']).includes('hash')) throw new InvalidRequestError('Hash funding not configured.')
      await this.parameters.adapter.verifyTransaction(payload.hash, payload.action, id,
        payload.action === 'topUp' ? payload.additionalDeposit : undefined)
    }
    const channel = await this.channel(request, id, payload.action === 'close')
    if (source && funding?.action !== 'topUp' && !P.isSameAddress(this.source(source, request.methodDetails.chainId), channel.payer)) fail('signer-mismatch', 402, 'Session source mismatch.')
    if (payload.action === 'open') {
      const expected = P.computeChannelId({ payer: channel.payer, payee: channel.payee, token: channel.token,
        salt: payload.salt, authorizedSigner: payload.authorizedSigner, escrowContract: request.methodDetails.escrowContract, chainId: request.methodDetails.chainId })
      if (expected !== id || !P.isSameAddress(channel.authorizedSigner, payload.authorizedSigner ?? P.zeroAddress)) throw new InvalidRequestError('Open channel identity mismatch.')
      if (BigInt(channel.deposit) - BigInt(channel.settled) < BigInt(request.amount)) fail('insufficient-balance', 402, 'Deposit does not cover one unit.')
    }
    if (payload.action === 'topUp') {
      // Receipt verification binds the exact event amount. Other calls may already
      // have observed this deposit, or additional deposits in a later snapshot.
      if (channel.deposit !== previous!.deposit && BigInt(channel.deposit) < BigInt(previous!.deposit) + BigInt(payload.additionalDeposit)) throw new InvalidRequestError('TopUp deposit increase mismatch.')
      return this.records.update(id, current => {
        live(current)
        if (current.binding !== this.binding(request)) throw new InvalidRequestError('Session terms changed.')
        const next = mergeChannel(current, channel)
        return { op: 'set', value: next, result: next }
      })
    }
    const signature = payload.action === 'open' && payload.type !== 'hash' ? payload.voucherSignature : payload.signature
    const cumulativeAmount = payload.cumulativeAmount
    await this.verifyVoucher(request, payload, channel)
    const binding = this.binding(request)
    const state = await this.records.update(id, current => {
      if (current) live(current)
      if (current && current.binding !== binding) throw new InvalidRequestError('Session terms changed.')
      const initial = mergeChannel(current ?? { version: 2, binding, acceptedCumulative: channel.settled, spent: channel.settled,
        settledOnChain: channel.settled, deposit: channel.deposit, signature, closed: false, closing: false, requestCount: 0 }, channel)
      if (BigInt(cumulativeAmount) <= BigInt(initial.acceptedCumulative)) return { op: 'set', value: initial, result: initial }
      if (payload.action !== 'close' && BigInt(cumulativeAmount) - BigInt(initial.acceptedCumulative) < BigInt(request.methodDetails.minVoucherDelta ?? '0')) fail('delta-too-small', 402, 'Voucher increment below minimum.')
      const next = { ...initial, acceptedCumulative: cumulativeAmount, signature }
      return { op: 'set', value: next, result: next }
    })
    if (payload.action !== 'close') return state
    return this.close(id, cumulativeAmount, signature)
  }

  private async fund(request: S.Request, id: Hex, funding: S.Funding, amount: string, recoverOnly = false): Promise<Hex> {
    const key = `${this.records.key(id)}:fund:${P.typedDataHash(S.fundingTypedData(request, id, funding, this.parameters.authorizationDomain))}`
    const binding = keccak256(toBytes(PaymentRequest.serialize(funding)))
    type FundingRecord = { id: string; status: 'pending' | 'submitted' | 'verified' | 'failed' | 'unknown'; hash?: Hex; binding?: Hex }
    const existing = await this.parameters.store.get(key) as FundingRecord | null
    if (recoverOnly && (!existing?.hash || existing.status === 'failed')) throw new TransactionOutcomeUnknownError()
    if (existing?.binding && existing.binding !== binding) throw new InvalidRequestError('Funding credential differs from the reserved authorization.')
    if (existing?.binding === binding && !existing.hash && existing.status !== 'failed') throw new TransactionOutcomeUnknownError()
    // Only the exact authorization validated before submission can recover its
    // saved hash after expiry. Legacy records still require full validation.
    if (!existing?.hash || existing.status === 'failed' || existing.binding !== binding) {
      await S.validateFunding(request, id, funding, this.parameters.authorizationDomain, this.parameters.adapter.contractSignature)
    }
    const operationId = crypto.randomUUID()
    const record = await this.parameters.store.update(key, (raw): Store.Change<unknown, { submit: boolean; hash: Hex | undefined; id: string }> => {
      const current = raw as FundingRecord | null
      if (current?.binding && current.binding !== binding) throw new InvalidRequestError('Funding credential differs from the reserved authorization.')
      if (raw === null || current?.status === 'failed') {
        if (recoverOnly) throw new TransactionOutcomeUnknownError()
        return { op: 'set', value: { id: operationId, status: 'pending', binding }, result: { submit: true, hash: undefined as Hex | undefined, id: operationId } }
      }
      if (current?.hash) return { op: 'noop', result: { submit: false, hash: current.hash, id: current.id } }
      throw new TransactionOutcomeUnknownError()
    })
    const save = (status: FundingRecord['status'], hash?: Hex) => this.parameters.store.update(key, raw => {
      const current = raw as FundingRecord | null
      if (!current || current.id !== record.id || (current.binding && current.binding !== binding)) return { op: 'noop', result: undefined }
      // A concurrent successful confirmation must never be regressed by an
      // older timeout or failure, nor may an old attempt overwrite a retry.
      if (current.status === 'verified') return { op: 'noop', result: undefined }
      return { op: 'set', value: { ...current, binding, status, ...(hash ? { hash } : {}) }, result: undefined }
    })
    let hash = record.hash
    try {
      if (record.submit) {
        hash = P.Bytes32Schema.parse(await this.parameters.adapter.fund!(request, id, funding))
        await save('submitted', hash)
      }
      await this.parameters.adapter.verifyTransaction(hash!, funding.action, id, amount)
      await save('verified', hash)
      return hash!
    } catch (error) {
      if (definitiveFailure(error)) {
        await save('failed', hash)
        throw error instanceof TransactionRevertedError ? new SessionError('transaction-reverted', 409, error.message) : error
      }
      hash ??= error instanceof TransactionOutcomeUnknownError ? error.hash : undefined
      await save('unknown', hash)
      throw new TransactionOutcomeUnknownError(hash, error)
    }
  }

  /** Confirm only an existing funding submission; never signs, broadcasts, or delivers service. */
  reconcileFunding(requestInput: S.Request, channelId: Hex, fundingInput: S.Funding): Promise<Hex> {
    return paymentBoundary(async () => {
      const request = parseInput(S.RequestSchema, requestInput, 'session request')
      const id = parseInput(P.Bytes32Schema, channelId, 'channel ID')
      const funding = parseInput(S.FundingSchema, fundingInput, 'funding payload')
      this.assertRequest(request, id)
      if (!(this.parameters.credentialTypes ?? ['hash']).includes(funding.type)) throw new InvalidRequestError('Funding capability not configured.')
      if (funding.type === 'permit2' && (!this.parameters.permit2Contract || !request.methodDetails.permit2Contract ||
          !P.isSameAddress(request.methodDetails.permit2Contract, this.parameters.permit2Contract))) throw new InvalidRequestError('Untrusted Permit2 contract.')
      const a = funding.authorization
      return this.fund(request, id, funding, 'value' in a ? a.value : a.permitted.amount, true)
    })
  }

  consume(requestInput: S.Request, channelId: Hex, units = 1, idempotencyKey?: string, options: { rejectReplay?: boolean } = {}): Promise<SessionState> {
    return paymentBoundary(async () => {
      const request = parseInput(S.RequestSchema, requestInput, 'session request')
      const id = parseInput(P.Bytes32Schema, channelId, 'channel ID')
      if (!Number.isSafeInteger(units) || units < 0) throw new InvalidRequestError('Units must be a nonnegative safe integer.')
      const channel = await this.channel(request, id)
      const cost = BigInt(request.amount) * BigInt(units)
      if (cost >= 1n << 128n) throw new InvalidRequestError('Service cost exceeds uint128.')
      return this.records.consume(id, this.binding(request), cost, channel.deposit, idempotencyKey, options.rejectReplay)
    })
  }
  private async reserve(id: Hex, kind: SessionOperation['kind'], amount?: string, signature?: Hex): Promise<SessionOperation> {
    const operationId = crypto.randomUUID()
    return this.records.update(id, current => {
      live(current)
      if (current.operation) fail('operation-in-progress', 409, 'An on-chain operation requires reconciliation.')
      const cumulativeAmount = amount ?? current.acceptedCumulative
      if (kind === 'close' && BigInt(cumulativeAmount) < BigInt(current.spent)) fail('insufficient-balance', 402, 'Close voucher does not cover delivered service.')
      if (kind === 'settle' && BigInt(cumulativeAmount) <= BigInt(current.settledOnChain)) fail('nothing-to-settle', 409, 'No voucher available to settle.')
      const operation: SessionOperation = { id: operationId, kind, status: 'pending', cumulativeAmount, signature: signature ?? current.signature }
      return { op: 'set', value: { ...current, operation, closing: kind === 'close' }, result: operation }
    })
  }
  private async finish(id: Hex, operation: SessionOperation | undefined, channel: S.Channel, hash?: Hex): Promise<SessionState> {
    return this.records.update(id, current => {
      if (!current) throw new Errors.InternalPaymentError()
      if (current.operation?.id !== operation?.id) return { op: 'noop', result: current }
      const { operation: _operation, ...rest } = mergeChannel(current, channel)
      const next: SessionState = { ...rest, closing: false, closed: current.closed || channel.finalized,
        ...(channel.finalized ? { closedAt: current.closedAt ?? Date.now() } : {}), ...(hash ? { txHash: hash } : {}) }
      return { op: 'set', value: next, result: next }
    })
  }
  private async operationFailed(id: Hex, operation: SessionOperation, error: unknown, hash?: Hex): Promise<never> {
    const failed = definitiveFailure(error)
    hash ??= error instanceof TransactionOutcomeUnknownError ? error.hash : undefined
    await this.records.update(id, current => {
      if (!current || current.operation?.id !== operation.id) return { op: 'noop', result: undefined }
      if (failed) {
        const { operation: _operation, ...rest } = current
        return { op: 'set', value: { ...rest, closing: false }, result: undefined }
      }
      return { op: 'set', value: { ...current, operation: { ...operation, status: 'unknown', ...(hash ? { hash } : {}) } }, result: undefined }
    })
    if (failed) throw error instanceof TransactionRevertedError ? new SessionError('transaction-reverted', 409, error.message) : error
    throw new TransactionOutcomeUnknownError(hash, error)
  }
  private async execute(id: Hex, operation: SessionOperation): Promise<{ state: SessionState; settlement: P.Settlement }> {
    let hash: Hex | undefined
    try {
      const settlement = await this.parameters.adapter[operation.kind](id, operation.cumulativeAmount, operation.signature)
      hash = P.Bytes32Schema.parse(settlement.hash)
      await this.records.update(id, current => current?.operation?.id === operation.id
        ? { op: 'set', value: { ...current, operation: { ...operation, hash } }, result: undefined }
        : { op: 'noop', result: undefined })
      const channel = await this.parameters.adapter.channel(id)
      if (!channel || (operation.kind === 'close' ? !channel.finalized : BigInt(channel.settled) < BigInt(operation.cumulativeAmount))) throw new TransactionOutcomeUnknownError(hash)
      return { state: await this.finish(id, operation, channel, hash), settlement }
    } catch (error) { return this.operationFailed(id, operation, error, hash) }
  }
  private async close(id: Hex, amount: string, signature: Hex): Promise<SessionState> {
    return (await this.execute(id, await this.reserve(id, 'close', amount, signature))).state
  }
  settle(channelId: Hex): Promise<P.Settlement> {
    return paymentBoundary(async () => {
      const id = parseInput(P.Bytes32Schema, channelId, 'channel ID')
      return (await this.execute(id, await this.reserve(id, 'settle'))).settlement
    })
  }
  /** Never resubmits. Only confirmed chain state or a mined revert resolves an uncertain operation. */
  reconcile(channelId: Hex): Promise<SessionState> {
    return paymentBoundary(async () => {
      const id = parseInput(P.Bytes32Schema, channelId, 'channel ID')
      const state = await this.state(id)
      if (!state) fail('channel-not-found', 410, 'Session not found.')
      const channel = await this.parameters.adapter.channel(id)
      if (!state.operation) return channel?.finalized ? this.finish(id, undefined, channel) : state
      const operation = state.operation
      if (channel && (channel.finalized || (operation.kind === 'settle' && BigInt(channel.settled) >= BigInt(operation.cumulativeAmount)))) return this.finish(id, operation, channel, operation.hash)
      if (operation.hash && this.parameters.adapter.transactionStatus &&
          await this.parameters.adapter.transactionStatus(operation.hash) === 'reverted') {
        await this.records.update(id, current => {
          if (!current || current.operation?.id !== operation.id) return { op: 'noop', result: undefined }
          const { operation: _operation, ...rest } = current
          return { op: 'set', value: { ...rest, closing: false }, result: undefined }
        })
      }
      return (await this.state(id))!
    })
  }
  pruneRequests(channelId: Hex, limit = 100): Promise<number> {
    return paymentBoundary(() => this.records.prune(parseInput(P.Bytes32Schema, channelId, 'channel ID'), limit))
  }
}

export function session(parameters: SessionParameters): Method.Server<typeof S.method, Pick<S.Request, 'currency' | 'recipient' | 'methodDetails'>> & { manager: SessionManager } {
  const manager = new SessionManager(parameters)
  const formats = [...(parameters.credentialTypes ?? ['hash'])]
  if (formats.some(f => f !== 'hash') && !parameters.adapter.fund) throw new Error('Sponsored funding requires an adapter.')
  if (formats.includes('permit2') && !parameters.permit2Contract) throw new Error('Configure TRON Permit2 address.')
  if (formats.includes('authorization') && !parameters.authorizationDomain) throw new Error('Configure EIP-3009 token domain.')
  const configured = Method.toServer<typeof S.method, Pick<S.Request, 'currency' | 'recipient' | 'methodDetails'>>(S.method, {
    transport: challengeTransport(parameters.store),
    defaults: { currency: P.TokenAddressSchema.parse(parameters.currency), recipient: P.normalizeAddress(parameters.recipient),
      methodDetails: { chainId: parameters.adapter.chainId, escrowContract: P.normalizeAddress(parameters.adapter.escrowContract),
        credentialTypes: formats, feePayer: formats.some(f => f !== 'hash'),
        ...(parameters.permit2Contract ? { permit2Contract: P.normalizeAddress(parameters.permit2Contract) } : {}) } },
    stableBinding: request => ({ ...request }),
    async verify({ credential, envelope }) {
      if (envelope) await assertIssuedChallenge(parameters.store, credential.challenge)
      const request = parseInput(S.RequestSchema, credential.challenge.request, 'session request')
      const payload = parseInput(S.PayloadSchema, credential.payload, 'session payload')
      let state = await manager.acceptRequest({ ...credential.challenge, request }, payload, credential.source)
      if (parameters.chargeOnVerify !== false && (payload.action === 'open' || payload.action === 'voucher')) state = await manager.consume(request, payload.channelId, 1,
        `http:${payload.requestAuthorization!.nonce}`, { rejectReplay: true })
      return Receipt.from({ method: 'tron', intent: 'session', status: 'success', reference: payload.channelId,
        timestamp: new Date().toISOString(), challengeId: credential.challenge.id, channelId: payload.channelId,
        acceptedCumulative: state.acceptedCumulative, spent: state.spent, chainId: request.methodDetails.chainId,
        ...(state.txHash ? { txHash: state.txHash } : {}) })
    },
    respond({ credential, receipt }) {
      if (parameters.chargeOnVerify === false || credential.payload.action === 'topUp' || credential.payload.action === 'close') return Response.json(receipt)
      return undefined
    },
  })
  return Object.assign(configured, { manager })
}

export function needVoucherEvent(parameters: { channelId: Hex; requiredCumulative: string; acceptedCumulative: string; deposit: string }): string {
  const data = { channelId: P.Bytes32Schema.parse(parameters.channelId), requiredCumulative: P.Uint128Schema.parse(parameters.requiredCumulative),
    acceptedCumulative: P.Uint128Schema.parse(parameters.acceptedCumulative), deposit: P.Uint128Schema.parse(parameters.deposit) }
  return `event: payment-need-voucher\ndata: ${JSON.stringify(data)}\n\n`
}
export function receiptEvent(receipt: Receipt.Receipt): string {
  return `event: payment-receipt\ndata: ${JSON.stringify(receipt)}\n\n`
}
