import { z, type Store } from 'mppx'
import type { Hex } from 'viem'
import { SessionError, SessionFundingPendingError, TransactionNotSubmittedError, TransactionOutcomeUnknownError, TransactionRevertedError } from '../protocol/Errors.js'
import * as P from '../protocol/Primitives.js'
import type * as S from '../protocol/Session.js'

const common = { channelId: P.Bytes32Schema, type: z.literal('hash') }
const DraftSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('open'), cumulativeAmount: P.Uint128Schema,
    signature: P.ContractSignatureSchema, salt: P.Bytes32Schema, authorizedSigner: P.AddressSchema }),
  z.object({ ...common, action: z.literal('topUp'), additionalDeposit: P.Uint128Schema }),
])
type Draft = z.infer<typeof DraftSchema>
const PendingSchema = z.object({ id: z.string(), binding: z.string(), draft: DraftSchema, hash: z.optional(P.Bytes32Schema) })
type Pending = z.infer<typeof PendingSchema>

export async function executeWalletFunding(parameters: {
  store: Store.AtomicStore
  key: string
  binding: string
  prepare: () => Promise<Draft> | Draft
  approve: () => Promise<void>
  submit: (draft: Draft, onPrepared: (hash: Hex) => Promise<void>) => Promise<Hex>
  confirm: (hash: Hex, draft: Draft) => Promise<void>
  onFunded?: ((payload: S.Payload) => Promise<void>) | undefined
}): Promise<S.Payload> {
  const { store, key, binding } = parameters
  const release = (id: string) => store.update(key, value => value !== null && PendingSchema.parse(value).id === id
    ? { op: 'delete', result: undefined }
    : { op: 'noop', result: undefined })
  const complete = async ({ id, draft, hash, binding: savedBinding }: Pending) => {
    if (savedBinding !== binding || !hash) throw new SessionFundingPendingError(draft.channelId, hash)
    try { await parameters.confirm(hash, draft) }
    catch (error) {
      if (error instanceof TransactionRevertedError || (error instanceof SessionError && error.code === 'transaction-reverted')) {
        await release(id)
        throw error instanceof TransactionRevertedError ? error : new TransactionRevertedError(hash)
      }
      throw new SessionFundingPendingError(draft.channelId, hash, error)
    }
    const payload = { ...draft, hash }
    try {
      await parameters.onFunded?.(payload)
      await release(id)
    } catch (error) { throw new SessionFundingPendingError(draft.channelId, hash, error) }
    return payload
  }

  const existing = await store.get(key)
  if (existing !== null) return complete(PendingSchema.parse(existing))
  const draft = DraftSchema.parse(await parameters.prepare())
  const pending: Pending = { id: crypto.randomUUID(), binding, draft }
  const reserved = await store.update(key, value => value === null
    ? { op: 'set', value: pending, result: pending }
    : { op: 'noop', result: PendingSchema.parse(value) })
  if (reserved.id !== pending.id) return complete(reserved)

  try { await parameters.approve() }
  catch (error) { await release(pending.id); throw error }

  let savedHash: Hex | undefined
  const remember = async (input: Hex) => {
    const hash = P.Bytes32Schema.parse(input)
    if (savedHash === hash) return
    if (savedHash) throw new SessionFundingPendingError(draft.channelId, savedHash, new Error('Wallet funding hash changed.'))
    try {
      await store.update(key, value => {
        if (value === null || PendingSchema.parse(value).id !== pending.id) throw new Error('Wallet funding reservation changed.')
        return { op: 'set', value: { ...pending, hash }, result: undefined }
      })
    } catch (error) { throw new SessionFundingPendingError(draft.channelId, hash, error) }
    savedHash = hash
  }

  let hash: Hex
  try { hash = P.Bytes32Schema.parse(await parameters.submit(draft, remember)) }
  catch (error) {
    if (error instanceof TransactionNotSubmittedError) { await release(pending.id); throw error }
    const submitted = savedHash ?? (error instanceof TransactionOutcomeUnknownError ? P.Bytes32Schema.safeParse(error.hash).data : undefined)
    if (submitted) await remember(submitted)
    throw new SessionFundingPendingError(draft.channelId, submitted, error)
  }
  await remember(hash)
  return complete({ ...pending, hash })
}
