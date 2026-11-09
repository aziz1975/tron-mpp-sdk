import { Challenge, Credential, Store } from 'mppx'
import { keccak256, toBytes, type Hex, type TypedDataDefinition } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as P from '../src/protocol/Primitives.js'
import * as C from '../src/protocol/Charge.js'
import * as S from '../src/protocol/Session.js'
import { TransactionNotSubmittedError, TransactionOutcomeUnknownError, TransactionRevertedError } from '../src/protocol/Errors.js'
import { charge as clientCharge } from '../src/client/Charge.js'
import { session as clientSession, authorizeSessionRequest } from '../src/client/Session.js'
import { session as serverSession } from '../src/server/Session.js'
import { charge as serverCharge } from '../src/server/Charge.js'
import { assertIssuedChallenge, challengeTransport } from '../src/server/Challenges.js'
import { Mppx } from '../src/server/index.js'
import { createChargeAdapter } from '../src/tronweb/Charge.js'
import type { TronTransport } from '../src/tronweb/Transport.js'

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const token = P.normalizeAddress(`0x${'33'.repeat(20)}`)
const recipient = P.normalizeAddress(`0x${'44'.repeat(20)}`)
const escrow = P.normalizeAddress(`0x${'66'.repeat(20)}`)
const hash = `0x${'aa'.repeat(32)}` as Hex
const salt = `0x${'bb'.repeat(32)}` as Hex
const chainId = P.chains.nile
const source = P.formatSource(account.address, chainId)
const sign: P.TypedSigner = data => account.signTypedData(data as TypedDataDefinition)
function transport(): TronTransport {
  return { chainId, payer: account.address, call: vi.fn(async () => '0x' as Hex), send: vi.fn(async () => hash),
    signTransaction: vi.fn(async () => '{}'), broadcast: vi.fn(async () => hash),
    inspectTransaction: vi.fn(async () => ({ hash, from: account.address, to: token, data: '0x' as Hex })),
    info: vi.fn(async () => ({ id: hash.slice(2), blockNumber: 1, receipt: { result: 'SUCCESS' } })), blockNumber: async () => 1 }
}
function chargeChallenge(): C.Challenge & { method: 'tron'; intent: 'charge' } {
  return { id: 'review-charge', realm: 'api.test', method: 'tron', intent: 'charge', expires: new Date(Date.now() + 1000).toISOString(),
    request: { amount: '100', currency: token, recipient, methodDetails: { chainId, credentialTypes: ['hash'] } } }
}
function hashClient(adapter: C.Adapter) {
  return clientCharge({ adapter, chainIds: [chainId], currencies: [token], recipients: [recipient], maxAtomicAmount: '100', credentialTypes: ['hash'] })
}
afterEach(() => vi.useRealTimers())

describe('client charge recovery', () => {
  it('retains the known hash and cause when confirmation RPC fails, allowing recovery without another transfer', async () => {
    const t = transport(), cause = new Error('RPC unavailable')
    t.info = vi.fn(async () => { throw cause })
    const adapter = createChargeAdapter(t)
    const error = await hashClient(adapter).createCredential({ challenge: chargeChallenge() }).catch(error => error)
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(error).toBeInstanceOf(TransactionOutcomeUnknownError)
    expect(error).toMatchObject({ hash, details: { hash }, cause })
    t.info = vi.fn(async () => ({ id: hash.slice(2), blockNumber: 1, receipt: { result: 'SUCCESS' }, log: [{
      address: `41${token.slice(2)}`, topics: [keccak256(toBytes('Transfer(address,address,uint256)')),
        account.address.slice(2).padStart(64, '0'), recipient.slice(2).padStart(64, '0')], data: (100n).toString(16).padStart(64, '0'),
    }] }))
    const method = serverCharge({ adapter, chainId, currency: token, recipient, credentialTypes: ['hash'], store: Store.memory() })
    const route = Mppx.create({ secretKey: '0123456789abcdef0123456789abcdef', methods: [method] }).charge({ amount: '100' })
    const initial = await route(input)
    if (initial.status !== 402) throw new Error('Expected challenge')
    const challenge = Challenge.fromResponse(initial.challenge)
    const recovered = Credential.serialize(Credential.from({ challenge, source, payload: { type: 'hash', hash: error.hash } }))
    expect((await route(new Request(input, { headers: { Authorization: recovered } }))).status).toBe(200)
    expect((await route(new Request(input, { headers: { Authorization: recovered } }))).status).toBe(402)
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(t.broadcast).not.toHaveBeenCalled()
  })
  it('adds its known hash to a hashless uncertainty error from a custom confirmation transport', async () => {
    const t = transport(), cause = new TransactionOutcomeUnknownError()
    t.info = vi.fn(async () => { throw cause })
    await expect(hashClient(createChargeAdapter(t)).createCredential({ challenge: chargeChallenge() }))
      .rejects.toMatchObject({ hash, cause })
  })
  it('retains a confirmed hash when the challenge expires during payment', async () => {
    vi.useFakeTimers()
    const t = transport(), adapter = createChargeAdapter(t)
    t.info = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 2000)
      return { blockNumber: 1, receipt: { result: 'SUCCESS' } }
    })
    const error = await hashClient(adapter).createCredential({ challenge: chargeChallenge() }).catch(error => error)
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(error).toBeInstanceOf(TransactionOutcomeUnknownError)
    expect(error).toMatchObject({ hash, details: { hash } })
    expect(error.cause.message).toMatch(/expired/i)
  })
  it('keeps confirmation timeouts recoverable', async () => {
    const t = transport()
    t.info = vi.fn(async () => ({}))
    await expect(hashClient(createChargeAdapter(t, { timeoutMs: 0 })).createCredential({ challenge: chargeChallenge() }))
      .rejects.toMatchObject({ hash, details: { hash }, cause: { message: 'Transaction confirmation timed out.' } })
    expect(t.send).toHaveBeenCalledTimes(1)
  })
  it('preserves definitive reverts with their transaction hash', async () => {
    const t = transport()
    t.info = vi.fn(async () => ({ blockNumber: 1, receipt: { result: 'REVERT' } }))
    const error = await hashClient(createChargeAdapter(t)).createCredential({ challenge: chargeChallenge() }).catch(error => error)
    expect(error).toBeInstanceOf(TransactionRevertedError)
    expect(error).toMatchObject({ hash, status: 409, details: { hash } })
    expect(t.send).toHaveBeenCalledTimes(1)
  })
  it('preserves a definite failure before broadcast', async () => {
    const t = transport(), cause = new TransactionNotSubmittedError()
    t.send = vi.fn(async () => { throw cause })
    await expect(hashClient(createChargeAdapter(t)).createCredential({ challenge: chargeChallenge() })).rejects.toBe(cause)
    expect(t.info).not.toHaveBeenCalled()
  })
  it('creates signed transaction credentials without broadcasting or confirming', async () => {
    const t = transport(), challenge = chargeChallenge()
    challenge.request.methodDetails.credentialTypes = ['transaction']
    const client = clientCharge({ adapter: createChargeAdapter(t), chainIds: [chainId], currencies: [token], recipients: [recipient], maxAtomicAmount: '100' })
    const header = await client.createCredential({ challenge })
    expect(Credential.deserialize(header).payload).toEqual({ type: 'transaction', signature: '{}' })
    expect(t.send).not.toHaveBeenCalled()
    expect(t.info).not.toHaveBeenCalled()
  })
})

describe('prepaid session credit after settlement', () => {
  it('lets the client spend remaining prepaid units and rejects actual exhaustion at the server', async () => {
    const id = P.computeChannelId({ payer: account.address, payee: recipient, token, salt, escrowContract: escrow, chainId })
    const chain: S.Channel = { payer: account.address, payee: recipient, token, authorizedSigner: P.zeroAddress,
      deposit: '3', settled: '0', closeRequestedAt: '0', finalized: false }
    const adapter: S.Adapter = { chainId, escrowContract: escrow, gracePeriod: async () => 900, channel: async () => ({ ...chain }),
      verifyTransaction: async () => {}, settle: async (_id, amount) => { chain.settled = amount; return { hash } }, close: async () => ({ hash }) }
    const method = serverSession({ adapter, currency: token, recipient, store: Store.memory() })
    const route = Mppx.create({ secretKey: '0123456789abcdef0123456789abcdef', methods: [method] }).session({ amount: '1' })
    const initial = await route(new Request('https://api.test/session'))
    if (initial.status !== 402) throw new Error('Expected challenge')
    const issued = Challenge.fromResponse(initial.challenge)
    const challenge = { ...issued, method: 'tron' as const, intent: 'session' as const, request: S.RequestSchema.parse(issued.request) }
    const c = challenge
    const voucher: S.Payload = { action: 'voucher', channelId: id, cumulativeAmount: '3',
      signature: await sign(P.voucherTypedData({ chainId, escrowContract: escrow, channelId: id, cumulativeAmount: '3' })) }
    const open = await authorizeSessionRequest(c, { ...voucher, action: 'open', type: 'hash', hash, salt }, sign)
    const credential = Credential.serialize(Credential.from({ challenge, payload: open, source }))
    expect((await route(new Request('https://api.test/session', { headers: { Authorization: credential } }))).status).toBe(200)
    await method.manager.settle(id)
    expect(await method.manager.state(id)).toMatchObject({ acceptedCumulative: '3', spent: '1', settledOnChain: '3' })
    const execute = vi.fn(async () => voucher)
    const wallet: S.Wallet = { adapter, payer: account.address, createPayload: execute, signRequest: sign }
    const client = clientSession({ chainIds: [chainId], currencies: [token], escrowContracts: [escrow], payer: account.address,
      maxUnitAmount: '1', maxCumulativeAmount: '3', wallet, preparePayment: async () => ({ action: 'voucher', channelId: id, cumulativeAmount: '3' }) })
    for (let spent = 2; spent <= 3; spent++) {
      const header = await client.createCredential({ challenge })
      expect((await route(new Request('https://api.test/session', { headers: { Authorization: header } }))).status).toBe(200)
      expect(await method.manager.state(id)).toMatchObject({ spent: spent.toString() })
    }
    const exhausted = await client.createCredential({ challenge })
    expect((await route(new Request('https://api.test/session', { headers: { Authorization: exhausted } }))).status).toBe(402)
    expect(await method.manager.state(id)).toMatchObject({ spent: '3', acceptedCumulative: '3' })
  })
})

function bucketKey(id: string) { return `tron:issued:v2:${keccak256(toBytes(id)).slice(2, 4)}` }
function collidingChallenges(count: number): Challenge.Challenge[] {
  const first = chargeChallenge(), key = bucketKey(first.id)
  const result: Challenge.Challenge[] = [first]
  for (let i = 0; result.length < count; i++) {
    const candidate = { ...first, id: `collision-${i}` }
    if (bucketKey(candidate.id) === key) result.push(candidate)
  }
  return result
}
const input = new Request('https://api.test/charge')
describe('bounded issued challenge storage', () => {
  it('rejects excess challenges without evicting valid ones or advertising untracked payments', async () => {
    const store = Store.memory(), http = challengeTransport(store, 2), challenges = collidingChallenges(3)
    const results = await Promise.all(challenges.map(challenge => http.respondChallenge({ challenge, input })))
    expect(results.map(response => response.status).sort()).toEqual([402, 402, 503])
    const denied = results.findIndex(response => response.status === 503)
    expect(results[denied]!.headers.has('WWW-Authenticate')).toBe(false)
    for (const [i, challenge] of challenges.entries()) {
      if (i === denied) await expect(assertIssuedChallenge(store, challenge, 2)).rejects.toThrow()
      else await expect(assertIssuedChallenge(store, challenge, 2)).resolves.toBeUndefined()
    }
    const freshTransport = challengeTransport(store, 2)
    const accepted = challenges.find((_challenge, i) => i !== denied)!
    expect((await freshTransport.respondChallenge({ challenge: accepted, input })).status).toBe(402)
  })
  it('prunes expired entries on use and releases capacity without touching payment journals', async () => {
    vi.useFakeTimers()
    const store = Store.memory(), http = challengeTransport(store, 1), [first, second] = collidingChallenges(2)
    await store.put('tron:charge:transaction:3448148188:consumed', 'keep')
    await store.put('tron:session:accounting', { spent: '100' })
    expect((await http.respondChallenge({ challenge: first!, input })).status).toBe(402)
    vi.setSystemTime(Date.now() + 2000)
    await expect(assertIssuedChallenge(store, first!)).rejects.toThrow()
    expect(await store.get(bucketKey(first!.id))).toBeNull()
    second!.expires = new Date(Date.now() + 1000).toISOString()
    expect((await http.respondChallenge({ challenge: second!, input })).status).toBe(402)
    expect(await store.get(`tron:issued:${second!.id}`)).toBeNull()
    expect(await store.get('tron:charge:transaction:3448148188:consumed')).toBe('keep')
    expect(await store.get('tron:session:accounting')).toEqual({ spent: '100' })
    await expect(assertIssuedChallenge(store, { ...second!, realm: 'other.test' })).rejects.toThrow()
    await expect(assertIssuedChallenge(store, second!)).resolves.toBeUndefined()
  })
  it('reclaims expired capacity during new issuance without a prior verification', async () => {
    vi.useFakeTimers()
    const store = Store.memory(), http = challengeTransport(store, 1), [first, second] = collidingChallenges(2)
    await http.respondChallenge({ challenge: first!, input })
    vi.setSystemTime(Date.now() + 2000)
    second!.expires = new Date(Date.now() + 1000).toISOString()
    expect((await http.respondChallenge({ challenge: second!, input })).status).toBe(402)
    const bucket = await store.get(bucketKey(second!.id)) as { entries: Record<string, unknown> }
    expect(Object.keys(bucket.entries)).toHaveLength(1)
    await expect(assertIssuedChallenge(store, first!)).rejects.toThrow()
    await expect(assertIssuedChallenge(store, second!)).resolves.toBeUndefined()
  })
  it('migrates valid legacy records and removes expired legacy records when accessed', async () => {
    vi.useFakeTimers()
    const store = Store.memory(), challenge = chargeChallenge(), legacyKey = `tron:issued:${challenge.id}`
    await store.put(legacyKey, Challenge.serialize(challenge))
    await expect(assertIssuedChallenge(store, challenge)).resolves.toBeUndefined()
    expect(await store.get(legacyKey)).toBeNull()
    await expect(assertIssuedChallenge(store, challenge)).resolves.toBeUndefined()
    const expired = { ...challenge, id: 'expired-legacy' }
    await store.put(`tron:issued:${expired.id}`, Challenge.serialize(expired))
    vi.setSystemTime(Date.now() + 2000)
    await expect(assertIssuedChallenge(store, expired)).rejects.toThrow()
    expect(await store.get(`tron:issued:${expired.id}`)).toBeNull()
  })
  it('preserves a valid legacy challenge while its new registry bucket is full', async () => {
    const store = Store.memory(), [current, legacy] = collidingChallenges(2)
    await challengeTransport(store, 1).respondChallenge({ challenge: current!, input })
    const key = `tron:issued:${legacy!.id}`
    await store.put(key, Challenge.serialize(legacy!))
    await expect(assertIssuedChallenge(store, legacy!, 1)).resolves.toBeUndefined()
    expect(await store.get(key)).toBe(Challenge.serialize(legacy!))
    await expect(assertIssuedChallenge(store, current!, 1)).resolves.toBeUndefined()
  })
  it.each([undefined, 'invalid', '2000-01-01T00:00:00Z'])('does not issue a challenge with invalid expiry %s', async expires => {
    const challenge = { ...chargeChallenge(), expires }
    const result = await challengeTransport(Store.memory()).respondChallenge({ challenge, input })
    expect(result.status).toBe(500)
    expect(result.headers.has('WWW-Authenticate')).toBe(false)
  })
  it.each([0, -1, 1.5, Infinity])('rejects invalid capacity %s', limit => {
    expect(() => challengeTransport(Store.memory(), limit)).toThrow(RangeError)
  })
  it('uses bounded records in the charge HTTP integration', async () => {
    const store = Store.memory()
    const method = serverCharge({ adapter: createChargeAdapter(transport()), chainId, currency: token, recipient, credentialTypes: ['transaction'], store })
    const route = Mppx.create({ secretKey: '0123456789abcdef0123456789abcdef', methods: [method] }).charge({ amount: '100' })
    const result = await route(input)
    if (result.status !== 402) throw new Error('Expected challenge')
    const challenge = Challenge.fromResponse(result.challenge)
    expect(await store.get(`tron:issued:${challenge.id}`)).toBeNull()
    await expect(assertIssuedChallenge(store, challenge)).resolves.toBeUndefined()
  })
})

describe('nonthrowing public schema validation', () => {
  it.each(['1.25', 'not-a-number', '0x10', '-1', '+1', '01', ' 1', '', '9'.repeat(10000), null, 1])('rejects malformed numbers %s without throwing', value => {
    expect(P.Uint256Schema.safeParse(value).success).toBe(false)
    expect(P.Uint128Schema.safeParse(value).success).toBe(false)
    expect(C.RequestSchema.safeParse({ ...chargeChallenge().request, amount: value }).success).toBe(false)
    expect(S.RequestSchema.safeParse({ amount: value, currency: token, recipient, methodDetails: { chainId, escrowContract: escrow } }).success).toBe(false)
    expect(S.PaymentPlanSchema.safeParse({ action: 'voucher', channelId: hash, cumulativeAmount: value }).success).toBe(false)
  })
  it('preserves integer boundaries and positive charge amounts', () => {
    expect(P.Uint256Schema.safeParse(((1n << 256n) - 1n).toString()).success).toBe(true)
    expect(P.Uint256Schema.safeParse((1n << 256n).toString()).success).toBe(false)
    expect(P.Uint128Schema.safeParse(((1n << 128n) - 1n).toString()).success).toBe(true)
    expect(P.Uint128Schema.safeParse((1n << 128n).toString()).success).toBe(false)
    expect(P.Uint128Schema.safeParse('0').success).toBe(true)
    expect(C.RequestSchema.safeParse({ ...chargeChallenge().request, amount: '0' }).success).toBe(false)
  })
  it.each(['0x', `0x${'00'.repeat(65)}`, `0x${'ff'.repeat(65)}`, 'invalid', null])('rejects malformed or noncanonical signatures %s without throwing', signature => {
    expect(P.SignatureSchema.safeParse(signature).success).toBe(false)
    expect(C.AuthorizationPayloadSchema.safeParse({ type: 'authorization', from: account.address, to: recipient, value: '100', validAfter: '0', validBefore: '1', nonce: hash, signature }).success).toBe(false)
  })
  it('accepts a valid canonical signature', async () => {
    const signature = await sign(P.voucherTypedData({ chainId, escrowContract: escrow, channelId: hash, cumulativeAmount: '100' }))
    expect(P.SignatureSchema.safeParse(signature)).toMatchObject({ success: true, data: signature.toLowerCase() })
  })
  it.each(['invalid', 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeB0', '0x1234', null])('rejects invalid addresses %s without throwing', address => {
    expect(P.AddressSchema.safeParse(address).success).toBe(false)
    expect(P.TokenAddressSchema.safeParse(address).success).toBe(false)
  })
  it('preserves address normalization and rejects the native zero address as a token', () => {
    expect(P.AddressSchema.parse(P.toBase58Address(token))).toBe(token)
    expect(P.TokenAddressSchema.safeParse(P.zeroAddress).success).toBe(false)
  })
})
