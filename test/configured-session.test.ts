import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, type Hex } from 'viem'
import { createConfiguredSession } from '../src/session.js'
import { getSessionEscrowAddress } from '../src/config.js'
import * as P from '../src/protocol/Primitives.js'
import type * as S from '../src/protocol/Session.js'
import { TransactionNotSubmittedError, TransactionOutcomeUnknownError, TransactionRevertedError } from '../src/protocol/Errors.js'
import type { SubmissionHooks } from '../src/session.js'
import { escrowAbi } from '../src/tronweb/Session.js'
import type { TronTransport } from '../src/tronweb/Transport.js'

vi.mock('../src/config.js', () => ({ getSessionEscrowAddress: vi.fn() }))
const escrow = P.normalizeAddress(`0x${'66'.repeat(20)}`), other = P.normalizeAddress(`0x${'77'.repeat(20)}`)
const token = P.normalizeAddress(`0x${'33'.repeat(20)}`), permit2 = P.normalizeAddress(`0x${'55'.repeat(20)}`)
const payer = P.normalizeAddress(`0x${'11'.repeat(20)}`), payee = P.normalizeAddress(`0x${'44'.repeat(20)}`)
const hash = `0x${'aa'.repeat(32)}` as Hex, salt = `0x${'bb'.repeat(32)}` as Hex
const chainId = P.chains.nile
function transport(): TronTransport {
  return { chainId, payer, signTypedData: vi.fn(async () => '0x' as Hex), call: vi.fn(async () => '0x' as Hex), send: vi.fn(async () => hash),
    info: vi.fn(async () => ({ blockNumber: 1, receipt: { result: 'SUCCESS' } })), blockNumber: async () => 1,
    inspectTransaction: async () => ({ hash, from: payer, to: escrow, data: '0x' }),
    signTransaction: async () => '{}', broadcast: async () => hash }
}
const options = { currency: token, permit2Contract: permit2, timeoutMs: 0 }
const request: S.Request = { amount: '1', currency: token, recipient: payee, methodDetails: { chainId, escrowContract: escrow } }
function submit(sdk: ReturnType<typeof createConfiguredSession>, action: 'requestClose' | 'withdraw' | 'approve', hooks?: SubmissionHooks) {
  return action === 'approve' ? sdk.approve('100', hooks) : sdk.force(action, hash, hooks)
}
beforeEach(() => { vi.mocked(getSessionEscrowAddress).mockReset().mockReturnValue(escrow) })

describe('configured SDK sessions', () => {
  it('binds wallet, adapter, channel IDs and saved state to one SDK deployment', () => {
    const sdk = createConfiguredSession(transport(), options)
    expect(getSessionEscrowAddress).toHaveBeenCalledTimes(1)
    expect(getSessionEscrowAddress).toHaveBeenCalledWith(chainId)
    vi.mocked(getSessionEscrowAddress).mockReturnValue(other)
    expect(sdk.wallet.adapter.escrowContract).toBe(escrow)
    expect(sdk.adapter.escrowContract).toBe(escrow)
    expect(sdk.computeChannelId({ payer, payee, salt })).toBe(P.computeChannelId({ payer, payee, salt, token, chainId, escrowContract: escrow }))
    expect(sdk.stateBinding({ serverUrl: 'local', recipient: payee, payer })).toBe(JSON.stringify([chainId, 'local', token, payee, escrow, permit2, payer]))
    expect(createConfiguredSession(transport(), options).stateBinding({ serverUrl: 'local', recipient: payee, payer })).not.toBe(sdk.stateBinding({ serverUrl: 'local', recipient: payee, payer }))
  })
  it('rejects foreign escrow/network challenges before payment preparation or signing', async () => {
    const t = transport(), sdk = createConfiguredSession(t, options), preparePayment = vi.fn()
    const method = sdk.client({ recipients: [payee], payer, maxUnitAmount: '1', maxCumulativeAmount: '10', preparePayment })
    for (const methodDetails of [{ chainId, escrowContract: other }, { chainId: chainId + 1, escrowContract: escrow }]) {
      const foreign = { ...request, methodDetails }
      expect(() => sdk.assertRequest(foreign)).toThrow(/escrow\/network/)
      await expect(method.createCredential({ challenge: { id: 'test', realm: 'local', method: 'tron', intent: 'session', expires: new Date(Date.now() + 60000).toISOString(), request: foreign } })).rejects.toThrow(/not allowed/)
    }
    expect(preparePayment).not.toHaveBeenCalled()
    expect(t.signTypedData).not.toHaveBeenCalled()
  })
  it('submits forced-close operations to SDK escrow and preserves persistence hook order', async () => {
    const t = transport(), order: string[] = [], sdk = createConfiguredSession(t, options)
    vi.mocked(t.call).mockImplementation(async () => { order.push('simulate'); return '0x' })
    vi.mocked(t.send).mockImplementation(async () => { order.push('send'); return hash })
    for (const action of ['requestClose', 'withdraw'] as const) {
      order.length = 0
      await sdk.force(action, hash, { beforeSubmit: () => { order.push('reserve') }, onSubmitted: received => { expect(received).toBe(hash); order.push('persistHash') } })
      expect(order).toEqual(['simulate', 'reserve', 'send', 'persistHash'])
      const [to, data] = vi.mocked(t.send).mock.calls.at(-1)!
      expect(to).toBe(escrow)
      expect(decodeFunctionData({ abi: escrowAbi, data })).toMatchObject({ functionName: action, args: [hash] })
    }
  })
  it('does not reserve or send after failed simulation; confirms uncertain transactions by hash', async () => {
    const t = transport(), sdk = createConfiguredSession(t, options), beforeSubmit = vi.fn(), onSubmitted = vi.fn()
    vi.mocked(t.call).mockRejectedValueOnce(new Error('Grace period'))
    await expect(sdk.force('withdraw', hash, { beforeSubmit })).rejects.toThrow('Grace period')
    expect(beforeSubmit).not.toHaveBeenCalled(); expect(t.send).not.toHaveBeenCalled()
    vi.mocked(t.info).mockResolvedValue({})
    await expect(sdk.force('requestClose', hash, { beforeSubmit, onSubmitted })).rejects.toMatchObject({ hash })
    expect(onSubmitted).toHaveBeenCalledWith(hash)
    expect(t.send).toHaveBeenCalledTimes(1)
  })
  describe.each(['requestClose', 'withdraw', 'approve'] as const)('%s transaction recovery', action => {
    it.each(['receipt lookup', 'confirmation depth'] as const)('retains the hash when %s RPC fails after broadcast', async stage => {
      const t = transport(), sdk = createConfiguredSession(t, options), cause = new Error('RPC unavailable')
      if (stage === 'receipt lookup') vi.mocked(t.info).mockRejectedValue(cause)
      else t.blockNumber = vi.fn(async () => { throw cause })
      const error = await submit(sdk, action).catch(error => error)
      expect(error).toBeInstanceOf(TransactionOutcomeUnknownError)
      expect(error).toMatchObject({ hash, cause, status: 503 })
      expect(t.send).toHaveBeenCalledTimes(1)
    })
    it.each(['sync', 'async'] as const)('retains the hash when a %s persistence hook fails after broadcast', async mode => {
      const t = transport(), sdk = createConfiguredSession(t, options)
      // A hook error must never misclassify a transaction already broadcast as unsubmitted.
      const cause = new TransactionNotSubmittedError(new Error('journal write failed'))
      const onSubmitted = mode === 'sync'
        ? vi.fn(() => { throw cause })
        : vi.fn(async () => { throw cause })
      const error = await submit(sdk, action, { onSubmitted }).catch(error => error)
      expect(error).toBeInstanceOf(TransactionOutcomeUnknownError)
      expect(error).toMatchObject({ hash, cause })
      expect(onSubmitted).toHaveBeenCalledWith(hash)
      expect(t.info).not.toHaveBeenCalled()
      expect(t.send).toHaveBeenCalledTimes(1)
    })
    it('preserves definite on-chain reverts and their hash', async () => {
      const t = transport(), sdk = createConfiguredSession(t, options)
      vi.mocked(t.info).mockResolvedValue({ blockNumber: 1, receipt: { result: 'REVERT' } })
      const error = await submit(sdk, action).catch(error => error)
      expect(error).toBeInstanceOf(TransactionRevertedError)
      expect(error).not.toBeInstanceOf(TransactionOutcomeUnknownError)
      expect(error).toMatchObject({ hash, code: 'transaction-reverted', status: 409 })
      expect(t.send).toHaveBeenCalledTimes(1)
    })
    it('preserves confirmation timeout errors without wrapping them again', async () => {
      const t = transport(), sdk = createConfiguredSession(t, options)
      vi.mocked(t.info).mockResolvedValue({})
      const error = await submit(sdk, action).catch(error => error)
      expect(error).toBeInstanceOf(TransactionOutcomeUnknownError)
      expect(error.hash).toBe(hash)
      expect(error.cause).toBeInstanceOf(Error)
      expect(error.cause.message).toBe('Transaction confirmation timed out.')
      expect(t.send).toHaveBeenCalledTimes(1)
    })
    it('preserves failures before broadcast and never calls the post-submission hook', async () => {
      const t = transport(), sdk = createConfiguredSession(t, options), onSubmitted = vi.fn()
      const simulationFailure = new Error('simulation failed')
      vi.mocked(t.call).mockRejectedValueOnce(simulationFailure)
      await expect(submit(sdk, action, { onSubmitted })).rejects.toBe(simulationFailure)
      expect(t.send).not.toHaveBeenCalled()
      const storageFailure = new Error('reservation write failed')
      await expect(submit(sdk, action, { beforeSubmit: () => { throw storageFailure }, onSubmitted })).rejects.toBe(storageFailure)
      expect(t.send).not.toHaveBeenCalled()
      const rejection = new TransactionNotSubmittedError()
      vi.mocked(t.send).mockRejectedValueOnce(rejection)
      await expect(submit(sdk, action, { onSubmitted })).rejects.toBe(rejection)
      const ambiguous = new TransactionOutcomeUnknownError(hash, new Error('broadcast response lost'))
      vi.mocked(t.send).mockRejectedValueOnce(ambiguous)
      await expect(submit(sdk, action, { onSubmitted })).rejects.toBe(ambiguous)
      expect(onSubmitted).not.toHaveBeenCalled()
    })
  })
  it('signs merchant authorizations and relays them using the SDK escrow', async () => {
    const t = transport(), sdk = createConfiguredSession(t, options), sign = vi.fn<P.TypedSigner>(async () => '0x' as Hex)
    const adapter = sdk.serverAdapter(sign)
    for (const action of ['settle', 'close'] as const) {
      await adapter[action](hash, '10', '0x')
      expect(sign.mock.calls.at(-1)![0].domain).toMatchObject({ verifyingContract: escrow, chainId })
      const [to, data] = vi.mocked(t.send).mock.calls.at(-1)!
      expect(to).toBe(escrow)
      expect(decodeFunctionData({ abi: escrowAbi, data }).functionName).toBe(`${action}WithAuthorization`)
    }
  })
  it('reads contract configuration at SDK escrow and fails closed on incompatible deployment', async () => {
    const t = transport(), sdk = createConfiguredSession(t, options)
    vi.mocked(t.call).mockResolvedValue(encodeAbiParameters([{ type: 'address' }], [other]))
    await expect(sdk.inspect()).rejects.toThrow(/PERMIT2/)
    expect(vi.mocked(t.call).mock.calls.map(([to]) => to)).toEqual([escrow, escrow, escrow, escrow, permit2])
    vi.mocked(getSessionEscrowAddress).mockImplementation(() => { throw new Error('Missing embedded SDK deployment') })
    expect(() => createConfiguredSession(t, options)).toThrow('Missing embedded SDK deployment')
  })
})
