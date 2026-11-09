import { Errors, Method, PaymentRequest, Receipt, Store, z } from 'mppx'
import { keccak256, toBytes, type Address, type Hex } from 'viem'
import * as C from '../protocol/Charge.js'
import * as P from '../protocol/Primitives.js'
import { paymentBoundary, TransactionNotSubmittedError, TransactionOutcomeUnknownError, TransactionRevertedError } from '../protocol/Errors.js'
import { assertIssuedChallenge, challengeTransport } from './Challenges.js'

export type ChargeParameters = {
  adapter: C.Adapter
  chainId: number
  currency: string
  recipient: string
  credentialTypes?: readonly C.CredentialType[]
  permit2?: { address: string; spender: string }
  authorizationDomain?: P.AuthorizationDomain
  store?: Store.AtomicStore
}
type Defaults = Pick<C.Request, 'currency' | 'recipient' | 'methodDetails'>
const JournalSchema = z.object({
  version: z.literal(1), binding: P.Bytes32Schema,
  status: z.enum(['pending', 'submitted', 'settled', 'failed']),
  challenge: z.object({ id: z.string(), realm: z.string(), expires: z.optional(z.string()), request: C.RequestSchema }),
  payer: z.optional(P.AddressSchema), hash: z.optional(P.Bytes32Schema), receipt: z.optional(Receipt.Schema), failure: z.optional(z.string()),
})
type Journal = z.infer<typeof JournalSchema>
export type ChargeMethod = Method.Server<typeof C.method, Defaults> & {
  /** Confirm a saved submission without broadcasting. Does not run a protected handler. */
  reconcile: (challengeId: string) => Promise<Receipt.Receipt>
}
function readJournal(value: unknown): Journal {
  const result = JournalSchema.safeParse(value)
  if (!result.success) throw new Errors.InternalPaymentError({ cause: result.error })
  return result.data
}
const rejected = (reason: string) => new Errors.VerificationFailedError({ reason })

export function charge(parameters: ChargeParameters): ChargeMethod {
  const adapter = parameters.adapter
  if (adapter.chainId !== parameters.chainId) throw new Error('Adapter chainId mismatch.')
  const credentialTypes = [...(parameters.credentialTypes ?? ['transaction', 'hash'])]
  if (credentialTypes.includes('permit2') && !parameters.permit2) throw new Error('Configure a TRON Permit2 contract and spender.')
  if (credentialTypes.includes('authorization') && !parameters.authorizationDomain) throw new Error('Configure the EIP-3009 token domain.')
  const store = parameters.store ?? Store.memory()
  if (typeof store.update !== 'function') throw new Error('An atomic replay store is required.')
  const defaults = {
    currency: P.TokenAddressSchema.parse(parameters.currency), recipient: P.normalizeAddress(parameters.recipient),
    methodDetails: { chainId: parameters.chainId, credentialTypes,
      ...(parameters.permit2 ? { permit2Address: P.normalizeAddress(parameters.permit2.address), spender: P.normalizeAddress(parameters.permit2.spender) } : {}) },
  }
  const journalKey = (id: string) => `tron:charge:challenge:${adapter.chainId}:${id}`
  const transactionKey = (hash: Hex) => `tron:charge:transaction:${adapter.chainId}:${hash}`
  function assertTerms(request: C.Request) {
    if (request.methodDetails.chainId !== adapter.chainId || !P.isSameAddress(request.currency, parameters.currency) || !P.isSameAddress(request.recipient, parameters.recipient)) throw rejected('Configured charge terms mismatch.')
  }
  async function markSubmitted(key: string, binding: Hex, hash: Hex): Promise<void> {
    try {
      await store.update(key, value => {
        const current = readJournal(value)
        if (current.binding !== binding) throw rejected('Payment credential does not match the reserved charge.')
        return current.status === 'pending'
          ? { op: 'set', value: { ...current, status: 'submitted', hash }, result: undefined }
          : { op: 'noop', result: undefined }
      })
    } catch (error) { throw new TransactionOutcomeUnknownError(hash, error) }
  }
  async function finish(key: string, journal: Journal, verified?: P.Settlement): Promise<Receipt.Receipt> {
    if (!journal.hash) throw new TransactionOutcomeUnknownError()
    const hash = journal.hash
    let result: P.Settlement
    try { result = verified ?? await adapter.verify(hash, journal.challenge.request, journal.payer) }
    catch (error) {
      if (error instanceof TransactionRevertedError || error instanceof Errors.VerificationFailedError) {
        const failure = error instanceof TransactionRevertedError ? 'Charge transaction reverted.' : error.message
        await store.update(key, value => {
          const current = readJournal(value)
          return current.status === 'submitted' && current.binding === journal.binding
            ? { op: 'set', value: { ...current, status: 'failed', failure }, result: undefined }
            : { op: 'noop', result: undefined }
        })
        throw rejected(failure)
      }
      throw new TransactionOutcomeUnknownError(hash, error)
    }
    if (result.hash !== hash) throw new Errors.InternalPaymentError()
    // Keep an owner on the transaction claim so a crash between the two writes
    // can resume. Legacy transaction markers are still treated as consumed.
    const claimed = await store.update(transactionKey(hash), current => {
      if (current === null) return { op: 'set', value: { challengeId: journal.challenge.id, binding: journal.binding }, result: true }
      const owner = current as { challengeId?: unknown; binding?: unknown }
      return { op: 'noop', result: owner.challengeId === journal.challenge.id && owner.binding === journal.binding }
    })
    if (!claimed) throw rejected('Transaction has already been consumed.')
    const receipt = Receipt.from({ method: 'tron', status: 'success', reference: hash,
      timestamp: result.timestamp ?? new Date().toISOString(), challengeId: journal.challenge.id,
      chainId: adapter.chainId, ...(journal.challenge.request.externalId !== undefined ? { externalId: journal.challenge.request.externalId } : {}) })
    const settled = await store.update(key, value => {
      const current = readJournal(value)
      return current.status === 'submitted' && current.binding === journal.binding && current.hash === hash
        ? { op: 'set', value: { ...current, status: 'settled', receipt }, result: true }
        : { op: 'noop', result: false }
    })
    if (!settled) throw rejected('Challenge already used or settlement completed concurrently.')
    return receipt
  }
  const method = Method.toServer<typeof C.method, Defaults>(C.method, {
    defaults,
    transport: challengeTransport(store),
    stableBinding: request => ({ amount: request.amount, currency: request.currency, recipient: request.recipient,
      externalId: request.externalId ?? '', methodDetails: request.methodDetails }),
    async verify({ credential, envelope }) {
      let paymentReserved = false
      try {
        if (envelope) await paymentBoundary(() => assertIssuedChallenge(store, credential.challenge))
        const request = C.RequestSchema.parse(credential.challenge.request)
        const parsedPayload = C.PayloadSchema.safeParse(credential.payload)
        if (!parsedPayload.success) throw new Errors.MalformedCredentialError({ reason: 'Malformed payment payload' })
        const payload = parsedPayload.data
        const challenge = { ...credential.challenge, request }
        const key = journalKey(challenge.id)
        assertTerms(request)
        C.assertType(request, payload.type)
        if (!credentialTypes.includes(payload.type)) throw new Error('Unconfigured credential type.')
        if (payload.type === 'permit2' && (!parameters.permit2 || !request.methodDetails.permit2Address || !request.methodDetails.spender ||
            !P.isSameAddress(request.methodDetails.permit2Address, parameters.permit2.address) || !P.isSameAddress(request.methodDetails.spender, parameters.permit2.spender))) throw new Error('Untrusted Permit2 contract or spender.')
        const saved = await paymentBoundary(() => store.get(key))
        const previous = saved === null ? undefined : readJournal(saved)
        // source is optional: EOA permits recover their signer, authorizations
        // carry from, and signed transactions can recover their validated owner.
        // Hash credentials need only the receipt's token/to/amount evidence.
        let payer: Address | undefined
        if (credential.source !== undefined) payer = P.parseSource(credential.source, adapter.chainId)
        else if (previous?.payer) payer = previous.payer
        else if (payload.type === 'authorization') payer = payload.from
        else if (payload.type === 'permit2') payer = await P.recoverSigner(C.permitTypedData(challenge, payload), payload.signature)
        else if (payload.type === 'transaction') {
          if (!adapter.transactionPayer) throw new Error('Adapter must recover the transaction owner when source is omitted.')
          payer = await adapter.transactionPayer(payload.signature)
        }
        const binding = keccak256(toBytes(PaymentRequest.serialize({
          id: challenge.id, realm: challenge.realm, expires: challenge.expires ?? '', request, payload, payer: payer ?? '',
        })))
        if (previous) {
          if (previous.binding !== binding) throw rejected('Payment credential does not match the reserved charge.')
          if (previous.status === 'settled') throw rejected('Challenge already used.')
          if (previous.status === 'failed') throw rejected(previous.failure ?? 'Charge verification failed.')
          if (previous.status === 'pending') throw new TransactionOutcomeUnknownError()
          // Terms/signature were validated before this exact credential was
          // reserved. Do not recheck consumed nonces, balance, or simulate it.
          paymentReserved = true
          return await finish(key, previous)
        }
        if (payload.type === 'hash' && await paymentBoundary(() => store.get(transactionKey(payload.hash))) !== null) throw rejected('Transaction has already been consumed.')
        await C.validatePayload({ challenge, payload, payer, authorizationDomain: parameters.authorizationDomain, contractSignature: adapter.contractSignature })
        if (payload.type === 'permit2' || payload.type === 'authorization') {
          const state = await adapter.tokenState(request.currency, payer!, request.methodDetails.permit2Address)
          if (state.balance < BigInt(request.amount)) throw new Error('Insufficient token balance.')
          if (payload.type === 'permit2' && (state.allowance < BigInt(request.amount) ||
              await adapter.nonceUsed(request.methodDetails.permit2Address!, payer!, BigInt(payload.permit.nonce)))) throw new Error('Insufficient approval or used nonce.')
        }
        if (payload.type !== 'hash') await adapter.simulate(challenge, payload, payer!)
        // A rejected hash must not consume its challenge; this path cannot broadcast.
        const verifiedHash = payload.type === 'hash' ? await adapter.verify(payload.hash, request, payer) : undefined
        C.assertChallengeActive(challenge)
        const journal: Journal = { version: 1, status: 'pending', binding,
          challenge: { id: challenge.id, realm: challenge.realm, request, ...(challenge.expires ? { expires: challenge.expires } : {}) },
          ...(payer ? { payer } : {}) }
        const reserved = await paymentBoundary(() => store.update(key, current => current === null
          ? { op: 'set', value: journal, result: true }
          : { op: 'noop', result: false }))
        if (!reserved) throw new TransactionOutcomeUnknownError()
        paymentReserved = true
        // Preserve known hashes on ambiguous submission errors, and only release
        // a reservation when the transport proves no transaction was submitted.
        let hash: Hex
        try { hash = payload.type === 'hash' ? payload.hash : P.Bytes32Schema.parse(await adapter.submit(challenge, payload, payer!)) }
        catch (error) {
          if (error instanceof TransactionNotSubmittedError) {
            await store.update(key, value => {
              const current = readJournal(value)
              return current.binding === binding && current.status === 'pending'
                ? { op: 'delete', result: undefined } : { op: 'noop', result: undefined }
            })
            throw error
          }
          if (error instanceof TransactionOutcomeUnknownError && error.hash) await markSubmitted(key, binding, P.Bytes32Schema.parse(error.hash))
          throw error instanceof TransactionOutcomeUnknownError ? error : new TransactionOutcomeUnknownError(undefined, error)
        }
        await markSubmitted(key, binding, hash)
        return await finish(key, { ...journal, status: 'submitted', hash }, verifiedHash)
      } catch (error) {
        if (error instanceof TransactionRevertedError) throw rejected('Charge transaction reverted.')
        if (error instanceof Errors.PaymentError) throw error
        if (paymentReserved) throw new Errors.InternalPaymentError({ cause: error })
        throw new Errors.VerificationFailedError({ reason: error instanceof Error ? error.message : 'Invalid TRON credential' })
      }
    },
  })
  return Object.assign(method, {
    async reconcile(challengeId: string): Promise<Receipt.Receipt> {
      try {
        const key = journalKey(challengeId)
        const value = await store.get(key)
        if (value === null) throw new Errors.InvalidChallengeError({ id: challengeId, reason: 'No saved charge' })
        const journal = readJournal(value)
        if (journal.challenge.id !== challengeId) throw new Errors.InternalPaymentError()
        assertTerms(journal.challenge.request)
        if (journal.status === 'settled' && journal.receipt) return journal.receipt
        if (journal.status === 'failed') throw rejected(journal.failure ?? 'Charge verification failed.')
        if (journal.status !== 'submitted') throw new TransactionOutcomeUnknownError()
        return await finish(key, journal)
      } catch (error) {
        if (error instanceof Errors.PaymentError) throw error
        throw new Errors.InternalPaymentError({ cause: error })
      }
    },
  })
}
