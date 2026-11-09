import { Challenge, Credential, Store } from 'mppx'
import { privateKeyToAccount } from 'viem/accounts'
import { encodeAbiParameters, encodeErrorResult, parseAbi, stringToHex, type Hex, type TypedDataDefinition } from 'viem'
import type { TronWeb } from 'tronweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as P from '../src/index.js'
import * as S from '../src/protocol/Session.js'
import { session as clientSession, authorizeSessionRequest } from '../src/client/Session.js'
import { SessionManager, needVoucherEvent, session as serverSession } from '../src/server/Session.js'
import { Mppx } from '../src/server/index.js'
import { Mppx as ClientMppx } from '../src/client/index.js'
import { createSessionAdapter, createSessionWallet } from '../src/tronweb/Session.js'
import { createTronWebTransport, type TronTransport } from '../src/tronweb/Transport.js'

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
const sign: P.TypedSigner = data => account.signTypedData(data as TypedDataDefinition)
const domain = { name: 'Token', version: '2' }
const id = P.computeChannelId({ payer: account.address, payee: recipient, token, salt, escrowContract: escrow, chainId })
function fixture() {
  const request: S.Request = { amount: '1', currency: token, recipient, methodDetails: { chainId, escrowContract: escrow, credentialTypes: ['hash'], minVoucherDelta: '10' } }
  const chain: S.Channel = { payer: account.address, payee: recipient, token, authorizedSigner: P.zeroAddress, deposit: '200', settled: '0', closeRequestedAt: '0', finalized: false }
  const adapter: S.Adapter = { chainId, escrowContract: escrow, channel: vi.fn(async () => ({ ...chain })), gracePeriod: async () => 900,
    verifyTransaction: vi.fn(async () => {}), fund: vi.fn(async () => hash),
    close: vi.fn(async (_id, amount) => { chain.finalized = true; chain.settled = amount; return { hash } }), settle: vi.fn(async () => ({ hash })) }
  const store = Store.memory()
  const parameters = { adapter, currency: token, recipient, credentialTypes: ['hash', 'permit2', 'authorization'] as const, permit2Contract: permit2, authorizationDomain: domain, store }
  const manager = new SessionManager(parameters)
  const voucher = async (amount = '100'): Promise<Extract<S.Payload, { action: 'voucher' }>> => ({ action: 'voucher', channelId: id, cumulativeAmount: amount,
    signature: await sign(P.voucherTypedData({ chainId, escrowContract: escrow, channelId: id, cumulativeAmount: amount })) })
  const open = async () => manager.accept(request, { ...await voucher(), action: 'open', type: 'hash', hash, salt }, source)
  const challenge = () => ({ id: 'alignment-session', realm: 'api.test', method: 'tron' as const, intent: 'session' as const,
    expires: new Date(Date.now() + 300_000).toISOString(), request })
  return { request, chain, adapter, store, parameters, manager, voucher, open, challenge }
}
function transport(): TronTransport {
  return { chainId, payer: account.address, signTypedData: vi.fn(sign),
    call: vi.fn(async () => encodeAbiParameters([{ type: 'address' }], [permit2])), send: vi.fn(async () => hash),
    inspectTransaction: async () => ({ hash, from: account.address, to: escrow, data: '0x' }), signTransaction: async () => '{}', broadcast: async () => hash,
    info: async () => ({ blockNumber: 1, receipt: { result: 'SUCCESS' } }), blockNumber: async () => 1 }
}
function client(f: ReturnType<typeof fixture>, wallet: S.Wallet, plan: S.PaymentPlan, limit = '100') {
  return clientSession({ chainIds: [chainId], currencies: [token], escrowContracts: [escrow], payer: account.address,
    maxUnitAmount: '1', maxCumulativeAmount: limit, wallet, preparePayment: vi.fn(async () => plan) })
}
async function funding(f: ReturnType<typeof fixture>, type: 'permit2' | 'authorization'): Promise<S.Funding> {
  f.request.methodDetails.feePayer = true
  f.request.methodDetails.credentialTypes = [type]
  f.request.methodDetails.permit2Contract = permit2
  const intent: S.FundingIntent = type === 'permit2'
    ? { action: 'open', type, salt, authorization: { from: account.address, permitted: { token, amount: '200' }, nonce: '1', deadline: String(Math.floor(Date.now() / 1000) + 60), witness: { payee: recipient, salt, authorizedSigner: P.zeroAddress } } }
    : { action: 'open', type, salt, authorization: { from: account.address, to: escrow, value: '200', validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 60), nonce: P.authorizationNonce({ from: account.address, payee: recipient, token, salt }) } }
  return S.FundingSchema.parse({ ...intent, signature: await sign(S.fundingTypedData(f.request, id, intent, domain)) })
}
afterEach(() => vi.useRealTimers())

describe('sponsored funding expiry and recovery', () => {
  it.each(['permit2', 'authorization'] as const)('verifies a saved %s funding hash after expiry without signing or broadcasting again', async type => {
    vi.useFakeTimers()
    const f = fixture(), signed = await funding(f, type)
    const payload = S.PayloadSchema.parse({ ...signed, channelId: id, cumulativeAmount: '100', voucherSignature: (await f.voucher()).signature })
    f.adapter.fund = vi.fn(async () => { throw new P.TransactionOutcomeUnknownError(hash) })
    await expect(f.manager.accept(f.request, payload)).rejects.toMatchObject({ status: 503, hash })
    vi.setSystemTime(Date.now() + 61_000)
    await expect(new SessionManager(f.parameters).accept(f.request, payload)).resolves.toMatchObject({ acceptedCumulative: '100' })
    expect(f.adapter.fund).toHaveBeenCalledTimes(1)
    expect(f.adapter.verifyTransaction).toHaveBeenCalledWith(hash, 'open', id, '200')
  })
  it('rejects an expired authorization with no previously submitted payment', async () => {
    vi.useFakeTimers()
    const f = fixture(), signed = await funding(f, 'permit2')
    const payload = S.PayloadSchema.parse({ ...signed, channelId: id, cumulativeAmount: '100', voucherSignature: (await f.voucher()).signature })
    vi.setSystemTime(Date.now() + 61_000)
    await expect(f.manager.accept(f.request, payload)).rejects.toThrow(/deadline/)
    expect(f.adapter.fund).not.toHaveBeenCalled()
  })
  it('rejects a changed signature attempting to recover a saved authorization', async () => {
    const f = fixture(), signed = await funding(f, 'permit2')
    const payload = S.PayloadSchema.parse({ ...signed, channelId: id, cumulativeAmount: '100', voucherSignature: (await f.voucher()).signature })
    f.adapter.fund = vi.fn(async () => { throw new P.TransactionOutcomeUnknownError(hash) })
    await expect(f.manager.accept(f.request, payload)).rejects.toMatchObject({ status: 503 })
    const changed = { ...payload, signature: await other.signTypedData(S.fundingTypedData(f.request, id, signed) as TypedDataDefinition) }
    await expect(f.manager.accept(f.request, changed)).rejects.toThrow(/differs/)
    expect(f.adapter.verifyTransaction).not.toHaveBeenCalled()
  })
  it('retains an unresolved hashless reservation after expiry', async () => {
    vi.useFakeTimers()
    const f = fixture(), signed = await funding(f, 'permit2')
    const payload = S.PayloadSchema.parse({ ...signed, channelId: id, cumulativeAmount: '100', voucherSignature: (await f.voucher()).signature })
    f.adapter.fund = vi.fn(async () => { throw new Error('RPC disconnected') })
    await expect(f.manager.accept(f.request, payload)).rejects.toMatchObject({ status: 503 })
    vi.setSystemTime(Date.now() + 61_000)
    await expect(f.manager.accept(f.request, payload)).rejects.toMatchObject({ status: 503 })
    expect(f.adapter.fund).toHaveBeenCalledTimes(1)
  })
  it('reconciles a known funding submission without accepting a voucher or serving a request', async () => {
    vi.useFakeTimers()
    const f = fixture(), signed = await funding(f, 'permit2')
    const payload = S.PayloadSchema.parse({ ...signed, channelId: id, cumulativeAmount: '100', voucherSignature: (await f.voucher()).signature })
    f.adapter.fund = vi.fn(async () => { throw new P.TransactionOutcomeUnknownError(hash) })
    await expect(f.manager.accept(f.request, payload)).rejects.toMatchObject({ status: 503 })
    vi.setSystemTime(Date.now() + 360_000)
    expect(await new SessionManager(f.parameters).reconcileFunding(f.request, id, signed)).toBe(hash)
    expect(await f.manager.state(id)).toBeNull()
    expect(f.adapter.fund).toHaveBeenCalledTimes(1)
  })
  it('never starts a new payment through reconcileFunding', async () => {
    const f = fixture(), signed = await funding(f, 'authorization')
    await expect(f.manager.reconcileFunding(f.request, id, signed)).rejects.toMatchObject({ status: 503 })
    expect(f.adapter.fund).not.toHaveBeenCalled()
  })
})

describe('cooperative close and streaming events', () => {
  it('closes with a valid final increment smaller than minVoucherDelta', async () => {
    const f = fixture(); await f.open(); await f.manager.consume(f.request, id)
    await expect(f.manager.accept(f.request, { ...await f.voucher('105'), action: 'close' })).resolves.toMatchObject({ closed: true })
    expect(f.adapter.close).toHaveBeenCalledWith(id, '105', expect.anything())
  })
  it('still rejects small ordinary voucher increments and underfunded close requests', async () => {
    const f = fixture(); await f.open()
    await expect(f.manager.accept(f.request, await f.voucher('105'))).rejects.toMatchObject({ code: 'delta-too-small' })
    await f.manager.consume(f.request, id, 50)
    await expect(f.manager.accept(f.request, { ...await f.voucher('49'), action: 'close' })).rejects.toMatchObject({ code: 'insufficient-balance' })
    expect(f.adapter.close).not.toHaveBeenCalled()
  })
  it('emits every required payment-need-voucher field and canonical channel IDs', () => {
    const event = needVoucherEvent({ channelId: `0x${id.slice(2).toUpperCase()}`, requiredCumulative: '101', acceptedCumulative: '100', deposit: '200' })
    expect(event).toBe(`event: payment-need-voucher\ndata: ${JSON.stringify({ channelId: id, requiredCumulative: '101', acceptedCumulative: '100', deposit: '200' })}\n\n`)
    expect(() => needVoucherEvent({ channelId: id, requiredCumulative: (1n << 128n).toString(), acceptedCumulative: '100', deposit: '200' })).toThrow()
  })
})

describe('session client policy before wallet execution', () => {
  it.each(['open', 'voucher', 'close'] as const)('rejects a %s above the cumulative limit before the wallet is called', async action => {
    const f = fixture(), t = transport(), wallet = createSessionWallet(t, escrow)
    const execute = vi.spyOn(wallet, 'createPayload')
    wallet.adapter.channel = async () => f.chain
    const plan: S.PaymentPlan = action === 'open' ? { action, type: 'hash', deposit: '200', cumulativeAmount: '101' } : { action, channelId: id, cumulativeAmount: '101' }
    await expect(client(f, wallet, plan).createCredential({ challenge: f.challenge() })).rejects.toThrow(/cumulative limit/)
    expect(execute).not.toHaveBeenCalled()
    expect(t.signTypedData).not.toHaveBeenCalled()
    expect(t.send).not.toHaveBeenCalled()
  })
  it('enforces the same limit when the wallet executor is called directly', async () => {
    const f = fixture(), t = transport(), wallet = createSessionWallet(t, escrow)
    await expect(wallet.createPayload(f.request, { action: 'open', type: 'hash', deposit: '200', cumulativeAmount: '101' }, { maxCumulativeAmount: '100' })).rejects.toThrow(/cumulative limit/)
    expect(t.signTypedData).not.toHaveBeenCalled(); expect(t.send).not.toHaveBeenCalled()
  })
  it('rejects expired or malformed expiry before preparing a payment', async () => {
    const f = fixture(), t = transport(), wallet = createSessionWallet(t, escrow), preparePayment = vi.fn()
    const method = clientSession({ chainIds: [chainId], currencies: [token], escrowContracts: [escrow], payer: account.address,
      maxUnitAmount: '1', maxCumulativeAmount: '100', wallet, preparePayment })
    for (const expires of ['invalid', new Date(Date.now() - 1).toISOString()]) await expect(method.createCredential({ challenge: { ...f.challenge(), expires } })).rejects.toThrow(/expired/)
    expect(preparePayment).not.toHaveBeenCalled(); expect(t.send).not.toHaveBeenCalled()
  })
  it('rejects a wallet payer mismatch before execution', async () => {
    const f = fixture(), t = transport(), wallet = createSessionWallet({ ...t, payer: other.address }, escrow)
    await expect(client(f, wallet, { action: 'open', type: 'hash', deposit: '200', cumulativeAmount: '100' }).createCredential({ challenge: f.challenge() })).rejects.toThrow(/payer mismatch/)
    expect(t.send).not.toHaveBeenCalled()
  })
  it('rechecks expiry after payment preparation and after an approval is confirmed', async () => {
    vi.useFakeTimers()
    const f = fixture(), t = transport(), wallet = createSessionWallet(t, escrow)
    const method = clientSession({ chainIds: [chainId], currencies: [token], escrowContracts: [escrow], payer: account.address,
      maxUnitAmount: '1', maxCumulativeAmount: '100', wallet, preparePayment: async () => {
        vi.setSystemTime(Date.now() + 360_000)
        return { action: 'open', type: 'hash', deposit: '200', cumulativeAmount: '100' }
      } })
    const challenge = f.challenge()
    await expect(method.createCredential({ challenge })).rejects.toThrow(/expired/)
    expect(t.signTypedData).not.toHaveBeenCalled(); expect(t.send).not.toHaveBeenCalled()
    const active = f.challenge()
    t.info = async () => {
      vi.setSystemTime(Date.now() + 360_000)
      return { blockNumber: 1, receipt: { result: 'SUCCESS' } }
    }
    await expect(client(f, wallet, { action: 'open', type: 'hash', deposit: '200', cumulativeAmount: '100' }).createCredential({ challenge: active })).rejects.toThrow(/expired/)
    expect(t.send).toHaveBeenCalledTimes(1) // Approval only; expired channel funding is never sent.
  })
  it.each(['empty', 'payer', 'payee', 'token', 'finalized', 'closing'] as const)('rejects an invalid resume channel: %s', async invalid => {
    const f = fixture(), t = transport(), wallet = createSessionWallet(t, escrow)
    f.request.methodDetails.channelId = id
    if (invalid === 'empty') f.chain.deposit = '0'
    if (invalid === 'payer') f.chain.payer = other.address
    if (invalid === 'payee') f.chain.payee = other.address
    if (invalid === 'token') f.chain.token = recipient
    if (invalid === 'finalized') f.chain.finalized = true
    if (invalid === 'closing') f.chain.closeRequestedAt = '1'
    wallet.adapter.channel = vi.fn(async () => ({ ...f.chain }))
    await expect(client(f, wallet, { action: 'voucher', channelId: id, cumulativeAmount: '100' }).createCredential({ challenge: f.challenge() })).rejects.toThrow()
    expect(t.signTypedData).not.toHaveBeenCalled(); expect(t.send).not.toHaveBeenCalled()
  })
  it('queries a funded resume channel before signing a voucher', async () => {
    const f = fixture(), t = transport(), wallet = createSessionWallet(t, escrow), events: string[] = []
    f.request.methodDetails.channelId = id
    wallet.adapter.channel = vi.fn(async () => { events.push('read'); return { ...f.chain } })
    t.signTypedData = async data => { events.push('sign'); return sign(data) }
    // The transport's signer is captured by reference at wallet signing time.
    const header = await client(f, wallet, { action: 'voucher', channelId: id, cumulativeAmount: '100' }).createCredential({ challenge: f.challenge() })
    expect(Credential.deserialize(header).payload).toMatchObject({ action: 'voucher', channelId: id })
    expect(events.indexOf('read')).toBeLessThan(events.indexOf('sign'))
  })
  it('allows a top-up management plan on an exhausted channel', async () => {
    const f = fixture(), t = transport(), wallet = createSessionWallet(t, escrow)
    f.request.methodDetails.channelId = id; f.chain.settled = f.chain.deposit
    wallet.adapter.channel = async () => ({ ...f.chain })
    wallet.adapter.verifyTransaction = vi.fn(async () => {})
    const header = await client(f, wallet, { action: 'topUp', type: 'hash', channelId: id, additionalDeposit: '10' }).createCredential({ challenge: f.challenge() })
    expect(Credential.deserialize(header).payload).toMatchObject({ action: 'topUp', additionalDeposit: '10' })
    expect(t.send).toHaveBeenCalledTimes(2)
  })
  it('opens a channel only after the unsigned plan passes policy', async () => {
    const f = fixture(), t = transport(), wallet = createSessionWallet(t, escrow)
    wallet.adapter.verifyTransaction = vi.fn(async () => {})
    const header = await client(f, wallet, { action: 'open', type: 'hash', deposit: '200', cumulativeAmount: '100' }).createCredential({ challenge: f.challenge() })
    expect(Credential.deserialize(header).payload).toMatchObject({ action: 'open', cumulativeAmount: '100' })
    expect(t.signTypedData).toHaveBeenCalledTimes(2); expect(t.send).toHaveBeenCalledTimes(2)
  })
  it.each(['permit2', 'authorization'] as const)('signs a prepared %s opening without broadcasting on the client', async type => {
    const f = fixture(), signed = await funding(f, type), t = transport(), wallet = createSessionWallet(t, escrow, { authorizationDomain: domain })
    const plan = S.PaymentPlanSchema.parse({ ...signed, channelId: id, cumulativeAmount: '100' })
    const header = await client(f, wallet, plan).createCredential({ challenge: f.challenge() })
    expect(Credential.deserialize(header).payload).toMatchObject({ action: 'open', type, channelId: id })
    expect(t.signTypedData).toHaveBeenCalledTimes(3); expect(t.send).not.toHaveBeenCalled()
  })
  it('allows an authorized third party to prepare a sponsored top-up', async () => {
    const f = fixture(), t = transport()
    t.payer = other.address
    t.signTypedData = vi.fn(data => other.signTypedData(data as TypedDataDefinition))
    const wallet = createSessionWallet(t, escrow)
    wallet.adapter.channel = async () => ({ ...f.chain })
    f.request.methodDetails = { ...f.request.methodDetails, channelId: id, credentialTypes: ['permit2'], feePayer: true, permit2Contract: permit2 }
    const plan: S.PaymentPlan = { action: 'topUp', type: 'permit2', channelId: id, additionalDeposit: '10',
      authorization: { from: other.address, permitted: { token, amount: '10' }, nonce: '7', deadline: String(Math.floor(Date.now() / 1000) + 60), witness: { channelId: id } } }
    const method = clientSession({ chainIds: [chainId], currencies: [token], escrowContracts: [escrow], payer: other.address,
      maxUnitAmount: '1', maxCumulativeAmount: '100', wallet, preparePayment: async () => plan })
    const header = await method.createCredential({ challenge: f.challenge() })
    expect(Credential.deserialize(header)).toMatchObject({ source: P.formatSource(other.address, chainId), payload: { action: 'topUp', type: 'permit2' } })
    expect(t.signTypedData).toHaveBeenCalledTimes(2); expect(t.send).not.toHaveBeenCalled()
  })
  it('runs the automatic HTTP session flow with an unsigned plan and a real wallet signature', async () => {
    const f = fixture(), t = transport(), wallet = createSessionWallet(t, escrow)
    wallet.adapter.verifyTransaction = vi.fn(async () => {})
    const server = Mppx.create({ secretKey: '0123456789abcdef0123456789abcdef', methods: [serverSession(f.parameters)] })
    const route = server.session({ amount: '1', methodDetails: f.request.methodDetails })
    const method = client(f, wallet, { action: 'open', type: 'hash', deposit: '200', cumulativeAmount: '100' })
    const http = ClientMppx.create({ polyfill: false, methods: [method], fetch: async (input, init) => {
      const result = await route(new Request(input, init))
      return result.status === 402 ? result.challenge : result.withReceipt(Response.json({ paid: true }))
    } })
    const response = await http.fetch('https://api.test/session')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ paid: true })
    expect(t.signTypedData).toHaveBeenCalledTimes(2); expect(t.send).toHaveBeenCalledTimes(2)
  })
})

describe('session simulation error mapping', () => {
  const cases = [
    ['InvalidSignature', 'invalid-signature', 402], ['AmountExceedsDeposit', 'amount-exceeds-deposit', 402],
    ['ChannelNotFound', 'channel-not-found', 410], ['ChannelFinalized', 'channel-finalized', 410],
    ['TokenTransferFailed', 'insufficient-balance', 402], ['NotPayee', 'signer-mismatch', 402],
    ['NonceAlreadyUsed', 'transaction-reverted', 409],
  ] as const
  it.each(cases)('maps %s to the standard %s problem', async (name, code, status) => {
    const t = transport(), data = encodeErrorResult({ abi: parseAbi([`error ${name}()`]), errorName: name })
    t.call = async () => { throw new P.ContractCallRevertedError(data) }
    await expect(createSessionAdapter(t, escrow).settle(id, '100', '0x')).rejects.toMatchObject({ code, status, type: `https://paymentauth.org/problems/session/${code}` })
    expect(t.send).not.toHaveBeenCalled()
  })
  it('preserves raw node revert data even when TronWeb would throw away result.message', async () => {
    const data = encodeErrorResult({ abi: parseAbi(['error InvalidSignature()']), errorName: 'InvalidSignature' })
    const request = vi.fn(async () => ({ result: { result: false, message: stringToHex('REVERT opcode executed').slice(2) }, constant_result: [data.slice(2)] }))
    const wallet = { defaultAddress: { base58: source.split(':').at(-1) }, fullNode: { request } } as unknown as TronWeb
    const t = createTronWebTransport(wallet, { chainId }); t.send = vi.fn()
    await expect(createSessionAdapter(t, escrow).settle(id, '100', '0x')).rejects.toMatchObject({ code: 'invalid-signature', status: 402 })
    expect(request).toHaveBeenCalledWith('wallet/triggerconstantcontract', expect.objectContaining({ contract_address: `41${escrow.slice(2)}` }), 'post')
    expect(t.send).not.toHaveBeenCalled()
  })
  it('keeps network failures distinct and releases preflight-rejected settlement operations', async () => {
    const f = fixture(); await f.open()
    const t = transport(), adapter = createSessionAdapter(t, escrow)
    t.call = async () => { throw new Error('network unavailable') }
    await expect(adapter.settle(id, '100', '0x')).rejects.toBeInstanceOf(P.TransactionNotSubmittedError)
    t.call = async () => { throw new P.ContractCallRevertedError() }
    f.adapter.settle = adapter.settle
    await expect(f.manager.settle(id)).rejects.toMatchObject({ code: 'transaction-reverted', status: 409 })
    expect((await f.manager.state(id))?.operation).toBeUndefined()
    expect(t.send).not.toHaveBeenCalled()
  })
  it('returns a session problem over HTTP without a receipt when close preflight fails', async () => {
    const f = fixture(); await f.open()
    const t = transport()
    t.call = async () => { throw new P.ContractCallRevertedError() }
    f.adapter.close = createSessionAdapter(t, escrow).close
    const server = Mppx.create({ secretKey: '0123456789abcdef0123456789abcdef', methods: [serverSession(f.parameters)] })
    const route = server.session({ amount: '1', methodDetails: f.request.methodDetails })
    const initial = await route(new Request('https://api.test/session'))
    if (initial.status !== 402) throw new Error('Expected challenge')
    const challenge = Challenge.fromResponse(initial.challenge)
    const payload = await authorizeSessionRequest({ ...challenge, request: S.RequestSchema.parse(challenge.request) }, { ...await f.voucher('105'), action: 'close' }, sign)
    const credential = Credential.serialize(Credential.from({ challenge, payload, source }))
    const result = await route(new Request('https://api.test/session', { headers: { Authorization: credential } }))
    if (result.status !== 402) throw new Error('Expected rejection')
    expect(result.challenge.status).toBe(409)
    expect(result.challenge.headers.has('Payment-Receipt')).toBe(false)
    expect(await result.challenge.json()).toMatchObject({ type: 'https://paymentauth.org/problems/session/transaction-reverted' })
  })
})
