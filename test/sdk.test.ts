import { Challenge, Credential, Receipt, Store } from 'mppx'
import { TronWeb, utils } from 'tronweb'
import type { Types as TronTypes } from 'tronweb'
import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { encodeFunctionData, parseAbi, keccak256, toBytes, type Hex, type TypedDataDefinition } from 'viem'
import * as P from '../src/index.js'
import * as C from '../src/protocol/Charge.js'
import * as S from '../src/protocol/Session.js'
import { charge as clientCharge } from '../src/client/Charge.js'
import { charge as serverCharge } from '../src/server/Charge.js'
import { SessionManager } from '../src/server/Session.js'
import { createTronWebTransport, createChargeAdapter, createSessionAdapter, waitForReceipt, type TronTransport } from '../src/tronweb/index.js'
import { verifyTransfers } from '../src/tronweb/Token.js'
import { tron as clientTron } from '../src/client/index.js'
import { Mppx as ClientMppx } from '../src/client/index.js'
import { tron as serverTron, Mppx } from '../src/server/index.js'

const key = `0x${'11'.repeat(32)}` as Hex
const account = privateKeyToAccount(key)
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const token = P.normalizeAddress(`0x${'33'.repeat(20)}`)
const recipient = P.normalizeAddress(`0x${'44'.repeat(20)}`)
const permit2 = P.normalizeAddress(`0x${'55'.repeat(20)}`)
const escrow = P.normalizeAddress(`0x${'66'.repeat(20)}`)
const hash = `0x${'aa'.repeat(32)}` as Hex
const salt = `0x${'bb'.repeat(32)}` as Hex
const chainId = P.chains.nile
const sign: P.TypedSigner = data => account.signTypedData(data as TypedDataDefinition)
const request = (): C.Request => ({ amount: '100', currency: token, recipient,
  externalId: 'invoice-1', methodDetails: { chainId, credentialTypes: ['permit2', 'transaction', 'hash'], permit2Address: permit2, spender: recipient } })
const challenge = (): C.Challenge => ({ id: 'challenge-id', realm: 'api.test', request: request() })
function adapter(): C.Adapter {
  return {
    chainId, payer: account.address, signTypedData: sign,
    tokenState: vi.fn(async () => ({ balance: 1000n, allowance: 1000n })), nonceUsed: vi.fn(async () => false),
    simulate: vi.fn(async () => {}), submit: vi.fn(async () => hash), verify: vi.fn(async h => ({ hash: h })),
    createTransaction: vi.fn(async (_r, broadcast) => broadcast ? hash : '{"signed":"protobuf"}'),
  }
}
async function permit(c = challenge()): Promise<C.Permit2Payload> {
  const p: C.Permit2Payload = { type: 'permit2', permit: { permitted: C.transfers(c.request).map(t => ({ token, amount: t.amount })), nonce: '7', deadline: String(Math.floor(Date.now() / 1000) + 120) },
    transferDetails: C.transfers(c.request).map(t => ({ to: t.to, requestedAmount: t.amount })), witness: { challengeHash: P.challengeHash(c), externalId: c.request.externalId ?? '' }, signature: '0x' }
  p.signature = await sign(C.permitTypedData(c, p))
  return p
}
function verification(c: C.Challenge, payload: C.Payload) {
  return { credential: { challenge: { ...c, method: 'tron' as const, intent: 'charge' as const }, payload,
    source: P.formatSource(account.address, chainId) }, request: c.request }
}

describe('TRON protocol primitives', () => {
  it('compares Base58Check, 41-prefixed and 20-byte addresses by account value', () => {
    const base58 = P.toBase58Address(account.address)
    expect(P.normalizeAddress(base58)).toBe(account.address)
    expect(P.normalizeAddress(`41${account.address.slice(2)}`)).toBe(account.address)
    expect(P.isSameAddress(base58, account.address.toLowerCase())).toBe(true)
    expect(() => P.normalizeAddress(base58.slice(0, -1) + '1')).toThrow()
  })
  it('matches TIP-712 signatures produced independently by TronWeb', async () => {
    const wallet = new TronWeb({ fullHost: 'http://localhost:8090', privateKey: key.slice(2) })
    const data = P.voucherTypedData({ chainId, escrowContract: escrow, channelId: hash, cumulativeAmount: '123' })
    const types = Object.fromEntries(Object.entries(data.types).map(([k, v]) => [k, [...v]]))
    const signature = await wallet.trx.signTypedData(data.domain, types, data.message)
    expect(await P.recoverSigner(data, signature as Hex)).toBe(account.address)
  })
  it('rejects uint128 overflow and noncanonical voucher signatures', async () => {
    expect(() => P.voucherTypedData({ chainId, escrowContract: escrow, channelId: hash, cumulativeAmount: (1n << 128n).toString() })).toThrow()
    expect(() => P.assertSignature(`0x${'ff'.repeat(64)}1b`)).toThrow()
  })
  it('binds channel IDs to the chain, escrow and delegated signer', () => {
    const args = { payer: account.address, payee: recipient, token, salt, escrowContract: escrow, chainId }
    expect(P.computeChannelId(args)).not.toBe(P.computeChannelId({ ...args, chainId: chainId + 1 }))
    expect(P.computeChannelId(args)).not.toBe(P.computeChannelId({ ...args, authorizedSigner: other.address }))
  })
  it('exposes one charge and one session factory', () => {
    expect(Object.keys(clientTron).sort()).toEqual(['charge', 'session'])
    expect(Object.keys(serverTron).sort()).toEqual(['charge', 'session'])
    expect(clientTron.charge).toBeTypeOf('function')
    expect(clientTron.session).toBeTypeOf('function')
    expect(serverTron.charge).toBeTypeOf('function')
    expect(serverTron.session).toBeTypeOf('function')
  })
  it.each(['TRX', P.zeroAddress, P.toBase58Address(P.zeroAddress)])('rejects native currency %s for both intents', currency => {
    expect(() => C.RequestSchema.parse({ ...request(), currency })).toThrow()
    expect(() => S.RequestSchema.parse({ amount: '1', currency, recipient, methodDetails: { chainId, escrowContract: escrow } })).toThrow()
    expect(() => serverTron.charge({ adapter: adapter(), chainId, currency, recipient })).toThrow()
    expect(() => clientTron.charge({ adapter: adapter(), chainIds: [chainId], currencies: [currency], recipients: [recipient], maxAtomicAmount: '100' })).toThrow()
    expect(() => serverTron.session({ adapter: sessionFixture().adapter, currency, recipient, store: Store.memory() })).toThrow()
    expect(() => clientTron.session({ chainIds: [chainId], currencies: [currency], escrowContracts: [escrow], payer: account.address,
      maxUnitAmount: '1', maxCumulativeAmount: '100', wallet: { adapter: sessionFixture().adapter, createPayload: async () => { throw new Error('Must not be called') } }, preparePayment: async () => { throw new Error('Must not be called') } })).toThrow()
  })
})

describe('TRC-20 charge', () => {
  it('runs the automatic HTTP 402 -> Permit2 credential -> retry -> receipt flow', async () => {
    const serverAdapter = adapter()
    const server = Mppx.create({ secretKey: '0123456789abcdef0123456789abcdef', methods: [serverTron.charge({
      adapter: serverAdapter, chainId, currency: token, recipient, credentialTypes: ['permit2'], permit2: { address: permit2, spender: recipient },
    })] })
    const route = server.charge({ amount: '100', externalId: 'invoice-1' })
    const client = ClientMppx.create({ polyfill: false, methods: [clientTron.charge({ adapter: adapter(), chainIds: [chainId], currencies: [token], recipients: [recipient], maxAtomicAmount: '100', permit2: { address: permit2, spender: recipient } })],
      fetch: async (input, init) => {
        const result = await route(new Request(input, init))
        return result.status === 402 ? result.challenge : result.withReceipt(Response.json({ paid: true }))
      },
    })
    const response = await client.fetch('https://api.test/paid')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ paid: true })
    expect(Receipt.fromResponse(response)).toMatchObject({ method: 'tron', chainId, externalId: 'invoice-1' })
    expect(serverAdapter.submit).toHaveBeenCalledTimes(1)
  })
  it('rejects modified HTTP challenge terms before any settlement', async () => {
    const a = adapter()
    const store = Store.memory()
    const server = Mppx.create({ secretKey: '0123456789abcdef0123456789abcdef', methods: [serverTron.charge({
      adapter: a, chainId, currency: token, recipient, credentialTypes: ['hash'], store,
    })] })
    const route = server.charge({ amount: '100' })
    const initial = await route(new Request('https://api.test/paid'))
    if (initial.status !== 402) throw new Error('Expected challenge')
    const c = Challenge.fromResponse(initial.challenge)
    c.request.amount = '1'
    const credential = Credential.serialize(Credential.from({ challenge: c, payload: { type: 'hash', hash }, source: P.formatSource(account.address, chainId) }))
    expect((await route(new Request('https://api.test/paid', { headers: { Authorization: credential } }))).status).toBe(402)
    expect(a.verify).not.toHaveBeenCalled()
    c.request.amount = '100'
    await store.delete(`tron:issued:${c.id}`)
    const unknown = Credential.serialize(Credential.from({ challenge: c, payload: { type: 'hash', hash }, source: P.formatSource(account.address, chainId) }))
    const rejected = await route(new Request('https://api.test/paid', { headers: { Authorization: unknown } }))
    expect(rejected.status).toBe(402)
    if (rejected.status !== 402) throw new Error('Expected rejection')
    expect(await rejected.challenge.json()).toMatchObject({ type: 'https://paymentauth.org/problems/invalid-challenge' })
    expect(a.verify).not.toHaveBeenCalled()
  })
  it('negotiates Permit2 and verifies the generated witness signature', async () => {
    const c = challenge()
    const method = clientCharge({ adapter: adapter(), chainIds: [chainId], currencies: [token], recipients: [recipient], maxAtomicAmount: '100', permit2: { address: permit2, spender: recipient } })
    const header = await method.createCredential({ challenge: { ...c, method: 'tron', intent: 'charge' } })
    const payload = C.PayloadSchema.parse(Credential.deserialize(header).payload)
    expect(payload.type).toBe('permit2')
    await C.validatePayload({ challenge: c, payload, payer: account.address })
  })
  it('binds externalId and challenge realm into Permit2 authorization', async () => {
    const c = challenge()
    const p = await permit(c)
    await expect(C.validatePayload({ challenge: { ...c, realm: 'attacker.test' }, payload: p, payer: account.address })).rejects.toThrow(/witness/)
    p.witness.externalId = 'another-invoice'
    await expect(C.validatePayload({ challenge: c, payload: p, payer: account.address })).rejects.toThrow(/witness/)
  })
  it('checks ordered split recipients and amounts', async () => {
    const c = challenge()
    c.request.methodDetails.splits = [{ recipient: other.address, amount: '20' }]
    const p = await permit(c)
    await C.validatePayload({ challenge: c, payload: p, payer: account.address })
    expect(p.transferDetails[0]!.requestedAmount).toBe('80')
    p.transferDetails.reverse()
    await expect(C.validatePayload({ challenge: c, payload: p, payer: account.address })).rejects.toThrow(/transfer mismatch/)
    expect(() => C.assertType(c.request, 'hash')).toThrow(/Splits/)
  })
  it('rejects excessive splits, expired permits and a different signature owner', async () => {
    const c = challenge()
    c.request.methodDetails.splits = [{ recipient, amount: '100' }]
    expect(() => C.transfers(c.request)).toThrow()
    const valid = challenge()
    const p = await permit(valid)
    await expect(C.validatePayload({ challenge: valid, payload: p, payer: other.address })).rejects.toThrow(/signer/)
    p.permit.deadline = '1'
    await expect(C.validatePayload({ challenge: valid, payload: p, payer: account.address })).rejects.toThrow(/expired/)
  })
  it('does not sign for untrusted spender, chain or token', async () => {
    const a = adapter()
    a.signTypedData = vi.fn(sign)
    delete a.createTransaction
    const method = clientCharge({ adapter: a, chainIds: [chainId], currencies: [token], recipients: [recipient], maxAtomicAmount: '100', permit2: { address: permit2, spender: other.address } })
    await expect(method.createCredential({ challenge: { ...challenge(), method: 'tron', intent: 'charge' } })).rejects.toThrow(/supported/)
    expect(a.signTypedData).not.toHaveBeenCalled()
  })
  it.each(['amount', 'chain', 'currency'] as const)('rejects disallowed %s before signing or transferring tokens', async policy => {
    const a = adapter()
    a.signTypedData = vi.fn(sign)
    const method = clientTron.charge({ adapter: a, chainIds: [chainId], currencies: [token], recipients: [recipient], maxAtomicAmount: '100', permit2: { address: permit2, spender: recipient } })
    const c = challenge()
    if (policy === 'amount') c.request.amount = '101'
    if (policy === 'chain') c.request.methodDetails.chainId = chainId + 1
    if (policy === 'currency') c.request.currency = other.address
    await expect(method.createCredential({ challenge: { ...c, method: 'tron', intent: 'charge' } })).rejects.toThrow()
    expect(a.signTypedData).not.toHaveBeenCalled()
    expect(a.createTransaction).not.toHaveBeenCalled()
  })
  it('only accepts explicitly enabled EIP-3009 and binds nonce to challenge', async () => {
    const c = challenge()
    c.request.methodDetails.credentialTypes = ['authorization']
    const domain = { name: 'Token', version: '2' }
    const unsigned = { type: 'authorization' as const, from: account.address, to: recipient, value: '100', validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 120), nonce: P.challengeHash(c) }
    const p = { ...unsigned, signature: await sign(P.transferAuthorizationTypedData({ chainId, token, domain, authorization: unsigned })) }
    await C.validatePayload({ challenge: c, payload: p, payer: account.address, authorizationDomain: domain })
    await expect(C.validatePayload({ challenge: c, payload: p, payer: account.address })).rejects.toThrow(/configured/)
    p.nonce = hash
    await expect(C.validatePayload({ challenge: c, payload: p, payer: account.address, authorizationDomain: domain })).rejects.toThrow(/terms/)
  })
  it('reserves a challenge before concurrent settlement and preserves receipt extensions', async () => {
    const a = adapter()
    const method = serverCharge({ adapter: a, chainId, currency: token, recipient, credentialTypes: ['permit2'], permit2: { address: permit2, spender: recipient } })
    const c = challenge()
    const v = verification(c, await permit(c))
    const results = await Promise.allSettled([method.verify(v), method.verify(v)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(a.submit).toHaveBeenCalledTimes(1)
    const receipt = results.find(r => r.status === 'fulfilled')!
    if (receipt.status === 'fulfilled') expect(Receipt.deserialize(Receipt.serialize(receipt.value))).toMatchObject({ chainId, challengeId: c.id, externalId: 'invoice-1' })
  })
  it('rejects hash reuse across two challenges', async () => {
    const method = serverCharge({ adapter: adapter(), chainId, currency: token, recipient, credentialTypes: ['hash'] })
    await method.verify(verification(challenge(), { type: 'hash', hash }))
    await expect(method.verify(verification({ ...challenge(), id: 'other' }, { type: 'hash', hash }))).rejects.toThrow(/consumed/)
  })
  it('allows a valid payment retry after hash verification fails', async () => {
    const a = adapter()
    a.verify = vi.fn().mockRejectedValueOnce(new Error('Unconfirmed')).mockResolvedValue({ hash })
    const method = serverCharge({ adapter: a, chainId, currency: token, recipient, credentialTypes: ['hash'] })
    const v = verification(challenge(), { type: 'hash', hash })
    await expect(method.verify(v)).rejects.toThrow(/Unconfirmed/)
    await expect(method.verify(v)).resolves.toMatchObject({ reference: hash })
  })
  it('preserves an uncertain submission reservation instead of charging twice', async () => {
    const a = adapter()
    a.submit = vi.fn(async () => { throw new Error('RPC timeout') })
    const method = serverCharge({ adapter: a, chainId, currency: token, recipient, credentialTypes: ['permit2'], permit2: { address: permit2, spender: recipient } })
    const v = verification(challenge(), await permit())
    await expect(method.verify(v)).rejects.toMatchObject({ status: 503 })
    await expect(method.verify(v)).rejects.toMatchObject({ status: 503 })
    expect(a.submit).toHaveBeenCalledTimes(1)
  })
})

function sessionFixture() {
  const request: S.Request = { amount: '10', currency: token, recipient, methodDetails: { chainId, escrowContract: escrow, minVoucherDelta: '10', credentialTypes: ['hash'] } }
  const channelId = P.computeChannelId({ payer: account.address, payee: recipient, token, salt, escrowContract: escrow, chainId })
  const chain: S.Channel = { payer: account.address, payee: recipient, token, authorizedSigner: P.zeroAddress, deposit: '100', settled: '0', closeRequestedAt: '0', finalized: false }
  const adapter: S.Adapter = { chainId, escrowContract: escrow, gracePeriod: vi.fn(async () => 900), channel: vi.fn(async () => ({ ...chain })),
    verifyTransaction: vi.fn(async () => {}), close: vi.fn(async (_id, amount) => { chain.finalized = true; chain.settled = amount; return { hash } }),
    settle: vi.fn(async (_id, amount) => { chain.settled = amount; return { hash } }) }
  const store = Store.memory()
  const manager = new SessionManager({ adapter, currency: token, recipient, store })
  const voucher = async (amount: string): Promise<Extract<S.Payload, { action: 'voucher' }>> => ({ action: 'voucher', channelId, cumulativeAmount: amount,
    signature: await sign(P.voucherTypedData({ chainId, escrowContract: escrow, channelId, cumulativeAmount: amount })) })
  const open = async (amount = '50') => manager.accept(request, { ...await voucher(amount), action: 'open', type: 'hash', hash, salt }, P.formatSource(account.address, chainId))
  return { request, channelId, chain, adapter, manager, store, voucher, open }
}
describe('session vouchers and durable accounting', () => {
  it.each(['permit2', 'authorization'] as const)('validates %s funding against the channel identity before submitting', async type => {
    const f = sessionFixture()
    f.request.methodDetails.feePayer = true
    f.request.methodDetails.credentialTypes = [type]
    f.request.methodDetails.permit2Contract = permit2
    const domain = { name: 'Token', version: '2' }
    const unsigned = type === 'permit2'
      ? { action: 'open' as const, type, salt, authorization: { from: account.address, permitted: { token, amount: '100' }, nonce: '1', deadline: String(Math.floor(Date.now() / 1000) + 120), witness: { payee: recipient, salt, authorizedSigner: P.zeroAddress } }, signature: '0x' as Hex }
      : { action: 'open' as const, type, salt, authorization: { from: account.address, to: escrow, value: '100', validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 120), nonce: P.authorizationNonce({ from: account.address, payee: recipient, token, salt }) }, signature: '0x' as Hex }
    const funding = { ...unsigned, signature: await sign(S.fundingTypedData(f.request, f.channelId, unsigned, domain)) } as S.Funding
    await S.validateFunding(f.request, f.channelId, funding, domain)
    await expect(S.validateFunding(f.request, hash, funding, domain)).rejects.toThrow(/Channel ID/)
    funding.salt = hash
    await expect(S.validateFunding(f.request, f.channelId, funding, domain)).rejects.toThrow(/Channel ID/)
  })
  it('rejects wrong-network sponsored funding before the funding adapter can run', async () => {
    const f = sessionFixture()
    f.adapter.fund = vi.fn(async () => hash)
    const manager = new SessionManager({ adapter: f.adapter, currency: token, recipient, store: Store.memory(), credentialTypes: ['permit2'], permit2Contract: permit2 })
    const request = { ...f.request, methodDetails: { ...f.request.methodDetails, chainId: chainId + 1 } }
    await expect(manager.accept(request, await f.voucher('50'))).rejects.toThrow(/route mismatch/)
    expect(f.adapter.fund).not.toHaveBeenCalled()
  })
  it('runs session open/voucher HTTP requests and preserves session receipts and Problem Details', async () => {
    const f = sessionFixture()
    const method = serverTron.session({ adapter: f.adapter, currency: token, recipient, store: f.store })
    const server = Mppx.create({ secretKey: '0123456789abcdef0123456789abcdef', methods: [method] })
    const route = server.session({ amount: '10' })
    const initial = await route(new Request('https://api.test/session'))
    if (initial.status !== 402) throw new Error('Expected challenge')
    const c = Challenge.fromResponse(initial.challenge)
    const p: S.Payload = { ...await f.voucher('50'), action: 'open', type: 'hash', hash, salt }
    const credential = Credential.serialize(Credential.from({ challenge: c, payload: p, source: P.formatSource(account.address, chainId) }))
    const accepted = await route(new Request('https://api.test/session', { headers: { Authorization: credential, 'Idempotency-Key': 'request-1' } }))
    expect(accepted.status).toBe(200)
    if (accepted.status === 402) throw new Error('Session rejected')
    expect(Receipt.fromResponse(accepted.withReceipt(new Response('paid')))).toMatchObject({ intent: 'session', reference: f.channelId, spent: '10', acceptedCumulative: '50' })
    f.chain.finalized = true
    const gone = await route(new Request('https://api.test/session', { headers: { Authorization: credential } }))
    if (gone.status !== 402) throw new Error('Expected an error response')
    expect(gone.challenge.status).toBe(410)
    expect(await gone.challenge.json()).toMatchObject({ type: 'https://paymentauth.org/problems/session/channel-finalized', status: 410 })
  })
  it('opens, deducts service, settles and closes with cumulative accounting', async () => {
    const f = sessionFixture()
    await f.open()
    expect((await f.manager.consume(f.request, f.channelId, 2)).spent).toBe('20')
    await f.manager.settle(f.channelId)
    expect((await f.manager.state(f.channelId))!.settledOnChain).toBe('50')
    await f.manager.accept(f.request, { ...await f.voucher('60'), action: 'close' })
    expect((await f.manager.state(f.channelId))!.closed).toBe(true)
  })
  it('authenticates stale vouchers before the idempotency short circuit', async () => {
    const f = sessionFixture()
    await f.open()
    expect((await f.manager.accept(f.request, await f.voucher('40'))).acceptedCumulative).toBe('50')
    const stale = await f.voucher('40')
    stale.signature = await other.signTypedData(P.voucherTypedData({ chainId, escrowContract: escrow, channelId: f.channelId, cumulativeAmount: '40' }) as TypedDataDefinition)
    await expect(f.manager.accept(f.request, stale)).rejects.toMatchObject({ code: 'invalid-signature' })
  })
  it('atomically prevents overspending and deduplicates request keys after recreation', async () => {
    const f = sessionFixture()
    await f.open('10')
    const results = await Promise.allSettled([f.manager.consume(f.request, f.channelId), f.manager.consume(f.request, f.channelId)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    await f.manager.accept(f.request, await f.voucher('50'))
    await f.manager.consume(f.request, f.channelId, 1, 'request-1')
    const recreated = new SessionManager({ adapter: f.adapter, currency: token, recipient, store: f.store })
    expect((await recreated.consume(f.request, f.channelId, 1, 'request-1')).spent).toBe('20')
    await expect(recreated.consume(f.request, f.channelId, 2, 'request-1')).rejects.toThrow(/different cost/)
  })
  it('rejects deposit overflow, small increments, wrong source and forced-closing channels', async () => {
    const f = sessionFixture()
    await f.open()
    await expect(f.manager.accept(f.request, await f.voucher('51'))).rejects.toMatchObject({ code: 'delta-too-small' })
    await expect(f.manager.accept(f.request, await f.voucher('110'))).rejects.toMatchObject({ code: 'amount-exceeds-deposit' })
    await expect(f.manager.accept(f.request, await f.voucher('60'), P.formatSource(other.address, chainId))).rejects.toThrow(/source/)
    f.chain.closeRequestedAt = '1'
    await expect(f.manager.accept(f.request, await f.voucher('60'))).rejects.toMatchObject({ code: 'channel-finalized' })
  })
  it('checks a matching TopUp event and exact increase before updating deposit', async () => {
    const f = sessionFixture()
    await f.open()
    f.chain.deposit = '120'
    const payload: S.Payload = { action: 'topUp', type: 'hash', channelId: f.channelId, hash, additionalDeposit: '30' }
    await expect(f.manager.accept(f.request, payload, P.formatSource(account.address, chainId))).rejects.toThrow(/increase/)
    payload.additionalDeposit = '20'
    expect((await f.manager.accept(f.request, payload, P.formatSource(account.address, chainId))).deposit).toBe('120')
  })
  it('rejects escrow grace periods shorter than 15 minutes', async () => {
    const f = sessionFixture()
    f.adapter.gracePeriod = async () => 899
    await expect(f.open()).rejects.toMatchObject({ status: 500 })
  })
  it('binds EIP-3009 funding nonce to the depositor and channel terms', () => {
    expect(P.authorizationNonce({ from: account.address, payee: recipient, token, salt })).not.toBe(P.authorizationNonce({ from: account.address, payee: other.address, token, salt }))
    expect(P.topUpNonce({ from: account.address, channelId: hash, additionalDeposit: '1', salt })).not.toBe(P.topUpNonce({ from: account.address, channelId: hash, additionalDeposit: '2', salt }))
  })
})

const topic = keccak256(toBytes('Transfer(address,address,uint256)')).slice(2)
const padded = (value: string) => value.slice(2).toLowerCase().padStart(64, '0')
function transferLog(to = recipient, amount = 100n) { return { address: token.slice(2), topics: [topic, padded(account.address), padded(to)], data: amount.toString(16).padStart(64, '0') } }
function transport(): TronTransport {
  return { chainId, payer: P.toBase58Address(account.address), signTypedData: sign,
    call: vi.fn(async () => '0x' as Hex), send: vi.fn(async () => hash), inspectTransaction: vi.fn(async () => ({ hash, from: account.address, to: token, data: '0x' as Hex })),
    signTransaction: vi.fn(async () => '{}'), broadcast: vi.fn(async () => hash),
    info: vi.fn(async () => ({ id: hash.slice(2), blockNumber: 10, receipt: { result: 'SUCCESS' }, log: [transferLog()] })), blockNumber: vi.fn(async () => 10) }
}
describe('TRON settlement adapters', () => {
  it('validates a real signed TRON transaction envelope and rejects JSON/raw-data tampering', async () => {
    const wallet = new TronWeb({ fullHost: 'http://localhost:8090', privateKey: key.slice(2) })
    const data = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [recipient, 100n] })
    const unsigned = {
      visible: false,
      raw_data: { ref_block_bytes: '1234', ref_block_hash: '11'.repeat(8), expiration: Date.now() + 60000,
        timestamp: Date.now(), fee_limit: 100000000,
        contract: [{ type: 'TriggerSmartContract', parameter: { type_url: 'type.googleapis.com/protocol.TriggerSmartContract', value: {
          owner_address: `41${account.address.slice(2)}`, contract_address: `41${token.slice(2)}`, data: data.slice(2),
        } } }],
      },
    }
    const protobuf = utils.transaction.txJsonToPb(unsigned)
    const tx = { ...unsigned, raw_data_hex: utils.transaction.txPbToRawDataHex(protobuf), txID: utils.transaction.txPbToTxID(protobuf).replace(/^0x/, '') }
    const signed = await wallet.trx.sign(tx as unknown as TronTypes.Transaction)
    const transport = createTronWebTransport(wallet, { chainId })
    expect(await transport.inspectTransaction(JSON.stringify(signed), account.address)).toMatchObject({ to: token, data })
    expect(await transport.inspectTransaction(JSON.stringify(signed))).toMatchObject({ from: account.address, to: token, data })
    await expect(transport.inspectTransaction(JSON.stringify(signed), other.address)).rejects.toThrow(/signer mismatch/)
    const tampered = JSON.parse(JSON.stringify(signed))
    tampered.raw_data.contract[0].parameter.value.data = `${data.slice(2, -1)}1`
    await expect(transport.inspectTransaction(JSON.stringify(tampered), account.address)).rejects.toThrow(/mismatch/)
    const withNativeValue = {
      ...unsigned,
      raw_data: { ...unsigned.raw_data, contract: unsigned.raw_data.contract.map(c => ({ ...c,
        parameter: { ...c.parameter, value: { ...c.parameter.value, call_value: 1 } },
      })) },
    }
    const nativeProtobuf = utils.transaction.txJsonToPb(withNativeValue)
    const nativeTx = { ...withNativeValue, raw_data_hex: utils.transaction.txPbToRawDataHex(nativeProtobuf), txID: utils.transaction.txPbToTxID(nativeProtobuf).replace(/^0x/, '') }
    const signedNative = await wallet.trx.sign(nativeTx as unknown as TronTypes.Transaction)
    await expect(transport.inspectTransaction(JSON.stringify(signedNative), account.address)).rejects.toThrow(/Invalid or expired token transfer/)
  })
  it('rejects a successful native-transfer receipt without a matching TRC-20 event', async () => {
    const t = transport()
    t.info = async () => ({ id: hash.slice(2), blockNumber: 10, receipt: { result: 'SUCCESS' }, log: [] })
    await expect(createChargeAdapter(t).verify(hash, request(), account.address)).rejects.toThrow(/expected token transfer/)
  })
  it('requires a distinct Transfer event for every split', () => {
    expect(() => verifyTransfers({ log: [transferLog()] }, token, account.address, [{ to: recipient, amount: '100' }, { to: recipient, amount: '100' }])).toThrow()
    verifyTransfers({ log: [transferLog(), transferLog()] }, token, account.address, [{ to: recipient, amount: '100' }, { to: recipient, amount: '100' }])
  })
  it('rejects a mined reverted receipt immediately', async () => {
    const t = transport()
    t.info = vi.fn(async () => ({ blockNumber: 10, receipt: { result: 'REVERT' } }))
    await expect(waitForReceipt(t, hash)).rejects.toMatchObject({ status: 409, code: 'transaction-reverted' })
    expect(t.info).toHaveBeenCalledTimes(1)
  })
  it('does not treat a pending receipt as confirmed or permit zero confirmations', async () => {
    const t = transport()
    t.info = async () => ({})
    await expect(waitForReceipt(t, hash, { timeoutMs: 0 })).rejects.toMatchObject({ status: 503, hash })
    await expect(waitForReceipt(t, hash, { minConfirmations: 0 })).rejects.toThrow(/one confirmation/)
  })
  it('rejects signed transactions with different recipient/calldata before broadcast', async () => {
    const t = transport()
    const a = createChargeAdapter(t)
    await expect(a.simulate(challenge(), { type: 'transaction', signature: '{}' }, account.address)).rejects.toThrow(/mismatch/)
    expect(t.broadcast).not.toHaveBeenCalled()
  })
  it('requires the Permit2 submitting account to match its signed spender', async () => {
    const t = transport()
    await expect(createChargeAdapter(t).simulate(challenge(), await permit(), account.address)).rejects.toThrow(/spender/)
    expect(t.call).not.toHaveBeenCalled()
  })
  it('verifies the exact escrow/channel event instead of accepting an unrelated successful tx', async () => {
    const t = transport()
    await expect(createSessionAdapter(t, escrow).verifyTransaction(hash, 'open', salt)).rejects.toThrow(/expected escrow/)
  })
})
