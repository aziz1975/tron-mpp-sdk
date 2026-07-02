import { Challenge, Credential } from 'mppx'
import { describe, expect, it } from 'vitest'

import { charge as clientCharge } from '../src/client/Charge.js'
import * as Methods from '../src/Methods.js'
import { charge as serverCharge } from '../src/server/Charge.js'
import { createTronWebVerifier, type TronWebLike } from '../src/tronweb/index.js'
import * as Types from '../src/Types.js'

const recipient = 'TQGfKPHs3AwiBT44ibkCU64u1G4ttojUXU' as Types.TronAddress
const payer = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7' as Types.TronAddress
const txId = 'a'.repeat(64) as Types.TransactionId

type TronChallenge = {
  id: string
  intent: 'charge'
  method: 'tron'
  realm: string
  request: Types.ChargeRequest
}

describe('TRON MPP charge method', () => {
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
      signer: async () => ({
        payer,
        txId,
        type: Types.transactionCredentialType,
      }),
    })

    const header = await method.createCredential({ challenge: challenge as never })
    const credential = Credential.deserialize<Types.TransactionPayload>(header)

    expect(credential.payload).toEqual({
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
        payload: {
          payer,
          txId,
          type: Types.transactionCredentialType,
        },
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
          payload: {
            payer,
            txId,
            type: Types.transactionCredentialType,
          },
        },
        request: challenge.request as never,
      }),
    ).rejects.toThrow(/reference mismatch/)
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
            receipt: { result: 'SUCCESS' },
          }
        },
        async sendTransaction() {
          return txId
        },
      },
    } satisfies TronWebLike
    const verifier = createTronWebVerifier(tronWeb)

    await expect(
      verifier({
        credential: {
          payload: {
            payer,
            txId,
            type: Types.transactionCredentialType,
          },
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
