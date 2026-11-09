import { Challenge, Credential, Store } from 'mppx'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex, TypedDataDefinition } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import * as P from '../src/protocol/Primitives.js'
import * as S from '../src/protocol/Session.js'
import { authorizeSessionRequest } from '../src/client/Session.js'
import { session, type SessionParameters } from '../src/server/Session.js'
import { Mppx } from '../src/server/index.js'
import { TransactionOutcomeUnknownError } from '../src/protocol/Errors.js'

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const token = P.normalizeAddress(`0x${'33'.repeat(20)}`)
const recipient = P.normalizeAddress(`0x${'44'.repeat(20)}`)
const permit2 = P.normalizeAddress(`0x${'55'.repeat(20)}`)
const escrow = P.normalizeAddress(`0x${'66'.repeat(20)}`)
const hash = `0x${'aa'.repeat(32)}` as Hex
const salt = `0x${'bb'.repeat(32)}` as Hex
const chainId = P.chains.nile
const source = P.formatSource(account.address, chainId)
const id = P.computeChannelId({ payer: account.address, payee: recipient, token, salt, escrowContract: escrow, chainId })
const sign: P.TypedSigner = data => account.signTypedData(data as TypedDataDefinition)
const otherSign: P.TypedSigner = data => other.signTypedData(data as TypedDataDefinition)
const domain = { name: 'Token', version: '2' }

function fixture(options: Partial<SessionParameters> = {}) {
  const chain: S.Channel = { payer: account.address, payee: recipient, token, authorizedSigner: P.zeroAddress,
    deposit: '100', settled: '0', closeRequestedAt: '0', finalized: false }
  const adapter: S.Adapter = { chainId, escrowContract: escrow, gracePeriod: async () => 900,
    channel: vi.fn(async () => ({ ...chain })), verifyTransaction: vi.fn(async () => {}),
    fund: vi.fn(async () => hash), settle: vi.fn(async (_id, amount) => { chain.settled = amount; return { hash } }),
    close: vi.fn(async () => { chain.finalized = true; return { hash } }),
  }
  const parameters: SessionParameters = { adapter, currency: token, recipient, store: Store.memory(),
    credentialTypes: ['hash', 'permit2', 'authorization'], permit2Contract: permit2, authorizationDomain: domain, ...options }
  const method = session(parameters)
  const server = Mppx.create({ secretKey: '0123456789abcdef0123456789abcdef', methods: [method] })
  const route = server.session({ amount: '1' })
  const challenge = async (): Promise<S.Challenge> => {
    const initial = await route(new Request('https://api.test/session'))
    if (initial.status !== 402) throw new Error('Expected challenge')
    const c = Challenge.fromResponse(initial.challenge)
    return { ...c, request: S.RequestSchema.parse(c.request) }
  }
  const voucher = async (amount = '100', signer: P.TypedSigner = sign): Promise<S.Payload> => ({ action: 'voucher', channelId: id, cumulativeAmount: amount,
    signature: await signer(P.voucherTypedData({ chainId, escrowContract: escrow, channelId: id, cumulativeAmount: amount })) })
  const openPayload = async (amount = '100'): Promise<S.Payload> => ({ ...await voucher(amount), action: 'open', type: 'hash', hash, salt } as S.Payload)
  const header = (c: S.Challenge, payload: S.Payload, payerSource = source) => Credential.serialize(Credential.from({
    challenge: { ...c, method: 'tron', intent: 'session' }, payload, source: payerSource,
  }))
  const submit = (authorization: string, extra: Record<string, string> = {}) => route(new Request('https://api.test/session', { headers: { Authorization: authorization, ...extra } }))
  const open = async (amount = '100') => {
    const c = await challenge()
    const payload = await authorizeSessionRequest(c, await openPayload(amount), sign)
    const credential = header(c, payload)
    expect((await submit(credential)).status).toBe(200)
    return { c, payload, credential }
  }
  return { chain, adapter, method, parameters, route, challenge, voucher, openPayload, header, submit, open }
}

describe('HTTP session authentication and replay protection', () => {
  it('rejects settlement vouchers used without an independent request proof, or with an attacker proof', async () => {
    const f = fixture(); await f.open(); await f.method.manager.settle(id)
    const calls = vi.mocked(f.adapter.settle).mock.calls
    const [, amount, signature] = calls[0]!
    const publicVoucher: S.Payload = { action: 'voucher', channelId: id, cumulativeAmount: amount, signature }
    const c = await f.challenge()
    for (const payload of [publicVoucher, await authorizeSessionRequest(c, publicVoucher, otherSign)]) {
      const result = await f.submit(f.header(c, payload))
      expect(result.status).toBe(402)
      if (result.status !== 402) throw new Error('Expected rejection')
      expect(await result.challenge.json()).toMatchObject({ type: 'https://paymentauth.org/problems/session/invalid-request-authorization' })
    }
    expect(await f.method.manager.state(id)).toMatchObject({ spent: '1', settledOnChain: '100' })
    const legitimate = await authorizeSessionRequest(c, publicVoucher, sign)
    expect((await f.submit(f.header(c, legitimate))).status).toBe(200)
    expect(await f.method.manager.state(id)).toMatchObject({ spent: '2' })
  })

  it.each(['payload', 'challenge', 'nonce'] as const)('rejects a request proof after changing its %s', async field => {
    const f = fixture(); await f.open()
    const c = await f.challenge(), body = await f.voucher()
    const payload = await authorizeSessionRequest(c, body, sign)
    if (field === 'payload') {
      const changed = await f.voucher('90')
      expect((await f.submit(f.header(c, { ...changed, requestAuthorization: payload.requestAuthorization }))).status).toBe(402)
    } else if (field === 'challenge') {
      const different = { ...c, realm: 'another.test' }
      const proof = await authorizeSessionRequest(different, body, sign)
      expect((await f.submit(f.header(c, proof))).status).toBe(402)
    } else {
      payload.requestAuthorization!.nonce = salt
      expect((await f.submit(f.header(c, payload))).status).toBe(402)
    }
    expect(await f.method.manager.state(id)).toMatchObject({ spent: '1' })
  })

  it('rejects credential replay even when the untrusted Idempotency-Key is changed', async () => {
    const f = fixture(), { credential } = await f.open()
    for (const key of ['repeat', 'different']) {
      const result = await f.submit(credential, { 'Idempotency-Key': key })
      expect(result.status).toBe(402)
      if (result.status !== 402) throw new Error('Expected rejection')
      expect(result.challenge.status).toBe(409)
    }
    expect(await f.method.manager.state(id)).toMatchObject({ spent: '1', requestCount: 1 })
  })

  it('charges fresh signed requests separately when they reuse the same Idempotency-Key', async () => {
    const f = fixture(); await f.open()
    const c = await f.challenge()
    let executions = 0
    for (let i = 0; i < 3; i++) {
      const payload = await authorizeSessionRequest(c, await f.voucher(), sign)
      const result = await f.submit(f.header(c, payload), { 'Idempotency-Key': 'same-key' })
      expect(result.status).toBe(200)
      if (result.status === 402) throw new Error('Unexpected rejection')
      executions++
      await result.withReceipt(Response.json({ executions }))
    }
    expect(executions).toBe(3)
    expect(await f.method.manager.state(id)).toMatchObject({ spent: '4', requestCount: 4 })
  })

  it('permits only one concurrent request with the same signed nonce', async () => {
    const f = fixture(); await f.open()
    const c = await f.challenge(), payload = await authorizeSessionRequest(c, await f.voucher(), sign)
    const credential = f.header(c, payload)
    const results = await Promise.all([f.submit(credential), f.submit(credential)])
    expect(results.map(r => r.status).sort()).toEqual([200, 402])
    const rejected = results.find(r => r.status === 402)!
    if (rejected.status !== 402) throw new Error('Expected rejection')
    expect(rejected.challenge.status).toBe(409)
    expect(await f.method.manager.state(id)).toMatchObject({ spent: '2', requestCount: 2 })
  })

  it('keeps nonce replay protection across server restarts sharing the same store', async () => {
    const f = fixture(), { credential } = await f.open()
    const restarted = session(f.parameters)
    const server = Mppx.create({ secretKey: '0123456789abcdef0123456789abcdef', methods: [restarted] })
    const result = await server.session({ amount: '1' })(new Request('https://api.test/session', { headers: { Authorization: credential } }))
    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error('Expected rejection')
    expect(result.challenge.status).toBe(409)
    expect(await restarted.manager.state(id)).toMatchObject({ spent: '1' })
  })

  it('uses the delegated signer for request authentication', async () => {
    const f = fixture()
    f.chain.authorizedSigner = other.address
    const delegatedId = P.computeChannelId({ payer: account.address, payee: recipient, token, salt, authorizedSigner: other.address, escrowContract: escrow, chainId })
    const c = await f.challenge()
    const payload: S.Payload = { action: 'open', type: 'hash', channelId: delegatedId, hash, salt, authorizedSigner: other.address, cumulativeAmount: '100',
      signature: await otherSign(P.voucherTypedData({ chainId, escrowContract: escrow, channelId: delegatedId, cumulativeAmount: '100' })) }
    const wrong = await authorizeSessionRequest(c, payload, sign)
    expect((await f.submit(f.header(c, wrong))).status).toBe(402)
    const valid = await authorizeSessionRequest(c, payload, otherSign)
    expect((await f.submit(f.header(c, valid))).status).toBe(200)
  })
})

async function sponsoredOpen(f: ReturnType<typeof fixture>, type: 'permit2' | 'authorization', cumulative = '1', voucherSigner = sign) {
  const c = await f.challenge()
  const intent: S.FundingIntent = type === 'permit2'
    ? { action: 'open', type, salt, authorization: { from: account.address, permitted: { token, amount: '100' }, nonce: '1',
      deadline: String(Math.floor(Date.now() / 1000) + 60), witness: { payee: recipient, salt, authorizedSigner: P.zeroAddress } } }
    : { action: 'open', type, salt, authorization: { from: account.address, to: escrow, value: '100', validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 60), nonce: P.authorizationNonce({ from: account.address, payee: recipient, token, salt }) } }
  const payload = S.PayloadSchema.parse({ ...intent, signature: await sign(S.fundingTypedData(c.request, id, intent, domain)), channelId: id, cumulativeAmount: cumulative,
    voucherSignature: await voucherSigner(P.voucherTypedData({ chainId, escrowContract: escrow, channelId: id, cumulativeAmount: cumulative })) })
  return { c, payload: await authorizeSessionRequest(c, payload, sign) }
}

describe('validation before sponsored funding', () => {
  it.each(['permit2', 'authorization'] as const)('rejects an invalid %s voucher before funding', async type => {
    const f = fixture(), { c, payload } = await sponsoredOpen(f, type, '1', otherSign)
    expect((await f.submit(f.header(c, payload))).status).toBe(402)
    expect(f.adapter.fund).not.toHaveBeenCalled()
    expect(await f.method.manager.state(id)).toBeNull()
  })
  it.each(['101', '0'] as const)('rejects cumulative amount %s before funding', async amount => {
    const f = fixture(), { c, payload } = await sponsoredOpen(f, 'permit2', amount)
    expect((await f.submit(f.header(c, payload))).status).toBe(402)
    expect(f.adapter.fund).not.toHaveBeenCalled()
  })
  it('rejects missing or invalid HTTP authentication before funding', async () => {
    const f = fixture(), { c, payload } = await sponsoredOpen(f, 'permit2')
    const { requestAuthorization: _proof, ...body } = payload
    for (const invalid of [body, await authorizeSessionRequest(c, body, otherSign)]) {
      expect((await f.submit(f.header(c, invalid))).status).toBe(402)
    }
    expect(f.adapter.fund).not.toHaveBeenCalled()
  })
  it.each(['permit2', 'authorization'] as const)('funds a valid %s open before the channel exists', async type => {
    const f = fixture()
    let funded = false
    f.adapter.channel = vi.fn(async () => funded ? { ...f.chain } : null)
    f.adapter.fund = vi.fn(async () => { funded = true; return hash })
    const { c, payload } = await sponsoredOpen(f, type)
    expect((await f.submit(f.header(c, payload))).status).toBe(200)
    expect(f.adapter.fund).toHaveBeenCalledTimes(1)
    expect(await f.method.manager.state(id)).toMatchObject({ spent: '1' })
  })
  it('recovers an uncertain sponsored open without rebroadcasting or consuming twice', async () => {
    const f = fixture(), { c, payload } = await sponsoredOpen(f, 'permit2', '100')
    f.adapter.fund = vi.fn(async () => { throw new TransactionOutcomeUnknownError(hash) })
    const credential = f.header(c, payload)
    const first = await f.submit(credential)
    expect(first.status).toBe(402)
    if (first.status !== 402) throw new Error('Expected uncertainty')
    expect(first.challenge.status).toBe(503)
    expect((await f.submit(credential)).status).toBe(200)
    expect((await f.submit(credential)).status).toBe(402)
    expect(f.adapter.fund).toHaveBeenCalledTimes(1)
    expect(await f.method.manager.state(id)).toMatchObject({ spent: '1' })
  })
  it('rejects a top-up for a different payee before submitting', async () => {
    const f = fixture()
    f.chain.payee = other.address
    const foreignId = P.computeChannelId({ payer: account.address, payee: other.address, token, salt, escrowContract: escrow, chainId })
    const c = await f.challenge()
    const intent: S.FundingIntent = { action: 'topUp', type: 'permit2', authorization: { from: account.address, permitted: { token, amount: '1' },
      nonce: '2', deadline: '9999999999', witness: { channelId: foreignId } } }
    const body = S.PayloadSchema.parse({ ...intent, signature: await sign(S.fundingTypedData(c.request, foreignId, intent)), channelId: foreignId, additionalDeposit: '1' })
    const payload = await authorizeSessionRequest(c, body, sign)
    expect((await f.submit(f.header(c, payload))).status).toBe(402)
    expect(f.adapter.fund).not.toHaveBeenCalled()
  })
})

describe('contract-wallet Permit2 top-ups', () => {
  it('accepts variable-length funding and request signatures verified by ERC-1271', async () => {
    const f = fixture(); await f.open()
    const contract = other.address
    f.adapter.contractSignature = vi.fn(async (signer, _digest, signature) => signer === contract && signature === '0x1234')
    f.adapter.fund = vi.fn(async () => { f.chain.deposit = '110'; return hash })
    const c = await f.challenge()
    const body: S.Payload = { action: 'topUp', type: 'permit2', channelId: id, additionalDeposit: '10', signature: '0x1234',
      authorization: { from: contract, permitted: { token, amount: '10' }, nonce: '3', deadline: '9999999999', witness: { channelId: id } } }
    const payload = await authorizeSessionRequest(c, body, async () => '0x1234')
    expect((await f.submit(f.header(c, payload, P.formatSource(contract, chainId)))).status).toBe(200)
    expect(f.adapter.contractSignature).toHaveBeenCalledTimes(2)
    expect(f.adapter.fund).toHaveBeenCalledTimes(1)
    expect(await f.method.manager.state(id)).toMatchObject({ deposit: '110', spent: '1' })
  })
  it('still rejects an invalid EOA funding signature before submission', async () => {
    const f = fixture(); await f.open()
    const c = await f.challenge()
    const body: S.Payload = { action: 'topUp', type: 'permit2', channelId: id, additionalDeposit: '10', signature: '0x1234',
      authorization: { from: account.address, permitted: { token, amount: '10' }, nonce: '3', deadline: '9999999999', witness: { channelId: id } } }
    const payload = await authorizeSessionRequest(c, body, sign)
    expect((await f.submit(f.header(c, payload))).status).toBe(402)
    expect(f.adapter.fund).not.toHaveBeenCalled()
  })
})
