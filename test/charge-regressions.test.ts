import { Challenge, Credential, Errors, Receipt, Store } from 'mppx'
import { privateKeyToAccount } from 'viem/accounts'
import { encodeFunctionData, parseAbi, type Hex, type TypedDataDefinition } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as C from '../src/protocol/Charge.js'
import * as P from '../src/protocol/Primitives.js'
import { TransactionNotSubmittedError, TransactionOutcomeUnknownError, TransactionRevertedError } from '../src/protocol/Errors.js'
import { charge as clientCharge } from '../src/client/Charge.js'
import { charge as serverCharge } from '../src/server/Charge.js'
import { Mppx } from '../src/server/index.js'
import { createChargeAdapter } from '../src/tronweb/Charge.js'
import { verifyTransfers } from '../src/tronweb/Token.js'
import type { TronTransport } from '../src/tronweb/Transport.js'
import { createTronWebTransport } from '../src/tronweb/Transport.js'
import type { TronWeb } from 'tronweb'

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const token = P.normalizeAddress(`0x${'33'.repeat(20)}`)
const recipient = P.normalizeAddress(`0x${'44'.repeat(20)}`)
const permit2 = P.normalizeAddress(`0x${'55'.repeat(20)}`)
const hash = `0x${'aa'.repeat(32)}` as Hex
const chainId = P.chains.nile
const source = P.formatSource(account.address, chainId)
const journalKey = (id: string) => `tron:charge:challenge:${chainId}:${id}`
function challenge(type: C.CredentialType = 'transaction'): C.Challenge {
  return { id: 'charge-regression', realm: 'api.test', expires: new Date(Date.now() + 120_000).toISOString(), request: {
    amount: '100', currency: token, recipient, methodDetails: { chainId, credentialTypes: [type], permit2Address: permit2, spender: recipient },
  } }
}
function adapter() {
  return {
    chainId, payer: account.address,
    signTypedData: vi.fn((data: P.TypedData) => account.signTypedData(data as TypedDataDefinition)),
    tokenState: vi.fn(async () => ({ balance: 1000n, allowance: 1000n })), nonceUsed: vi.fn(async () => false),
    transactionPayer: vi.fn(async () => account.address),
    simulate: vi.fn(async (_c: C.Challenge, _p: C.Payload, _payer: P.Transfer['to']) => {}),
    submit: vi.fn(async (_c: C.Challenge, _p: Exclude<C.Payload, { type: 'hash' }>, _payer: P.Transfer['to']) => hash),
    verify: vi.fn(async (h: Hex, _r: C.Request, _payer?: P.Transfer['to']): Promise<P.Settlement> => ({ hash: h })),
    createTransaction: vi.fn(async (_r: C.Request, broadcast: boolean) => broadcast ? hash : '{"signed":"protobuf"}'),
  }
}
function client(a = adapter(), recipients: string[] = [recipient]) {
  return clientCharge({ adapter: a, chainIds: [chainId], currencies: [token], recipients, maxAtomicAmount: '100', permit2: { address: permit2, spender: recipient }, authorizationDomain: { name: 'Token', version: '2' } })
}
const echo = (c: C.Challenge) => ({ ...c, method: 'tron' as const, intent: 'charge' as const })
const transaction: C.Payload = { type: 'transaction', signature: '{"signed":"protobuf"}' }
function verification(c: C.Challenge, payload: C.Payload = transaction, payerSource: string | undefined = source) {
  return { credential: { challenge: echo(c), payload, ...(payerSource ? { source: payerSource } : {}) }, request: c.request }
}
function fixture(type: C.CredentialType = 'transaction', store: Store.AtomicStore = Store.memory()) {
  const a = adapter(), c = challenge(type)
  const parameters = { adapter: a, store, chainId, currency: token, recipient, credentialTypes: [type],
    permit2: { address: permit2, spender: recipient }, authorizationDomain: { name: 'Token', version: '2' } }
  return { a, c, store, parameters, method: serverCharge(parameters) }
}
afterEach(() => vi.useRealTimers())

describe('charge client payment policy', () => {
  it('requires a nonempty recipient allowlist', () => {
    expect(() => client(adapter(), [])).toThrow(/recipient/)
  })
  it.each(['permit2', 'authorization', 'transaction', 'hash'] as const)('rejects an unfamiliar primary recipient before any %s payment', async type => {
    const a = adapter(), c = challenge(type)
    c.request.recipient = other.address
    await expect(client(a).createCredential({ challenge: echo(c) })).rejects.toThrow(/recipient/)
    expect(a.signTypedData).not.toHaveBeenCalled()
    expect(a.createTransaction).not.toHaveBeenCalled()
  })
  it('rejects an unfamiliar split recipient before signing and accepts explicitly trusted splits', async () => {
    const a = adapter(), c = challenge('permit2')
    c.request.methodDetails.splits = [{ recipient: other.address, amount: '90' }]
    await expect(client(a).createCredential({ challenge: echo(c) })).rejects.toThrow(/recipient/)
    expect(a.signTypedData).not.toHaveBeenCalled()
    const header = await client(a, [P.toBase58Address(recipient), P.toBase58Address(other.address)]).createCredential({ challenge: echo(c) })
    const payload = C.Permit2PayloadSchema.parse(Credential.deserialize(header).payload)
    expect(payload.transferDetails.map(t => t.requestedAmount)).toEqual(['10', '90'])
  })
  it.each(['permit2', 'authorization', 'transaction', 'hash'] as const)('rejects expired %s challenges before signing or broadcasting', async type => {
    const a = adapter(), c = challenge(type)
    c.expires = new Date(Date.now() - 1).toISOString()
    await expect(client(a).createCredential({ challenge: echo(c) })).rejects.toThrow(/expired/)
    expect(a.signTypedData).not.toHaveBeenCalled()
    expect(a.createTransaction).not.toHaveBeenCalled()
  })
  it('rejects malformed expiry and expiry reached during preflight', async () => {
    const a = adapter(), c = challenge('permit2')
    c.expires = 'invalid'
    await expect(client(a).createCredential({ challenge: echo(c) })).rejects.toThrow(/expiry/)
    vi.useFakeTimers()
    const active = challenge('permit2')
    a.tokenState.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 121_000)
      return { balance: 1000n, allowance: 1000n }
    })
    await expect(client(a).createCredential({ challenge: echo(active) })).rejects.toThrow(/expired/)
    expect(a.signTypedData).not.toHaveBeenCalled()
  })
})

describe('charge settlement recovery', () => {
  it('recovers Permit2 settlement after its nonce was consumed and the token balance changed', async () => {
    const f = fixture('permit2')
    const header = await client(f.a).createCredential({ challenge: echo(f.c) })
    const payload = C.PayloadSchema.parse(Credential.deserialize(header).payload)
    f.a.verify.mockRejectedValueOnce(new TransactionOutcomeUnknownError(hash))
    await expect(f.method.verify(verification(f.c, payload))).rejects.toMatchObject({ status: 503 })
    f.a.nonceUsed.mockResolvedValue(true)
    f.a.tokenState.mockResolvedValue({ balance: 0n, allowance: 0n })
    await expect(serverCharge(f.parameters).verify(verification(f.c, payload))).resolves.toMatchObject({ reference: hash })
    expect(f.a.submit).toHaveBeenCalledTimes(1)
    expect(f.a.simulate).toHaveBeenCalledTimes(1)
  })
  it('rechecks a submitted hash after confirmation timeout across method recreation without broadcasting twice', async () => {
    const f = fixture()
    f.a.verify.mockRejectedValueOnce(new TransactionOutcomeUnknownError(hash))
    await expect(f.method.verify(verification(f.c))).rejects.toMatchObject({ status: 503, hash })
    await expect(serverCharge(f.parameters).verify(verification(f.c))).resolves.toMatchObject({ reference: hash })
    expect(f.a.submit).toHaveBeenCalledTimes(1)
    expect(f.a.simulate).toHaveBeenCalledTimes(1)
    expect(f.a.verify).toHaveBeenCalledTimes(2)
    await expect(f.method.verify(verification(f.c))).rejects.toMatchObject({ status: 402 })
  })
  it('saves the known hash from ambiguous submission and reconciles after challenge expiry', async () => {
    const f = fixture()
    f.a.submit.mockRejectedValueOnce(new TransactionOutcomeUnknownError(hash))
    await expect(f.method.verify(verification(f.c))).rejects.toMatchObject({ status: 503 })
    expect(await f.store.get(journalKey(f.c.id))).toMatchObject({ status: 'submitted', hash })
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 180_000)
    const receipt = await serverCharge(f.parameters).reconcile(f.c.id)
    expect(receipt).toMatchObject({ reference: hash, challengeId: f.c.id })
    expect(await f.method.reconcile(f.c.id)).toEqual(receipt)
    expect(f.a.submit).toHaveBeenCalledTimes(1)
    expect(f.a.verify).toHaveBeenCalledTimes(1)
  })
  it('retains an unknown submission without a hash and never broadcasts it again', async () => {
    const f = fixture()
    f.a.submit.mockRejectedValueOnce(new Error('timeout'))
    await expect(f.method.verify(verification(f.c))).rejects.toMatchObject({ status: 503 })
    await expect(f.method.verify(verification(f.c))).rejects.toMatchObject({ status: 503 })
    await expect(f.method.reconcile(f.c.id)).rejects.toMatchObject({ status: 503 })
    expect(f.a.submit).toHaveBeenCalledTimes(1)
  })
  it('releases a provably unsubmitted reservation so the same credential can retry', async () => {
    const f = fixture()
    f.a.submit.mockRejectedValueOnce(new TransactionNotSubmittedError())
    await expect(f.method.verify(verification(f.c))).rejects.toMatchObject({ status: 503 })
    expect(await f.store.get(journalKey(f.c.id))).toBeNull()
    await expect(f.method.verify(verification(f.c))).resolves.toMatchObject({ reference: hash })
    expect(f.a.submit).toHaveBeenCalledTimes(2)
  })
  it('rejects a different signed credential or source against a submitted payment', async () => {
    const f = fixture()
    f.a.verify.mockRejectedValueOnce(new TransactionOutcomeUnknownError(hash))
    await expect(f.method.verify(verification(f.c))).rejects.toMatchObject({ status: 503 })
    await expect(f.method.verify(verification(f.c, { type: 'transaction', signature: 'other transaction' }))).rejects.toThrow(/reserved/)
    await expect(f.method.verify(verification(f.c, transaction, P.formatSource(other.address, chainId)))).rejects.toThrow(/reserved/)
    expect(f.a.verify).toHaveBeenCalledTimes(1)
    expect(f.a.submit).toHaveBeenCalledTimes(1)
  })
  it('allows only one successful HTTP verification when concurrent retries reconcile the same hash', async () => {
    const f = fixture()
    f.a.verify.mockRejectedValueOnce(new TransactionOutcomeUnknownError(hash))
    await expect(f.method.verify(verification(f.c))).rejects.toMatchObject({ status: 503 })
    const results = await Promise.allSettled([f.method.verify(verification(f.c)), serverCharge(f.parameters).verify(verification(f.c))])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(f.a.submit).toHaveBeenCalledTimes(1)
  })
  it('recovers after the transaction claim was written but saving the settled journal failed', async () => {
    const backing = Store.memory()
    let interrupt = true
    const store: Store.AtomicStore = { ...backing, async update(key, fn) {
      return backing.update(key, current => {
        const change = fn(current)
        if (interrupt && key.startsWith('tron:charge:challenge:') && change.op === 'set' && (change.value as { status?: string }).status === 'settled') {
          interrupt = false
          throw new Error('storage interruption')
        }
        return change
      })
    } }
    const f = fixture('transaction', store)
    await expect(f.method.verify(verification(f.c))).rejects.toMatchObject({ status: 500 })
    await expect(serverCharge(f.parameters).verify(verification(f.c))).resolves.toMatchObject({ reference: hash })
    expect(f.a.submit).toHaveBeenCalledTimes(1)
  })
  it('does not release a charge with a confirmed reverted transaction or resubmit on reconciliation', async () => {
    const f = fixture()
    f.a.verify.mockRejectedValueOnce(new TransactionRevertedError())
    await expect(f.method.verify(verification(f.c))).rejects.toMatchObject({ status: 402 })
    await expect(f.method.reconcile(f.c.id)).rejects.toThrow(/reverted/)
    await expect(f.method.verify(verification(f.c))).rejects.toThrow(/reverted/)
    expect(f.a.submit).toHaveBeenCalledTimes(1)
  })
  it('honors legacy consumed transaction markers', async () => {
    const f = fixture('hash')
    await f.store.put(`tron:charge:transaction:${chainId}:${hash}`, Date.now())
    await expect(f.method.verify(verification(f.c, { type: 'hash', hash }))).rejects.toThrow(/consumed/)
    expect(f.a.verify).not.toHaveBeenCalled()
  })
  it('returns a generic infrastructure error when the replay store cannot be read', async () => {
    const backing = Store.memory()
    const f = fixture('transaction', { ...backing, get: async () => { throw new Error('private storage detail') } })
    await expect(f.method.verify(verification(f.c))).rejects.toMatchObject({ status: 500, message: 'An internal payment error occurred.' })
    expect(f.a.submit).not.toHaveBeenCalled()
  })
  it('atomically rejects the same transaction used against two distinct challenges', async () => {
    const f = fixture('hash')
    const results = await Promise.allSettled([
      f.method.verify(verification(f.c, { type: 'hash', hash })),
      f.method.verify(verification({ ...f.c, id: 'other-charge' }, { type: 'hash', hash })),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  })
  it('rejects a confirmed receipt mismatch as 402 instead of treating it as an RPC timeout', async () => {
    const f = fixture()
    f.a.verify.mockRejectedValueOnce(new Errors.VerificationFailedError({ reason: 'Wrong token transfer' }))
    await expect(f.method.verify(verification(f.c))).rejects.toMatchObject({ status: 402 })
    await expect(f.method.reconcile(f.c.id)).rejects.toThrow(/Wrong token transfer/)
    expect(f.a.submit).toHaveBeenCalledTimes(1)
  })
  it('preserves a known transaction hash in the error if saving submission state fails', async () => {
    const backing = Store.memory()
    const store: Store.AtomicStore = { ...backing, async update(key, fn) {
      return backing.update(key, current => {
        const change = fn(current)
        if (key.startsWith('tron:charge:challenge:') && change.op === 'set' && (change.value as { status?: string }).status === 'submitted') throw new Error('storage unavailable')
        return change
      })
    } }
    const f = fixture('transaction', store)
    await expect(f.method.verify(verification(f.c))).rejects.toMatchObject({ status: 503, hash })
    expect(f.a.submit).toHaveBeenCalledTimes(1)
  })
})

describe('optional charge source', () => {
  it.each(['permit2', 'authorization', 'transaction', 'hash'] as const)('accepts a valid %s credential without source', async type => {
    const f = fixture(type)
    const header = await client(f.a).createCredential({ challenge: echo(f.c) })
    const payload = C.PayloadSchema.parse(Credential.deserialize(header).payload)
    const options = verification(f.c, payload, '')
    await expect(f.method.verify(options)).resolves.toMatchObject({ reference: hash })
    if (type === 'hash') expect(f.a.verify).toHaveBeenCalledWith(hash, expect.anything(), undefined)
    else expect(f.a.submit).toHaveBeenCalledWith(expect.anything(), expect.anything(), account.address)
  })
  it('rejects a supplied source that conflicts with an EIP-3009 signer', async () => {
    const f = fixture('authorization')
    const header = await client(f.a).createCredential({ challenge: echo(f.c) })
    const payload = C.PayloadSchema.parse(Credential.deserialize(header).payload)
    await expect(f.method.verify(verification(f.c, payload, P.formatSource(other.address, chainId)))).rejects.toThrow(/mismatch/)
    expect(f.a.submit).not.toHaveBeenCalled()
  })
  it('checks token/to/amount without source and still enforces a supplied payer on hash receipts', () => {
    const topic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const word = (address: string) => address.slice(2).padStart(64, '0')
    const info = { log: [{ address: token.slice(2), topics: [topic, word(other.address), word(recipient)], data: (100n).toString(16).padStart(64, '0') }] }
    verifyTransfers(info, token, undefined, [{ to: recipient, amount: '100' }])
    expect(() => verifyTransfers(info, token, account.address, [{ to: recipient, amount: '100' }])).toThrow()
    expect(() => verifyTransfers(info, token, undefined, [{ to: recipient, amount: '101' }])).toThrow()
  })
  it('recovers transaction owners through the charge adapter', async () => {
    const t = { chainId, inspectTransaction: vi.fn(async () => ({ hash, from: account.address, to: token, data: encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [recipient, 100n] }) })) } as unknown as TronTransport
    expect(await createChargeAdapter(t).transactionPayer!('{}')).toBe(account.address)
    expect(t.inspectTransaction).toHaveBeenCalledWith('{}')
  })
})

describe('signed transaction submission outcomes', () => {
  it.each(['timeout', 'duplicate', 'rejected'] as const)('classifies a %s broadcast and retains its known hash when uncertain', async outcome => {
    const sendRawTransaction = outcome === 'timeout'
      ? vi.fn(async () => { throw new Error('RPC timeout') })
      : vi.fn(async () => ({ result: false, code: outcome === 'duplicate' ? 'DUP_TRANSACTION_ERROR' : 'SIGERROR' }))
    const wallet = { defaultAddress: { base58: P.toBase58Address(account.address) }, trx: { sendRawTransaction } } as unknown as TronWeb
    const t = createTronWebTransport(wallet, { chainId })
    const result = t.broadcast(JSON.stringify({ txID: hash.slice(2) }))
    if (outcome === 'rejected') await expect(result).rejects.toBeInstanceOf(TransactionNotSubmittedError)
    else await expect(result).rejects.toMatchObject({ status: 503, hash })
  })
  it('retains an inspected transaction hash when a custom broadcast transport throws an unclassified error', async () => {
    const data = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [recipient, 100n] })
    const t = { chainId, inspectTransaction: async () => ({ hash, from: account.address, to: token, data }),
      broadcast: async () => { throw new Error('RPC disconnected') } } as unknown as TronTransport
    await expect(createChargeAdapter(t).submit(challenge(), transaction, account.address)).rejects.toMatchObject({ status: 503, hash })
  })
})

describe('charge HTTP error responses', () => {
  async function httpFixture() {
    const f = fixture('hash')
    const server = Mppx.create({ secretKey: '0123456789abcdef0123456789abcdef', methods: [f.method] })
    const route = server.charge({ amount: '100' })
    const initial = await route(new Request('https://api.test/paid'))
    if (initial.status !== 402) throw new Error('Expected challenge')
    const c = Challenge.fromResponse(initial.challenge)
    const makeRequest = (payload: unknown) => new Request('https://api.test/paid', { headers: { Authorization: Credential.serialize(Credential.from({ challenge: c, payload })) } })
    return { ...f, route, c, makeRequest }
  }
  it('returns 402 malformed-credential with a fresh challenge and no receipt', async () => {
    const f = await httpFixture()
    const result = await f.route(f.makeRequest({ type: 'hash', hash: 'invalid' }))
    if (result.status !== 402) throw new Error('Expected rejection')
    expect(result.challenge.status).toBe(402)
    expect(result.challenge.headers.get('Content-Type')).toContain('application/problem+json')
    expect(result.challenge.headers.has('Payment-Receipt')).toBe(false)
    expect(Challenge.fromResponse(result.challenge).id).not.toBe(f.c.id)
    expect(await result.challenge.json()).toMatchObject({ type: 'https://paymentauth.org/problems/malformed-credential', status: 402 })
    expect(f.a.submit).not.toHaveBeenCalled()
  })
  it('returns 402 verification-failed for a reverted hash payment without consuming its challenge', async () => {
    const f = await httpFixture()
    f.a.verify.mockRejectedValueOnce(new TransactionRevertedError())
    const result = await f.route(f.makeRequest({ type: 'hash', hash }))
    if (result.status !== 402) throw new Error('Expected rejection')
    expect(result.challenge.status).toBe(402)
    expect(result.challenge.headers.has('Payment-Receipt')).toBe(false)
    expect(await result.challenge.json()).toMatchObject({ type: 'https://paymentauth.org/problems/verification-failed', status: 402 })
    expect(await f.store.get(journalKey(f.c.id))).toBeNull()
  })
  it('returns 402 verification-failed and a fresh challenge on replay without granting access twice', async () => {
    const f = await httpFixture()
    const accepted = await f.route(f.makeRequest({ type: 'hash', hash }))
    if (accepted.status !== 200) throw new Error('Expected success')
    expect(Receipt.fromResponse(accepted.withReceipt(new Response('paid')))).toMatchObject({ reference: hash })
    const replay = await f.route(f.makeRequest({ type: 'hash', hash }))
    if (replay.status !== 402) throw new Error('Expected rejection')
    expect(replay.challenge.status).toBe(402)
    expect(replay.challenge.headers.has('Payment-Receipt')).toBe(false)
    expect(Challenge.fromResponse(replay.challenge).id).not.toBe(f.c.id)
    expect(await replay.challenge.json()).toMatchObject({ type: 'https://paymentauth.org/problems/verification-failed', status: 402 })
  })
  it('recovers the same submitted credential over HTTP after a confirmation timeout', async () => {
    const f = fixture()
    f.a.verify.mockRejectedValueOnce(new TransactionOutcomeUnknownError(hash))
    const server = Mppx.create({ secretKey: '0123456789abcdef0123456789abcdef', methods: [f.method] })
    const route = server.charge({ amount: '100' })
    const initial = await route(new Request('https://api.test/paid'))
    if (initial.status !== 402) throw new Error('Expected challenge')
    const c = Challenge.fromResponse(initial.challenge)
    const header = Credential.serialize(Credential.from({ challenge: c, payload: transaction, source }))
    const makeRequest = () => new Request('https://api.test/paid', { headers: { Authorization: header } })
    const uncertain = await route(makeRequest())
    if (uncertain.status !== 402) throw new Error('Expected unresolved submission')
    expect(uncertain.challenge.status).toBe(503)
    expect(uncertain.challenge.headers.has('Payment-Receipt')).toBe(false)
    const recovered = await route(makeRequest())
    if (recovered.status !== 200) throw new Error('Expected successful recovery')
    expect(Receipt.fromResponse(recovered.withReceipt(new Response('paid')))).toMatchObject({ reference: hash, challengeId: c.id })
    expect(f.a.submit).toHaveBeenCalledTimes(1)
  })
})
