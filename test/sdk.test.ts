import { Challenge, Credential, Store } from 'mppx'
import { TronWeb, Trx } from 'tronweb'
import { describe, expect, it } from 'vitest'

import { charge as clientCharge } from '../src/client/Charge.js'
import * as Methods from '../src/Methods.js'
import { charge as serverCharge } from '../src/server/Charge.js'
import { createTronWebSigner, createTronWebVerifier, type TronWebLike } from '../src/tronweb/index.js'
import * as Types from '../src/Types.js'
import { paymentProofMessage } from '../src/Proof.js'

const recipient = 'TQGfKPHs3AwiBT44ibkCU64u1G4ttojUXU' as Types.TronAddress
const privateKey = '1'.repeat(64)
const payer = TronWeb.address.fromPrivateKey(privateKey) as Types.TronAddress
const txId = 'a'.repeat(64) as Types.TransactionId

type TronChallenge = {
  id: string
  intent: 'charge'
  method: 'tron'
  realm: string
  request: Types.ChargeRequest
}

describe('TRON MPP charge method', () => {
  it('accepts the installed TronWeb API in both adapters', () => {
    const tronWeb = new TronWeb({ fullHost: 'http://127.0.0.1:8090', privateKey })
    expect(createTronWebSigner(tronWeb, { network: 'nile' })).toBeTypeOf('function')
    expect(createTronWebVerifier(tronWeb, { network: 'nile' })).toBeTypeOf('function')
  })

  it('passes native atomic amounts as safe numbers to TronWeb', async () => {
    const tronWeb = new TronWeb({ fullHost: 'http://127.0.0.1:8090', privateKey })
    let sends = 0
    const signer = createTronWebSigner({
      address: tronWeb.address,
      defaultAddress: { base58: payer },
      trx: {
        signMessageV2: (message) => Trx.signMessageV2(message, privateKey),
        getTransaction: async () => ({}),
        getTransactionInfo: async () => ({}),
        sendTransaction: async (to, amount) => {
          sends++
          expect(to).toBe(recipient)
          expect(amount).toBe(1250000)
          return { result: true, transaction: { txID: txId } }
        },
      },
    }, { network: 'nile' })
    const request: Types.ChargeRequest = {
      ...createChallenge('native-signer').request,
      amount: '1250000',
    }
    await expect(signer({ challengeId: 'native-signer', request })).resolves.toMatchObject({ txId, payer })
    await expect(signer({
      challengeId: 'unsafe-native',
      request: { ...request, amount: '9007199254740993' },
    })).rejects.toThrow(/safe integer/)
    expect(sends).toBe(1)
  })

  it('normalizes a USDT charge and signs a TRC-20 transfer', async () => {
    const asset = { type: 'trc20', symbol: 'USDT', decimals: 6, contractAddress: recipient } as const
    const challenge = Challenge.fromMethod(Methods.charge, {
      id: 'challenge-usdt',
      realm: 'api.example.com',
      request: { amount: '1.25', asset, network: 'nile', recipient },
    })
    expect(challenge.request.amount).toBe('1250000')
    expect(challenge.request.currency).toBe(asset.contractAddress)

    const tronWeb = new TronWeb({ fullHost: 'http://127.0.0.1:8090', privateKey })
    const signer = createTronWebSigner({
      address: tronWeb.address,
      trx: tronWeb.trx,
      defaultAddress: { base58: payer },
      contract: () => ({
        at: async (address) => {
          expect(address).toBe(asset.contractAddress)
          return {
            transfer: (to, amount) => {
              expect(to).toBe(recipient)
              expect(amount).toBe('1250000')
              return { send: async () => txId }
            },
          }
        },
      }),
    }, { network: 'nile' })
    const method = clientCharge({ signer, maxAmount: '1.25', tokenDecimals: { [recipient]: 6 } })
    const header = await method.createCredential({ challenge: challenge as never })
    expect(Credential.deserialize(header).payload).toMatchObject({ payer, txId })
    const limited = clientCharge({ signer, maxAmount: '1.24', tokenDecimals: { [recipient]: 6 } })
    await expect(limited.createCredential({ challenge: challenge as never })).rejects.toThrow(/exceeds maxAmount/)
  })

  it('normalizes display amounts to atomic Challenge amounts', () => {
    const challenge = Challenge.fromMethod(Methods.charge, {
      id: 'challenge-1',
      realm: 'api.example.com',
      request: {
        amount: '1.25',
        asset: { type: 'native', symbol: 'TRX', decimals: 6 },
        network: 'nile',
        recipient,
      },
    })

    expect(challenge.request).toMatchObject({
      amount: '1250000',
      currency: 'TRX',
      recipient,
      methodDetails: {
        asset: { type: 'native', symbol: 'TRX', decimals: 6 },
        network: 'nile',
      },
    })
  })

  it('creates a serialized MPP Credential from a signer result', async () => {
    const challenge = Challenge.fromMethod(Methods.charge, {
      id: 'challenge-2',
      realm: 'api.example.com',
      request: {
        amount: '2',
        asset: { type: 'native' },
        network: 'nile',
        recipient,
      },
    }) as TronChallenge
    const method = clientCharge({
      currencies: ['TRX'],
      networks: ['nile'],
      signer: async ({ challengeId, request }) => createPayload({ id: challengeId, request }),
    })

    const header = await method.createCredential({ challenge: challenge as never })
    const credential = Credential.deserialize<Types.TransactionPayload>(header)

    expect(credential.payload).toMatchObject({
      payer,
      txId,
      type: Types.transactionCredentialType,
    })
    expect(credential.source).toBe(`did:pkh:tron:nile:${payer}`)
  })

  it('returns a success receipt when the server verifier matches the credential', async () => {
    const challenge = Challenge.fromMethod(Methods.charge, {
      id: 'challenge-3',
      realm: 'api.example.com',
      request: {
        amount: '1',
        asset: { type: 'native' },
        network: 'nile',
        recipient,
      },
    }) as TronChallenge
    const method = serverCharge({
      asset: { type: 'native' },
      network: 'nile',
      recipient,
      verifier: async ({ credential }) => ({
        payer: credential.payload.payer,
        reference: credential.payload.txId,
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    })

    const receipt = await method.verify({
      credential: {
        challenge: challenge as never,
        payload: createPayload(challenge),
      },
      request: challenge.request as never,
    })

    expect(receipt).toEqual({
      method: 'tron',
      reference: txId,
      status: 'success',
      timestamp: '2026-01-01T00:00:00.000Z',
    })
  })

  it('rejects server verifier transaction reference mismatches', async () => {
    const challenge = Challenge.fromMethod(Methods.charge, {
      id: 'challenge-4',
      realm: 'api.example.com',
      request: {
        amount: '1',
        asset: { type: 'native' },
        network: 'nile',
        recipient,
      },
    }) as TronChallenge
    const method = serverCharge({
      asset: { type: 'native' },
      network: 'nile',
      recipient,
      verifier: async ({ credential }) => ({
        payer: credential.payload.payer,
        reference: 'b'.repeat(64) as Types.TransactionId,
      }),
    })

    await expect(
      method.verify({
        credential: {
          challenge: challenge as never,
          payload: createPayload(challenge),
        },
        request: challenge.request as never,
      }),
    ).rejects.toThrow(/reference mismatch/)
  })

  it('rejects a transaction that has already satisfied a charge', async () => {
    const challenge = createChallenge('challenge-replay')
    const method = createServerMethod(Store.memory())
    const verification = createVerification(challenge)

    await expect(method.verify(verification)).resolves.toMatchObject({ status: 'success' })
    await expect(method.verify(verification)).rejects.toThrow(/already been used/)
  })

  it('atomically rejects concurrent use of the same transaction', async () => {
    const challenge = createChallenge('challenge-concurrent-replay')
    const method = createServerMethod(Store.memory())
    const verification = createVerification(challenge)

    const results = await Promise.allSettled([
      method.verify(verification),
      method.verify(verification),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejection.reason).toBeInstanceOf(Error)
    expect((rejection.reason as Error).message).toMatch(/already been used/)
  })

  it('shares replay protection across server method instances', async () => {
    const store = Store.memory()
    const challenge = createChallenge('challenge-shared-store')
    const firstMethod = createServerMethod(store)
    const secondMethod = createServerMethod(store)
    const verification = createVerification(challenge)

    await expect(firstMethod.verify(verification)).resolves.toMatchObject({ status: 'success' })
    await expect(secondMethod.verify(verification)).rejects.toThrow(/already been used/)
  })

  it('verifies native TRX transfers with the TronWeb adapter', async () => {
    const payerHex = `41${'22'.repeat(20)}`
    const recipientHex = `41${'11'.repeat(20)}`
    const tronWeb = {
      address: {
        fromHex(address: string) {
          if (address === payerHex) return payer
          if (address === recipientHex) return recipient
          return address
        },
        toHex(address: string) {
          if (address === payer) return payerHex
          if (address === recipient) return recipientHex
          return address
        },
      },
      trx: {
        async getCurrentBlock() {
          return { block_header: { raw_data: { number: 12 } } }
        },
        async getTransaction() {
          return {
            ret: [{ contractRet: 'SUCCESS' }],
            raw_data: {
              contract: [
                {
                  type: 'TransferContract',
                  parameter: {
                    value: {
                      amount: 1250000,
                      owner_address: payerHex,
                      to_address: recipientHex,
                    },
                  },
                },
              ],
            },
          }
        },
        async getTransactionInfo() {
          return {
            blockNumber: 12,
            blockTimeStamp: 1767225600000,
            contractResult: [''],
            receipt: { net_usage: 265 },
          }
        },
        async sendTransaction() {
          return txId
        },
      },
    } satisfies TronWebLike
    const verifier = createTronWebVerifier(tronWeb, { network: 'nile' })

    await expect(
      verifier({
        credential: {
          payload: createPayload(createChallenge('adapter')),
        },
        request: {
          amount: '1250000',
          currency: 'TRX',
          methodDetails: {
            asset: { type: 'native', symbol: 'TRX', decimals: 6 },
            minConfirmations: 1,
            network: 'nile',
          },
          recipient,
        },
      }),
    ).resolves.toEqual({
      payer,
      reference: txId,
      timestamp: '2026-01-01T00:00:00.000Z',
    })
  })
})

function createChallenge(id: string): TronChallenge {
  return Challenge.fromMethod(Methods.charge, {
    id,
    realm: 'api.example.com',
    request: {
      amount: '1',
      asset: { type: 'native' },
      network: 'nile',
      recipient,
    },
  }) as TronChallenge
}

function createServerMethod(store: ReturnType<typeof Store.memory>) {
  return serverCharge({
    asset: { type: 'native' },
    network: 'nile',
    recipient,
    store,
    verifier: async ({ credential }) => ({
      payer: credential.payload.payer,
      reference: credential.payload.txId,
    }),
  })
}

function createVerification(challenge: TronChallenge) {
  return {
    credential: {
      challenge: challenge as never,
      payload: createPayload(challenge),
    },
    request: challenge.request as never,
  }
}

function createPayload(challenge: { id: string; request: Types.ChargeRequest }): Types.TransactionPayload {
  return {
    payer,
    txId,
    type: Types.transactionCredentialType,
    signature: Trx.signMessageV2(paymentProofMessage({
      challengeId: challenge.id,
      request: challenge.request,
      payer,
      txId,
    }), privateKey),
  }
}
