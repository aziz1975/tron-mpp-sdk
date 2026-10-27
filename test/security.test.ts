import { Challenge, Credential, Store } from 'mppx'
import { TronWeb, Trx } from 'tronweb'
import { describe, expect, it, vi } from 'vitest'

import { charge as clientCharge } from '../src/client/Charge.js'
import * as Methods from '../src/Methods.js'
import { paymentProofMessage, verifyPaymentProof } from '../src/Proof.js'
import { charge as serverCharge } from '../src/server/Charge.js'
import { Mppx, tron } from '../src/server/index.js'
import { createTronWebSigner, createTronWebVerifier, type TronWebLike } from '../src/tronweb/index.js'
import * as Types from '../src/Types.js'

// Public test keys only; no transactions leave this process.
const privateKey = '1'.repeat(64)
const attackerKey = '2'.repeat(64)
const wallet = new TronWeb({ fullHost: 'http://127.0.0.1:8090', privateKey })
const payer = wallet.defaultAddress.base58 as string
const recipient = TronWeb.address.fromPrivateKey('3'.repeat(64)) as string
const tokenHex = `41${'41'}${'22'.repeat(19)}`
const token = TronWeb.address.fromHex(tokenHex)
const txId = 'a'.repeat(64)
type TronChallenge = Challenge.Challenge<Types.ChargeRequest, 'charge', 'tron'>

function challenge(id = 'security-challenge'): TronChallenge {
  return Challenge.fromMethod(Methods.charge, {
    id, realm: 'example.com',
    request: { amount: '1', asset: { type: 'native' }, network: 'nile', recipient },
  }) as TronChallenge
}

function payload(c = challenge(), key = privateKey, transactionId = txId): Types.TransactionPayload {
  return {
    payer, txId: transactionId, type: 'transaction',
    signature: Trx.signMessageV2(paymentProofMessage({
      challengeId: c.id, request: c.request, payer, txId: transactionId,
    }), key),
  }
}

function verification(c = challenge(), p = payload(c)) {
  return { credential: { challenge: c, payload: p }, request: c.request }
}

function serverVerification(c = challenge(), p = payload(c)) {
  return {
    credential: { challenge: c, payload: p },
    request: {
      amount: '1', asset: c.request.methodDetails.asset,
      network: c.request.methodDetails.network, recipient: c.request.recipient,
    },
  }
}

function adapter() {
  return {
    address: wallet.address,
    defaultAddress: { base58: payer },
    trx: {
      signMessageV2: vi.fn((message: string) => Trx.signMessageV2(message, privateKey)),
      sendTransaction: vi.fn(async () => ({ result: true, transaction: { txID: txId } })),
      getCurrentBlock: vi.fn(async () => ({ block_header: { raw_data: { number: 12 } } })),
      getTransaction: vi.fn(async (): Promise<unknown> => ({
        ret: [{ contractRet: 'SUCCESS' }],
        raw_data: { contract: [{ type: 'TransferContract', parameter: { value: {
          amount: 1000000,
          owner_address: wallet.address.toHex(payer),
          to_address: wallet.address.toHex(recipient),
        } } }] },
      })),
      getTransactionInfo: vi.fn(async (): Promise<unknown> => ({
        blockNumber: 12, blockTimeStamp: 1767225600000,
      })),
    },
  } satisfies TronWebLike
}

function server(store: Store.AtomicStore = Store.memory(), storeKeyPrefix?: string) {
  const verifier = vi.fn(async ({ credential }: Parameters<Types.ChargeVerifier>[0]) => ({
    payer: credential.payload.payer, reference: credential.payload.txId,
  }))
  const method = serverCharge({
    asset: { type: 'native' }, network: 'nile', recipient, store, verifier,
    ...(storeKeyPrefix !== undefined ? { storeKeyPrefix } : {}),
  })
  return { method, verifier }
}

describe('payer ownership', () => {
  it('verifies real TronWeb signatures, including non-ASCII challenge IDs', async () => {
    const c = challenge('challenge-é-支付')
    await expect(verifyPaymentProof({
      challengeId: c.id, request: c.request, ...payload(c),
    })).resolves.toBe(true)
    await expect(server().method.verify(serverVerification(c))).resolves.toMatchObject({ status: 'success' })
  })

  it.each([
    'missing', 'invalid', 'wrong-key', 'different-challenge', 'different-transaction',
    'different-amount', 'different-network', 'different-recipient', 'different-asset',
    'different-payer', 'different-confirmations',
  ])(
    'rejects %s proofs before verification or replay-store consumption', async (mutation) => {
      const c = challenge()
      const p = payload(c)
      if (mutation === 'missing') delete (p as Partial<Types.TransactionPayload>).signature
      if (mutation === 'invalid') p.signature = '0'.repeat(130)
      if (mutation === 'wrong-key') p.signature = payload(c, attackerKey).signature
      if (mutation === 'different-challenge') c.id = 'another-challenge'
      if (mutation === 'different-transaction') p.txId = 'b'.repeat(64)
      if (mutation === 'different-amount') c.request.amount = '2000000'
      if (mutation === 'different-network') c.request.methodDetails.network = 'mainnet'
      if (mutation === 'different-recipient') c.request.recipient = payer
      if (mutation === 'different-payer') p.payer = recipient
      if (mutation === 'different-confirmations') c.request.methodDetails.minConfirmations = 1
      if (mutation === 'different-asset') {
        c.request.currency = token
        c.request.methodDetails.asset = { type: 'trc20', contractAddress: token, symbol: 'USDT', decimals: 6 }
      }
      const { method, verifier } = server()
      await expect(method.verify(serverVerification(c, p))).rejects.toThrow()
      expect(verifier).not.toHaveBeenCalled()
      const original = challenge()
      await expect(method.verify(serverVerification(original))).resolves.toMatchObject({ status: 'success' })
    },
  )

  it('rejects stolen public transactions through the full HTTP flow and accepts the real payer', async () => {
    const rpc = adapter()
    const mppx = Mppx.create({
      secretKey: '0123456789abcdef0123456789abcdef',
      methods: [tron({
        verifier: createTronWebVerifier(rpc, { network: 'nile' }),
        network: 'nile', recipient, asset: { type: 'native' }, minConfirmations: 1,
      })],
    })
    const route = mppx.charge({ amount: '1' })
    const initial = await route(new Request('https://example.com/paid'))
    if (initial.status !== 402) throw new Error('Expected a payment challenge')
    const c = Challenge.fromResponse(initial.challenge) as TronChallenge
    const stolen = Credential.serialize(Credential.from({ challenge: c, payload: payload(c, attackerKey) }))
    const rejected = await route(new Request('https://example.com/paid', { headers: { Authorization: stolen } }))
    expect(rejected.status).toBe(402)
    expect(rpc.trx.getTransaction).not.toHaveBeenCalled()

    const client = clientCharge({
      signer: createTronWebSigner(rpc, { network: 'nile' }),
      networks: ['nile'], currencies: ['TRX'], maxAmount: '1',
    })
    const header = await client.createCredential({ challenge: c })
    const accepted = await route(new Request('https://example.com/paid', { headers: { Authorization: header } }))
    expect(accepted.status).toBe(200)
  })
})

describe('single-use challenges and transactions', () => {
  const secondTxId = 'b'.repeat(64)

  it('rejects a second payment for the same challenge without consuming the new transaction', async () => {
    const { method } = server()
    const c = challenge()
    await expect(method.verify(serverVerification(c))).resolves.toMatchObject({ status: 'success' })
    await expect(method.verify(serverVerification(c, payload(c, privateKey, secondTxId))))
      .rejects.toThrow(/challenge has already been used/)

    const fresh = challenge('fresh-challenge')
    await expect(method.verify(serverVerification(fresh, payload(fresh, privateKey, secondTxId))))
      .resolves.toMatchObject({ status: 'success' })
  })

  it.each(['one instance', 'shared instances'])(
    'accepts only one of two concurrent payments for a challenge across %s', async (mode) => {
      const store = Store.memory()
      const first = server(store).method
      const second = mode === 'one instance' ? first : server(store).method
      const c = challenge()
      const payments = [payload(c), payload(c, privateKey, secondTxId)]
      const results = await Promise.allSettled([
        first.verify(serverVerification(c, payments[0]!)),
        second.verify(serverVerification(c, payments[1]!)),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const rejectedIndex = results.findIndex((result) => result.status === 'rejected')
      const rejected = results[rejectedIndex] as PromiseRejectedResult
      expect(rejected.reason.message).toMatch(/challenge has already been used/)

      const fresh = challenge('unused-payment-challenge')
      const unused = payload(fresh, privateKey, payments[rejectedIndex]!.txId)
      await expect(second.verify(serverVerification(fresh, unused))).resolves.toMatchObject({ status: 'success' })
    },
  )

  it('retains challenge consumption across server method recreation', async () => {
    const store = Store.memory()
    const c = challenge()
    await server(store).method.verify(serverVerification(c))
    await expect(server(store).method.verify(serverVerification(c, payload(c, privateKey, secondTxId))))
      .rejects.toThrow(/challenge has already been used/)
  })

  it('releases a challenge when its transaction was already consumed', async () => {
    const { method } = server()
    await method.verify(serverVerification(challenge('original-challenge')))
    const c = challenge('retryable-challenge')
    await expect(method.verify(serverVerification(c))).rejects.toThrow(/transaction has already been used/)
    await expect(method.verify(serverVerification(c, payload(c, privateKey, secondTxId))))
      .resolves.toMatchObject({ status: 'success' })
  })

  it('accepts only one concurrent use of a transaction and releases the losing challenge', async () => {
    const store = Store.memory()
    const methods = [server(store).method, server(store).method]
    const challenges = [challenge('first-challenge'), challenge('second-challenge')]
    const results = await Promise.allSettled(methods.map((method, i) =>
      method.verify(serverVerification(challenges[i]!))))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejectedIndex = results.findIndex((result) => result.status === 'rejected')
    const rejected = results[rejectedIndex] as PromiseRejectedResult
    expect(rejected.reason.message).toMatch(/transaction has already been used/)
    const retry = challenges[rejectedIndex]!
    await expect(methods[rejectedIndex]!.verify(serverVerification(retry, payload(retry, privateKey, secondTxId))))
      .resolves.toMatchObject({ status: 'success' })
  })

  it('does not consume the challenge when payment verification fails', async () => {
    const { method, verifier } = server()
    const c = challenge()
    verifier.mockRejectedValueOnce(new Error('payment is not confirmed'))
    await expect(method.verify(serverVerification(c))).rejects.toThrow(/not confirmed/)
    await expect(method.verify(serverVerification(c))).resolves.toMatchObject({ status: 'success' })
  })

  it('releases its reservation when the transaction store update throws', async () => {
    const backing = Store.memory()
    let failTransaction = true
    const store: Store.AtomicStore = {
      ...backing,
      async update(key, fn) {
        if (key.startsWith('tron:charge:') && failTransaction) {
          failTransaction = false
          throw new Error('store unavailable')
        }
        return backing.update(key, fn)
      },
    }
    const { method } = server(store)
    const c = challenge()
    await expect(method.verify(serverVerification(c))).rejects.toThrow(/store unavailable/)
    expect(await backing.get(`tron:challenge:${c.id}`)).toBeNull()
    await expect(method.verify(serverVerification(c))).resolves.toMatchObject({ status: 'success' })
  })

  it('keeps pre-existing transaction replay markers effective after the upgrade', async () => {
    const store = Store.memory()
    await store.put(`tron:charge:nile:${txId}`, Date.now())
    const { method } = server(store)
    const c = challenge()
    await expect(method.verify(serverVerification(c))).rejects.toThrow(/transaction has already been used/)
    await expect(method.verify(serverVerification(c, payload(c, privateKey, secondTxId))))
      .resolves.toMatchObject({ status: 'success' })
  })

  it('applies the configured store prefix to both replay markers', async () => {
    const store = Store.memory()
    const { method } = server(store, 'tenant:')
    const c = challenge()
    await method.verify(serverVerification(c))
    expect(await store.get(`tenant:tron:challenge:${c.id}`)).toBeTypeOf('string')
    expect(await store.get(`tenant:tron:charge:nile:${txId}`)).toBeTypeOf('number')
    expect(await store.get(`tron:challenge:${c.id}`)).toBeNull()
  })

  it.each(['sequential', 'concurrent'])(
    'returns one HTTP success for %s distinct payments answering the same challenge', async (mode) => {
      const mppx = Mppx.create({
        secretKey: '0123456789abcdef0123456789abcdef', methods: [server().method],
      })
      const route = mppx.charge({ amount: '1' })
      const initial = await route(new Request('https://example.com/paid'))
      if (initial.status !== 402) throw new Error('Expected a payment challenge')
      const c = Challenge.fromResponse(initial.challenge) as TronChallenge
      const submit = async (id: string) => {
        const header = Credential.serialize(Credential.from({
          challenge: c, payload: payload(c, privateKey, id),
        }))
        return route(new Request('https://example.com/paid', { headers: { Authorization: header } }))
      }
      const results = mode === 'sequential'
        ? [await submit(txId), await submit(secondTxId)]
        : await Promise.all([submit(txId), submit(secondTxId)])
      expect(results.map((result) => result.status).sort()).toEqual([200, 402])
    },
  )
})

describe('client spending policy', () => {
  function client(extra: Partial<Parameters<typeof clientCharge>[0]> = {}) {
    const signer = vi.fn(async ({ challengeId, request }: Parameters<Types.ChargeSigner>[0]) =>
      payload({ ...challenge(challengeId), request }))
    return { signer, method: clientCharge({ signer, currencies: ['TRX'], maxAmount: '1', ...extra }) }
  }

  it('rejects a TRC-20 transfer mislabeled as TRX', async () => {
    const c = challenge()
    c.request.methodDetails.asset = { type: 'trc20', contractAddress: token, symbol: 'USDT', decimals: 6 }
    const { method, signer } = client()
    await expect(method.createCredential({ challenge: c })).rejects.toThrow(/currency/)
    expect(signer).not.toHaveBeenCalled()
  })

  it('rejects an actual token outside the allowlist', async () => {
    const c = challenge()
    c.request.currency = token
    c.request.methodDetails.asset = { type: 'trc20', contractAddress: token, symbol: 'USDT', decimals: 6 }
    const { method, signer } = client()
    await expect(method.createCredential({ challenge: c })).rejects.toThrow(/not allowed/)
    expect(signer).not.toHaveBeenCalled()
  })

  it('rejects spoofed native decimals before broadcasting', async () => {
    const c = challenge()
    Object.assign(c.request.methodDetails.asset, { decimals: 18 })
    c.request.amount = '1000000000000'
    const { method, signer } = client()
    await expect(method.createCredential({ challenge: c })).rejects.toThrow()
    expect(signer).not.toHaveBeenCalled()
  })

  it.each([undefined, 18])('requires matching trusted token decimals (%s)', async (trusted) => {
    const c = challenge()
    c.request.currency = token
    c.request.methodDetails.asset = { type: 'trc20', contractAddress: token, symbol: 'USDT', decimals: 6 }
    const { method, signer } = client({
      currencies: [token], ...(trusted === undefined ? {} : { tokenDecimals: { [token]: trusted } }),
    })
    await expect(method.createCredential({ challenge: c })).rejects.toThrow(/decimals/)
    expect(signer).not.toHaveBeenCalled()
  })

  it('keeps atomic limits effective independently of display metadata', async () => {
    const { method, signer } = client({ maxAtomicAmount: '999999' })
    await expect(method.createCredential({ challenge: challenge() })).rejects.toThrow(/maxAtomicAmount/)
    expect(signer).not.toHaveBeenCalled()
  })

  it('rejects remote token decimals that inflate a trusted display limit', async () => {
    const c = challenge()
    c.request.currency = token
    c.request.amount = '1000000000000'
    c.request.methodDetails.asset = { type: 'trc20', contractAddress: token, symbol: 'USDT', decimals: 18 }
    const { method, signer } = client({ currencies: [token], tokenDecimals: { [token]: 6 } })
    await expect(method.createCredential({ challenge: c })).rejects.toThrow(/decimals/)
    expect(signer).not.toHaveBeenCalled()
  })

  it('does not round a display limit upward into an extra atomic unit', async () => {
    const c = challenge()
    c.request.amount = '1'
    const { method, signer } = client({ maxAmount: '0.0000009' })
    await expect(method.createCredential({ challenge: c })).rejects.toThrow(/precision/)
    expect(signer).not.toHaveBeenCalled()
  })
})

describe('adapter network binding and broadcast handling', () => {
  it('rejects wrong-network signing before any signature or broadcast', async () => {
    const rpc = adapter()
    const signer = createTronWebSigner(rpc, { network: 'mainnet' })
    const c = challenge()
    await expect(signer({ challengeId: c.id, request: c.request })).rejects.toThrow(/network mismatch/)
    expect(rpc.trx.sendTransaction).not.toHaveBeenCalled()
    expect(rpc.trx.signMessageV2).not.toHaveBeenCalled()
  })

  it('rejects wrong-network verification before any node queries', async () => {
    const rpc = adapter()
    const verify = createTronWebVerifier(rpc, { network: 'mainnet' })
    await expect(verify(verification())).rejects.toThrow(/network mismatch/)
    expect(rpc.trx.getTransaction).not.toHaveBeenCalled()
    expect(rpc.trx.getTransactionInfo).not.toHaveBeenCalled()
  })

  it('rejects missing network configuration', () => {
    expect(() => createTronWebSigner(adapter(), { network: '' })).toThrow(/network/)
    expect(() => createTronWebVerifier(adapter(), { network: '' })).toThrow(/network/)
  })

  it('rejects failed broadcasts even if a signed transaction ID is returned', async () => {
    const rpc = adapter()
    rpc.trx.sendTransaction.mockResolvedValue({ result: false, transaction: { txID: txId } })
    const signer = createTronWebSigner(rpc, { network: 'nile' })
    const c = challenge()
    await expect(signer({ challengeId: c.id, request: c.request })).rejects.toThrow(/broadcast failed/)
    expect(rpc.trx.signMessageV2).not.toHaveBeenCalled()
  })

  it('requires message-signing support before broadcasting', async () => {
    const rpc = adapter()
    const { signMessageV2: _, ...trx } = rpc.trx
    const signer = createTronWebSigner({ ...rpc, trx }, { network: 'nile' })
    const c = challenge()
    await expect(signer({ challengeId: c.id, request: c.request })).rejects.toThrow(/signMessageV2/)
    expect(rpc.trx.sendTransaction).not.toHaveBeenCalled()
  })
})

describe('transaction success and confirmation checks', () => {
  it.each([
    { transaction: 'FAILED', receipt: undefined },
    { transaction: 'FAILED', receipt: 'SUCCESS' },
    { transaction: 'SUCCESS', receipt: 'OUT_OF_ENERGY' },
  ])('rejects explicit failures with allowUnconfirmed: %j', async ({ transaction, receipt }) => {
    const rpc = adapter()
    const tx = await rpc.trx.getTransaction() as Record<string, unknown>
    rpc.trx.getTransaction.mockResolvedValue({ ...tx, ret: [{ contractRet: transaction }] })
    rpc.trx.getTransactionInfo.mockResolvedValue(receipt ? { receipt: { result: receipt } } : {})
    const verify = createTronWebVerifier(rpc, { network: 'nile', allowUnconfirmed: true })
    await expect(verify(verification())).rejects.toThrow(/failed/)
  })

  it('propagates RPC errors even when unconfirmed transactions are allowed', async () => {
    const rpc = adapter()
    rpc.trx.getTransactionInfo.mockRejectedValue(new Error('RPC unavailable'))
    const verify = createTronWebVerifier(rpc, { network: 'nile', allowUnconfirmed: true })
    await expect(verify(verification())).rejects.toThrow(/RPC unavailable/)
  })

  it('allows pending native transactions only when explicitly enabled', async () => {
    const rpc = adapter()
    rpc.trx.getTransactionInfo.mockResolvedValue({})
    await expect(createTronWebVerifier(rpc, { network: 'nile' })(verification())).rejects.toThrow(/info/)
    await expect(createTronWebVerifier(rpc, { network: 'nile', allowUnconfirmed: true })(verification()))
      .resolves.toMatchObject({ reference: txId })
    const c = challenge()
    c.request.methodDetails.minConfirmations = 1
    await expect(createTronWebVerifier(rpc, { network: 'nile', allowUnconfirmed: true })(verification(c)))
      .rejects.toThrow(/not confirmed/)
  })
})

describe('TRC-20 verification', () => {
  it.each(['short', 'prefixed', '0x-short'])('normalizes %s log addresses beginning with 41', async (format) => {
    const rpc = adapter()
    rpc.trx.getTransaction.mockResolvedValue({
      ret: [{ contractRet: 'SUCCESS' }],
      raw_data: { contract: [{ type: 'TriggerSmartContract', parameter: { value: { contract_address: tokenHex } } }] },
    })
    const topic = (address: string) => wallet.address.toHex(address).slice(2).padStart(64, '0')
    rpc.trx.getTransactionInfo.mockResolvedValue({
      blockNumber: 12, receipt: { result: 'SUCCESS' },
      log: [{
        address: format === 'prefixed' ? tokenHex : `${format === '0x-short' ? '0x' : ''}${tokenHex.slice(2)}`,
        topics: ['ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic(payer), topic(recipient)],
        data: BigInt(1000000).toString(16).padStart(64, '0'),
      }],
    })
    const c = challenge()
    c.request.currency = token
    c.request.methodDetails.asset = { type: 'trc20', contractAddress: token, symbol: 'USDT', decimals: 6 }
    const verify = createTronWebVerifier(rpc, { network: 'nile' })
    await expect(verify(verification(c))).resolves.toMatchObject({ payer, reference: txId })
  })
})
