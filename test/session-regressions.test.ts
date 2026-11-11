import { Challenge, Credential, Errors, Store } from 'mppx'
import { privateKeyToAccount } from 'viem/accounts'
import type { TronWeb } from 'tronweb'
import type { Hex, TypedDataDefinition } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import * as P from '../src/index.js'
import * as S from '../src/protocol/Session.js'
import { SessionManager, type SessionParameters } from '../src/server/Session.js'
import { Mppx, tron } from '../src/server/index.js'
import { createTronWebTransport, createSessionAdapter, type TronTransport, waitForReceipt } from '../src/tronweb/index.js'

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const token = P.normalizeAddress(`0x${'33'.repeat(20)}`)
const recipient = P.normalizeAddress(`0x${'44'.repeat(20)}`)
const escrow = P.normalizeAddress(`0x${'66'.repeat(20)}`)
const hash = `0x${'aa'.repeat(32)}` as Hex
const salt = `0x${'bb'.repeat(32)}` as Hex
const chainId = P.chains.nile
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
function fixture(options: Partial<SessionParameters> = {}) {
  const request: S.Request = { amount: '1', currency: token, recipient, methodDetails: { chainId, escrowContract: escrow } }
  const channelId = P.computeChannelId({ payer: account.address, payee: recipient, token, salt, escrowContract: escrow, chainId })
  const chain: S.Channel = { payer: account.address, payee: recipient, token, authorizedSigner: P.zeroAddress, deposit: '100', settled: '0', closeRequestedAt: '0', finalized: false }
  const adapter: S.Adapter = { chainId, escrowContract: escrow, gracePeriod: async () => 900, channel: vi.fn(async () => ({ ...chain })), verifyTransaction: vi.fn(async () => {}),
    close: vi.fn(async (_id, amount) => { chain.finalized = true; chain.settled = amount; return { hash } }),
    settle: vi.fn(async (_id, amount) => { chain.settled = amount; return { hash } }) }
  const store = options.store ?? Store.memory()
  const parameters = { adapter, currency: token, recipient, store, ...options }
  const manager = new SessionManager(parameters)
  const voucher = async (amount = '100'): Promise<Extract<S.Payload, { action: 'voucher' }>> => ({ action: 'voucher', channelId, cumulativeAmount: amount,
    signature: await account.signTypedData(P.voucherTypedData({ chainId, escrowContract: escrow, channelId, cumulativeAmount: amount }) as TypedDataDefinition) })
  const open = async () => manager.accept(request, { ...await voucher(), action: 'open', type: 'hash', hash, salt }, P.formatSource(account.address, chainId))
  const stateKey = `tron:session:${chainId}:${escrow.toLowerCase()}:${channelId}`
  return { request, channelId, chain, adapter, store, manager, voucher, open, stateKey, parameters }
}

describe('concurrent channel observations', () => {
  it.each(['deposit', 'settled'] as const)('does not let an older voucher regress %s', async field => {
    const f = fixture()
    await f.open()
    const captured = gate(), resume = gate()
    const read = f.adapter.channel
    f.adapter.channel = vi.fn(async id => { const snapshot = await read(id); captured.resolve(); await resume.promise; return snapshot })
    const delayed = f.manager.accept(f.request, await f.voucher('90'))
    await captured.promise
    f.adapter.channel = read
    if (field === 'deposit') {
      f.chain.deposit = '120'
      await f.manager.accept(f.request, { action: 'topUp', type: 'hash', hash, channelId: f.channelId, additionalDeposit: '20' }, P.formatSource(account.address, chainId))
    } else await f.manager.settle(f.channelId)
    resume.resolve()
    await delayed
    expect(await f.manager.state(f.channelId)).toMatchObject(field === 'deposit' ? { deposit: '120' } : { settledOnChain: '100' })
  })
  it('preserves a newer voucher accepted while settlement is in flight', async () => {
    const f = fixture(); await f.open()
    const started = gate(), resume = gate()
    f.adapter.settle = vi.fn(async (_id, amount) => { started.resolve(); await resume.promise; f.chain.settled = amount; return { hash } })
    const settlement = f.manager.settle(f.channelId)
    await started.promise
    await expect(f.manager.settle(f.channelId)).rejects.toMatchObject({ status: 409 })
    f.chain.deposit = '120'
    await f.manager.accept(f.request, await f.voucher('120'))
    resume.resolve(); await settlement
    expect(await f.manager.state(f.channelId)).toMatchObject({ acceptedCumulative: '120', deposit: '120', settledOnChain: '100' })
    expect(f.adapter.settle).toHaveBeenCalledTimes(1)
  })
})

describe('safe operation recovery', () => {
  it.each([
    new P.TransactionRevertedError(), new P.SessionError('transaction-reverted', 409, 'Reverted'), new P.TransactionNotSubmittedError(),
  ])('unlocks a close after a definitive failure: $title', async failure => {
    const f = fixture(); await f.open()
    const close = f.adapter.close
    f.adapter.close = vi.fn(async () => { throw failure })
    await expect(f.manager.accept(f.request, { ...await f.voucher(), action: 'close' })).rejects.toMatchObject({ status: failure.status })
    expect(await f.manager.state(f.channelId)).toMatchObject({ closed: false, closing: false })
    expect((await f.manager.state(f.channelId))!.operation).toBeUndefined()
    await f.manager.consume(f.request, f.channelId)
    f.adapter.close = close
    expect((await f.manager.accept(f.request, { ...await f.voucher(), action: 'close' })).closed).toBe(true)
  })
  it('retains an unknown close across restart and reconciles without rebroadcast', async () => {
    const f = fixture(); await f.open()
    f.adapter.close = vi.fn(async () => { throw new P.TransactionOutcomeUnknownError(hash) })
    await expect(f.manager.accept(f.request, { ...await f.voucher(), action: 'close' })).rejects.toMatchObject({ status: 503, hash })
    const manager = new SessionManager(f.parameters)
    expect((await manager.reconcile(f.channelId)).closing).toBe(true)
    await expect(manager.consume(f.request, f.channelId)).rejects.toMatchObject({ status: 410 })
    await expect(manager.accept(f.request, { ...await f.voucher(), action: 'close' })).rejects.toMatchObject({ status: 410 })
    f.chain.finalized = true; f.chain.settled = '100'
    f.adapter.transactionStatus = async () => 'pending'
    expect((await manager.reconcile(f.channelId)).closing).toBe(true)
    f.adapter.transactionStatus = async () => 'success'
    expect(await manager.reconcile(f.channelId)).toMatchObject({ closed: true, closing: false, txHash: hash })
    expect(f.adapter.close).toHaveBeenCalledTimes(1)
  })
  it('unlocks only after a known transaction is confirmed reverted', async () => {
    const f = fixture(); await f.open()
    f.adapter.close = async () => { throw new P.TransactionOutcomeUnknownError(hash) }
    await expect(f.manager.accept(f.request, { ...await f.voucher(), action: 'close' })).rejects.toMatchObject({ status: 503 })
    f.adapter.transactionStatus = async () => 'pending'
    expect((await f.manager.reconcile(f.channelId)).closing).toBe(true)
    f.adapter.transactionStatus = async () => 'reverted'
    expect((await f.manager.reconcile(f.channelId)).closing).toBe(false)
    await f.manager.consume(f.request, f.channelId)
  })
  it('keeps settlement reserved while its observed chain state is unconfirmed', async () => {
    const f = fixture(); await f.open()
    f.adapter.settle = async () => { throw new P.TransactionOutcomeUnknownError(hash) }
    await expect(f.manager.settle(f.channelId)).rejects.toMatchObject({ status: 503 })
    f.chain.settled = '100'
    f.adapter.transactionStatus = async () => 'pending'
    expect(await f.manager.reconcile(f.channelId)).toMatchObject({ settledOnChain: '0', operation: { status: 'unknown' } })
    f.adapter.transactionStatus = async () => 'success'
    expect(await f.manager.reconcile(f.channelId)).toMatchObject({ settledOnChain: '100', closed: false })
    expect((await f.manager.state(f.channelId))!.operation).toBeUndefined()
  })
  it('treats unclassified adapter exceptions as uncertain', async () => {
    const f = fixture(); await f.open()
    f.adapter.close = async () => { throw new Error('Connection lost after submission') }
    await expect(f.manager.accept(f.request, { ...await f.voucher(), action: 'close' })).rejects.toMatchObject({ status: 503 })
    expect(await f.manager.state(f.channelId)).toMatchObject({ closing: true, operation: { status: 'unknown' } })
  })
})

describe('sponsored funding recovery', () => {
  async function sponsored() {
    const permit2 = P.normalizeAddress(`0x${'55'.repeat(20)}`)
    const f = fixture({ credentialTypes: ['permit2'], permit2Contract: permit2 })
    f.request.methodDetails.credentialTypes = ['permit2']
    f.request.methodDetails.permit2Contract = permit2
    f.request.methodDetails.feePayer = true
    const unsigned = { action: 'open' as const, type: 'permit2' as const, salt,
      authorization: { from: account.address, permitted: { token, amount: '100' }, nonce: '1', deadline: String(Math.floor(Date.now() / 1000) + 300),
        witness: { payee: recipient, salt, authorizedSigner: P.zeroAddress } }, signature: '0x' as Hex }
    const funding = { ...unsigned, signature: await account.signTypedData(S.fundingTypedData(f.request, f.channelId, unsigned) as TypedDataDefinition) }
    const payload: S.Payload = { ...funding, channelId: f.channelId, cumulativeAmount: '100', voucherSignature: (await f.voucher()).signature }
    return { ...f, payload }
  }
  it('retries confirmed failed funding, then verifies the saved hash on replay', async () => {
    const f = await sponsored()
    f.adapter.fund = vi.fn().mockRejectedValueOnce(new P.TransactionRevertedError()).mockResolvedValue(hash)
    await expect(f.manager.accept(f.request, f.payload)).rejects.toMatchObject({ status: 409 })
    await f.manager.accept(f.request, f.payload)
    await new SessionManager(f.parameters).accept(f.request, f.payload)
    expect(f.adapter.fund).toHaveBeenCalledTimes(2)
  })
  it('recovers a known hash without submitting the authorization twice', async () => {
    const f = await sponsored()
    f.adapter.fund = vi.fn(async () => { throw new P.TransactionOutcomeUnknownError(hash) })
    await expect(f.manager.accept(f.request, f.payload)).rejects.toMatchObject({ status: 503, hash })
    await new SessionManager(f.parameters).accept(f.request, f.payload)
    expect(f.adapter.fund).toHaveBeenCalledTimes(1)
    expect(f.adapter.verifyTransaction).toHaveBeenCalledWith(hash, 'open', f.channelId, '100')
  })
  it('retains a reservation when submission failed without a known outcome or hash', async () => {
    const f = await sponsored()
    f.adapter.fund = vi.fn(async () => { throw new Error('Lost connection') })
    await expect(f.manager.accept(f.request, f.payload)).rejects.toMatchObject({ status: 503 })
    await expect(new SessionManager(f.parameters).accept(f.request, f.payload)).rejects.toMatchObject({ status: 503 })
    expect(f.adapter.fund).toHaveBeenCalledTimes(1)
  })
})

describe('bounded durable request history', () => {
  it('keeps the channel record constant in size and rejects new IDs at the limit without charging', async () => {
    const f = fixture({ maxIdempotencyRecords: 20 }); await f.open()
    await f.manager.consume(f.request, f.channelId, 1, 'first')
    const size = JSON.stringify(await f.store.get(f.stateKey)).length
    for (let i = 1; i < 20; i++) await f.manager.consume(f.request, f.channelId, 1, `request-${i}`)
    const raw = await f.store.get(f.stateKey) as Record<string, unknown>
    expect(raw.requests).toBeUndefined(); expect(raw.pendingRequest).toBeUndefined()
    expect(JSON.stringify(raw).length - size).toBeLessThan(10)
    await expect(f.manager.consume(f.request, f.channelId, 1, 'overflow')).rejects.toMatchObject({ code: 'request-history-full', status: 409 })
    expect((await f.manager.consume(f.request, f.channelId, 1, 'first')).spent).toBe('20')
  })
  it('charges concurrent duplicate keys once across manager instances', async () => {
    const f = fixture(); await f.open()
    const managers = [f.manager, new SessionManager(f.parameters)]
    await Promise.all(Array.from({ length: 20 }, (_, i) => managers[i % 2]!.consume(f.request, f.channelId, 1, 'same')))
    expect((await f.manager.state(f.channelId))!.spent).toBe('1')
    await expect(f.manager.consume(f.request, f.channelId, 2, 'same')).rejects.toMatchObject({ status: 400 })
  })
  it('recovers a crash between debit and request-marker write without a second debit', async () => {
    const base = Store.memory(); let fail = true
    const store: Store.AtomicStore = { ...base, async update(key, fn) {
      if (key.includes(':request:') && fail) { fail = false; throw new Error('Disk unavailable') }
      return base.update(key, fn)
    } }
    const f = fixture({ store }); await f.open()
    await expect(f.manager.consume(f.request, f.channelId, 1, 'once')).rejects.toMatchObject({ status: 500 })
    expect(await f.manager.state(f.channelId)).toMatchObject({ spent: '1', pendingRequest: { cost: '1' } })
    const manager = new SessionManager(f.parameters)
    expect((await manager.consume(f.request, f.channelId, 1, 'once')).spent).toBe('1')
    expect((await manager.state(f.channelId))!.pendingRequest).toBeUndefined()
  })
  it('migrates persisted inline history without forgetting previous debits', async () => {
    const f = fixture(); await f.open()
    const { version: _version, requestCount: _count, ...legacy } = (await f.manager.state(f.channelId))!
    await f.store.put(f.stateKey, { ...legacy, spent: '2', requests: { older: '1', newer: '1' } })
    expect((await new SessionManager(f.parameters).consume(f.request, f.channelId, 1, 'older')).spent).toBe('2')
    expect(await f.store.get(f.stateKey)).toMatchObject({ version: 2, requestCount: 2 })
    expect((await f.store.get(f.stateKey) as Record<string, unknown>).requests).toBeUndefined()
  })
  it('rejects malformed persisted state as an infrastructure failure', async () => {
    const f = fixture(); await f.open()
    await f.store.put(f.stateKey, { version: 2, spent: 'invalid' })
    await expect(f.manager.state(f.channelId)).rejects.toMatchObject({ status: 500 })
  })
  it('preserves uncertain legacy closes during migration', async () => {
    const f = fixture(); await f.open()
    const { version: _version, requestCount: _count, ...legacy } = (await f.manager.state(f.channelId))!
    await f.store.put(f.stateKey, { ...legacy, closing: true, requests: {} })
    expect(await f.manager.reconcile(f.channelId)).toMatchObject({ closing: true, operation: { status: 'unknown' } })
  })
  it('prunes closed history in batches while preserving the closed tombstone', async () => {
    const f = fixture({ requestRetentionMs: 0 }); await f.open()
    for (let i = 0; i < 5; i++) await f.manager.consume(f.request, f.channelId, 1, `${i}`)
    await expect(f.manager.pruneRequests(f.channelId)).rejects.toMatchObject({ status: 409 })
    await f.manager.accept(f.request, { ...await f.voucher(), action: 'close' })
    expect(await f.manager.pruneRequests(f.channelId, 2)).toBe(2)
    expect(await f.manager.pruneRequests(f.channelId, 10)).toBe(3)
    expect(await f.manager.state(f.channelId)).toMatchObject({ closed: true, requestCount: 0 })
    await expect(f.manager.consume(f.request, f.channelId, 1, '0')).rejects.toMatchObject({ status: 410 })
  })
  it('honors retention after closure', async () => {
    const f = fixture(); await f.open(); await f.manager.consume(f.request, f.channelId, 1, 'retain')
    await f.manager.accept(f.request, { ...await f.voucher(), action: 'close' })
    expect(await f.manager.pruneRequests(f.channelId)).toBe(0)
  })
  it('recognizes a forced withdrawal before pruning its request history', async () => {
    const f = fixture({ requestRetentionMs: 0 }); await f.open()
    await f.manager.consume(f.request, f.channelId, 1, 'forced-close')
    f.chain.finalized = true
    expect((await f.manager.reconcile(f.channelId)).closed).toBe(false)
    f.adapter.confirmedChannel = async () => ({ ...f.chain })
    expect((await f.manager.reconcile(f.channelId)).closed).toBe(true)
    expect(await f.manager.pruneRequests(f.channelId)).toBe(1)
  })
  it('resumes an interrupted deletion and tolerates concurrent pruning', async () => {
    const base = Store.memory(); let fail = true
    const store: Store.AtomicStore = { ...base, async delete(key) {
      await base.delete(key)
      if (key.includes(':request:') && fail) { fail = false; throw new Error('Lost response after deletion') }
    } }
    const f = fixture({ store, requestRetentionMs: 0 }); await f.open()
    for (let i = 0; i < 8; i++) await f.manager.consume(f.request, f.channelId, 1, `${i}`)
    await f.manager.accept(f.request, { ...await f.voucher(), action: 'close' })
    await expect(f.manager.pruneRequests(f.channelId)).rejects.toMatchObject({ status: 500 })
    expect((await f.manager.state(f.channelId))!.pruning).toBeDefined()
    const manager = new SessionManager(f.parameters)
    await Promise.all([manager.pruneRequests(f.channelId), f.manager.pruneRequests(f.channelId)])
    expect(await manager.state(f.channelId)).toMatchObject({ requestCount: 0, closed: true })
  })
})

describe('public error contract', () => {
  it('maps invalid inputs to 400 and hides infrastructure failures behind 500', async () => {
    const f = fixture(); await f.open()
    await expect(f.manager.accept(f.request, { action: 'bad' } as unknown as S.Payload)).rejects.toMatchObject({ status: 400 })
    await expect(f.manager.consume(f.request, f.channelId, -1)).rejects.toMatchObject({ status: 400 })
    await expect(f.manager.consume(f.request, f.channelId, 1, '')).rejects.toMatchObject({ status: 400 })
    f.adapter.channel = async () => { throw new Error('secret node credentials') }
    try { await f.manager.consume(f.request, f.channelId); throw new Error('Expected failure') }
    catch (error) {
      expect(error).toBeInstanceOf(Errors.InternalPaymentError)
      expect(JSON.stringify((error as Errors.PaymentError).toProblemDetails())).not.toContain('secret node credentials')
    }
  })
  it.each(['malformed', 'signer', 'infrastructure'] as const)('returns correct HTTP Problem Details for %s failures', async kind => {
    const f = fixture()
    const server = Mppx.create({ secretKey: '0123456789abcdef0123456789abcdef', methods: [tron.session(f.parameters)] })
    const route = server.session({ amount: '1' })
    const initial = await route(new Request('https://api.test/session'))
    if (initial.status !== 402) throw new Error('Expected challenge')
    const challenge = Challenge.fromResponse(initial.challenge)
    const payload = kind === 'malformed' ? { action: 'open' } : { ...await f.voucher(), action: 'open', type: 'hash', hash, salt }
    if (kind === 'infrastructure') f.adapter.channel = async () => { throw new Error('secret node credentials') }
    const credential = Credential.serialize(Credential.from({ challenge, payload, source: P.formatSource(kind === 'signer' ? recipient : account.address, chainId) }))
    const result = await route(new Request('https://api.test/session', { headers: { Authorization: credential } }))
    if (result.status !== 402) throw new Error('Expected rejection')
    const status = { malformed: 400, signer: 402, infrastructure: 500 }[kind]
    expect(result.challenge.status).toBe(status)
    const body = await result.challenge.json()
    expect(body).toMatchObject({ status })
    expect(JSON.stringify(body)).not.toContain('secret node credentials')
  })
})

function transport(): TronTransport {
  return { chainId, call: async () => '0x', send: vi.fn(async () => hash), inspectTransaction: async () => ({ hash, from: account.address, to: token, data: '0x' }),
    signTransaction: async () => '{}', broadcast: async () => hash, info: async () => ({}), blockNumber: async () => 10 }
}
describe('adapter submission classification', () => {
  it.each(['network', 'duplicate', 'rejected'] as const)('classifies a %s broadcast result without losing its hash', async kind => {
    const wallet = {
      defaultAddress: { base58: P.toBase58Address(account.address) },
      transactionBuilder: { triggerSmartContract: async () => ({ result: { result: true }, transaction: {} }) },
      trx: { sign: async () => ({ txID: hash.slice(2) }), sendRawTransaction: async () => {
        if (kind === 'network') throw new Error('Connection lost')
        return { result: false, code: kind === 'duplicate' ? 'DUP_TRANSACTION_ERROR' : 'SIGERROR' }
      } },
    } as unknown as TronWeb
    const transport = createTronWebTransport(wallet, { chainId })
    if (kind === 'rejected') await expect(transport.send(escrow, '0x')).rejects.toBeInstanceOf(P.TransactionNotSubmittedError)
    else await expect(transport.send(escrow, '0x')).rejects.toMatchObject({ status: 503, hash })
  })

  it('distinguishes simulation failure from a confirmation timeout carrying a transaction hash', async () => {
    const t = transport(), adapter = createSessionAdapter(t, escrow, { timeoutMs: 0 })
    t.call = async () => { throw new Error('Simulation failed') }
    await expect(adapter.close(hash, '1', '0x')).rejects.toBeInstanceOf(P.TransactionNotSubmittedError)
    expect(t.send).not.toHaveBeenCalled()
    t.call = async () => '0x'
    await expect(adapter.close(hash, '1', '0x')).rejects.toMatchObject({ status: 503, hash })
    expect(t.send).toHaveBeenCalledTimes(1)
  })
  it('requires confirmation depth even for failed receipts', async () => {
    const t = transport()
    t.info = async () => ({ blockNumber: 10, receipt: { result: 'REVERT' } })
    await expect(waitForReceipt(t, hash, { timeoutMs: 0, minConfirmations: 2 })).rejects.toMatchObject({ status: 503, hash })
    t.blockNumber = async () => 11
    await expect(waitForReceipt(t, hash, { timeoutMs: 0, minConfirmations: 2 })).rejects.toMatchObject({ status: 409 })
    expect(await createSessionAdapter(t, escrow, { minConfirmations: 2 }).transactionStatus!(hash)).toBe('reverted')
  })
})
