import { Errors, z, type Store } from 'mppx'
import { keccak256, toBytes, type Hex } from 'viem'
import * as P from '../protocol/Primitives.js'
import { InvalidRequestError, SessionError } from '../protocol/Errors.js'

const Count = z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER))
const RequestRecordSchema = z.object({
  id: P.Bytes32Schema, cost: P.Uint128Schema, createdAt: Count, previous: z.optional(P.Bytes32Schema),
})
export type RequestRecord = z.infer<typeof RequestRecordSchema>
const OperationSchema = z.object({
  id: z.string(), kind: z.enum(['close', 'settle']), status: z.enum(['pending', 'unknown']),
  cumulativeAmount: P.Uint128Schema, signature: P.ContractSignatureSchema, hash: z.optional(P.Bytes32Schema),
})
export type SessionOperation = z.infer<typeof OperationSchema>
const StateSchema = z.object({
  version: z.literal(2), binding: z.string(), acceptedCumulative: P.Uint128Schema, spent: P.Uint128Schema,
  settledOnChain: P.Uint128Schema, deposit: P.Uint128Schema, signature: P.ContractSignatureSchema,
  closed: z.boolean(), closing: z.boolean(), closedAt: z.optional(Count), txHash: z.optional(P.Bytes32Schema),
  requestCount: Count, requestHead: z.optional(P.Bytes32Schema), pendingRequest: z.optional(RequestRecordSchema),
  operation: z.optional(OperationSchema),
  pruning: z.optional(z.object({ id: P.Bytes32Schema, previous: z.optional(P.Bytes32Schema) })),
})
export type SessionState = z.infer<typeof StateSchema>
const LegacySchema = z.object({
  binding: z.string(), acceptedCumulative: P.Uint128Schema, spent: P.Uint128Schema,
  settledOnChain: P.Uint128Schema, deposit: P.Uint128Schema, signature: P.ContractSignatureSchema,
  closed: z.boolean(), closing: z.boolean(), requests: z.record(z.string(), P.Uint128Schema),
  txHash: z.optional(P.Bytes32Schema),
})

/** All state transitions keep deposit/settlement observations monotonic. */
export function mergeChannel(state: SessionState, channel: { deposit: string; settled: string }): SessionState {
  return {
    ...state,
    deposit: BigInt(state.deposit) > BigInt(channel.deposit) ? state.deposit : channel.deposit,
    settledOnChain: BigInt(state.settledOnChain) > BigInt(channel.settled) ? state.settledOnChain : channel.settled,
  }
}

export class SessionRepository {
  constructor(
    readonly store: Store.AtomicStore,
    private readonly prefix: string,
    readonly maxRequests: number,
    readonly retentionMs: number,
  ) {}

  key(id: Hex): string { return `${this.prefix}:${id}` }
  private requestKey(id: Hex, requestId: Hex): string { return `${this.key(id)}:request:${requestId}` }
  private decode(raw: unknown): SessionState {
    try { return StateSchema.parse(raw) }
    catch (cause) { throw new Errors.InternalPaymentError({ cause }) }
  }

  async read(id: Hex): Promise<SessionState | null> {
    const raw = await this.store.get(this.key(id))
    if (raw === null) return null
    if (typeof raw === 'object' && raw !== null && 'version' in raw) return this.decode(raw)
    // One-time migration. Records are durable before the old inline map is removed.
    let legacy: z.infer<typeof LegacySchema>
    try { legacy = LegacySchema.parse(raw) }
    catch (cause) { throw new Errors.InternalPaymentError({ cause }) }
    let head: Hex | undefined
    const entries = Object.entries(legacy.requests).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    for (const [key, cost] of entries) {
      const record: RequestRecord = { id: keccak256(toBytes(key)), cost, createdAt: 0, ...(head ? { previous: head } : {}) }
      await this.writeRequest(id, record)
      head = record.id
    }
    return this.store.update(this.key(id), current => {
      if (current === null) throw new Errors.InternalPaymentError()
      if (typeof current === 'object' && 'version' in current) return { op: 'noop', result: this.decode(current) }
      const latest = LegacySchema.parse(current)
      if (JSON.stringify(latest.requests) !== JSON.stringify(legacy.requests)) throw new Errors.InternalPaymentError()
      const { requests: _requests, ...rest } = latest
      const next: SessionState = {
        ...rest, version: 2, requestCount: entries.length, ...(head ? { requestHead: head } : {}),
        ...(latest.closed ? { closedAt: Date.now() } : {}),
        ...(latest.closing && !latest.closed ? { operation: {
          id: 'legacy-close', kind: 'close', status: 'unknown',
          cumulativeAmount: latest.acceptedCumulative, signature: latest.signature,
        } as SessionOperation } : {}),
      }
      return { op: 'set', value: next, result: next }
    })
  }

  async update<T>(id: Hex, fn: (state: SessionState | null) => Store.Change<SessionState, T>): Promise<T> {
    await this.read(id)
    return this.store.update(this.key(id), raw => fn(raw === null ? null : this.decode(raw)))
  }

  private async writeRequest(id: Hex, record: RequestRecord): Promise<void> {
    await this.store.update(this.requestKey(id, record.id), raw => {
      if (raw !== null) {
        const existing = RequestRecordSchema.parse(raw)
        if (existing.cost !== record.cost || existing.previous !== record.previous) throw new Errors.InternalPaymentError()
        return { op: 'noop', result: undefined }
      }
      return { op: 'set', value: record, result: undefined }
    })
  }

  /** Help complete a prior charge after a crash or failed record write. */
  async flushRequest(id: Hex): Promise<void> {
    const state = await this.read(id)
    if (!state?.pendingRequest) return
    const pending = state.pendingRequest
    await this.writeRequest(id, pending)
    await this.update(id, current => {
      if (!current || current.pendingRequest?.id !== pending.id) return { op: 'noop', result: undefined }
      const { pendingRequest: _pending, ...next } = current
      return { op: 'set', value: next, result: undefined }
    })
  }

  async consume(id: Hex, binding: string, cost: bigint, deposit: string, key?: string, rejectReplay = false): Promise<SessionState> {
    if (key !== undefined && (key.length === 0 || key.length > 1024)) throw new InvalidRequestError('Idempotency key must contain 1 to 1024 characters.')
    P.Uint128Schema.parse(cost.toString())
    const requestId = key === undefined ? undefined : keccak256(toBytes(key))
    for (;;) {
      await this.flushRequest(id)
      const snapshot = await this.read(id)
      if (!snapshot || snapshot.closed || snapshot.closing) throw new SessionError('channel-finalized', 410, 'Channel unavailable.')
      if (snapshot.binding !== binding) throw new InvalidRequestError('Session terms changed.')
      if (requestId) {
        const raw = await this.store.get(this.requestKey(id, requestId))
        if (raw !== null) {
          if (RequestRecordSchema.parse(raw).cost !== cost.toString()) throw new InvalidRequestError('Idempotency key reused with different cost.')
          if (rejectReplay) throw new SessionError('request-replayed', 409, 'This signed request has already been consumed.')
          // Check the channel again; a concurrent close must not grant service.
          return this.update(id, current => {
            if (!current || current.closed || current.closing) throw new SessionError('channel-finalized', 410, 'Channel unavailable.')
            return { op: 'noop', result: current }
          })
        }
      }
      const result = await this.update(id, current => {
        if (!current || current.closed || current.closing) throw new SessionError('channel-finalized', 410, 'Channel unavailable.')
        if (current.binding !== binding) throw new InvalidRequestError('Session terms changed.')
        // A different request may have been committed after our marker read.
        if (current.pendingRequest || current.requestCount !== snapshot.requestCount) return { op: 'noop', result: null }
        if (requestId && current.requestCount >= this.maxRequests) throw new SessionError('request-history-full', 409, 'Request history limit reached; close this channel before opening another.')
        const available = (BigInt(current.acceptedCumulative) < BigInt(deposit) ? BigInt(current.acceptedCumulative) : BigInt(deposit)) - BigInt(current.spent)
        if (available < cost) throw new SessionError('insufficient-balance', 402, 'Need a higher cumulative voucher.')
        const pending: RequestRecord | undefined = requestId ? {
          id: requestId, cost: cost.toString(), createdAt: Date.now(),
          ...(current.requestHead ? { previous: current.requestHead } : {}),
        } : undefined
        const next: SessionState = {
          ...current, spent: (BigInt(current.spent) + cost).toString(),
          ...(pending ? { requestCount: current.requestCount + 1, requestHead: pending.id, pendingRequest: pending } : {}),
        }
        return { op: 'set', value: next, result: next }
      })
      if (!result) continue
      await this.flushRequest(id)
      const { pendingRequest: _pending, ...committed } = result
      return committed
    }
  }

  /** Closed channels retain a tombstone; only their expired request records are deleted. */
  async prune(id: Hex, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new InvalidRequestError('Prune limit must be between 1 and 1000.')
    await this.flushRequest(id)
    let removed = 0
    for (let attempts = 0; attempts < limit; attempts++) {
      const state = await this.read(id)
      if (!state?.closed) throw new SessionError('channel-active', 409, 'Request records cannot be pruned from an active channel.')
      if (Date.now() - (state.closedAt ?? Date.now()) < this.retentionMs) return removed
      if (!state.pruning && !state.requestHead) return removed
      let pending = state.pruning
      if (!pending) {
        const raw = await this.store.get(this.requestKey(id, state.requestHead!))
        if (raw === null) {
          const latest = await this.read(id)
          if (latest?.pruning || latest?.requestHead !== state.requestHead) continue
          throw new Errors.InternalPaymentError()
        }
        const record = RequestRecordSchema.parse(raw)
        pending = await this.update(id, current => {
          if (!current) throw new Errors.InternalPaymentError()
          if (current.pruning) return { op: 'noop', result: current.pruning }
          if (current.requestHead !== record.id) return { op: 'noop', result: undefined }
          const value = { id: record.id, ...(record.previous ? { previous: record.previous } : {}) }
          return { op: 'set', value: { ...current, pruning: value }, result: value }
        })
        if (!pending) continue
      }
      await this.store.delete(this.requestKey(id, pending.id))
      const deleted = pending
      removed += await this.update(id, current => {
        if (!current || current.pruning?.id !== deleted.id) return { op: 'noop', result: 0 }
        const { pruning: _pruning, requestHead: _head, ...rest } = current
        return { op: 'set', value: { ...rest, requestCount: current.requestCount - 1,
          ...(deleted.previous ? { requestHead: deleted.previous } : {}) }, result: 1 }
      })
    }
    return removed
  }
}
