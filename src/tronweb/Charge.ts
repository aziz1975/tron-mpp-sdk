import { encodeAbiParameters, encodeFunctionData, keccak256, toBytes, type Address, type Hex } from 'viem'
import { Errors } from 'mppx'
import * as C from '../protocol/Charge.js'
import * as P from '../protocol/Primitives.js'
import { tokenAbi, permit2Abi, verifyTransfers } from './Token.js'
import { createContractSignatureVerifier, waitForReceipt, type TronTransport, type ConfirmationOptions } from './Transport.js'
import { TransactionNotSubmittedError, TransactionOutcomeUnknownError } from '../protocol/Errors.js'

function signatureParts(signature: Hex) {
  return [Number.parseInt(signature.slice(130), 16), `0x${signature.slice(2, 66)}`, `0x${signature.slice(66, 130)}`] as const
}
function permitCall(payload: C.Permit2Payload, payer: Address): Hex {
  const batch = payload.permit.permitted.length > 1
  // Solidity overloads share the same name; the draft calls the batch overload permitBatchWitnessTransferFrom.
  const witness = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [keccak256(toBytes('PaymentWitness(bytes32 challengeHash,string externalId)')), payload.witness.challengeHash, keccak256(toBytes(payload.witness.externalId))],
  ))
  return encodeFunctionData({ abi: permit2Abi, functionName: 'permitWitnessTransferFrom', args: batch
    ? [{ ...payload.permit, nonce: BigInt(payload.permit.nonce), deadline: BigInt(payload.permit.deadline), permitted: payload.permit.permitted.map(p => ({ ...p, amount: BigInt(p.amount) })) }, payload.transferDetails.map(d => ({ ...d, requestedAmount: BigInt(d.requestedAmount) })), payer, witness, P.paymentWitnessTypeString, payload.signature]
    : [{ permitted: { token: payload.permit.permitted[0]!.token, amount: BigInt(payload.permit.permitted[0]!.amount) }, nonce: BigInt(payload.permit.nonce), deadline: BigInt(payload.permit.deadline) }, { to: payload.transferDetails[0]!.to, requestedAmount: BigInt(payload.transferDetails[0]!.requestedAmount) }, payer, witness, P.paymentWitnessTypeString, payload.signature] })
}

export function createChargeAdapter(transport: TronTransport, options: ConfirmationOptions = {}): C.Adapter {
  const callFor = (challenge: C.Challenge, payload: C.Payload, payer: Address) => {
    if (payload.type === 'permit2') return { to: challenge.request.methodDetails.permit2Address!, data: permitCall(payload, payer) }
    if (payload.type === 'authorization') return { to: challenge.request.currency, data: encodeFunctionData({ abi: tokenAbi, functionName: 'transferWithAuthorization',
      args: [payload.from, payload.to, BigInt(payload.value), BigInt(payload.validAfter), BigInt(payload.validBefore), payload.nonce, ...signatureParts(payload.signature)] }) }
    throw new Error('Credential has no relayed contract call.')
  }
  const inspect = async (request: C.Request, envelope: string, payer: Address) => {
    const tx = await transport.inspectTransaction(envelope, payer)
    const expectedData = encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [request.recipient, BigInt(request.amount)] })
    if (!P.isSameAddress(tx.to, request.currency) || tx.data.toLowerCase() !== expectedData.toLowerCase()) throw new Error('Signed transaction token, recipient or amount mismatch.')
    return tx
  }
  return {
    chainId: transport.chainId, ...(transport.payer ? { payer: transport.payer } : {}),
    ...(transport.signTypedData ? { signTypedData: transport.signTypedData } : {}),
    contractSignature: createContractSignatureVerifier(transport),
    async transactionPayer(envelope) { return (await transport.inspectTransaction(envelope)).from },
    async tokenState(token, owner, spender) {
      const balance = await transport.call(token, encodeFunctionData({ abi: tokenAbi, functionName: 'balanceOf', args: [owner] }))
      const allowance = spender ? await transport.call(token, encodeFunctionData({ abi: tokenAbi, functionName: 'allowance', args: [owner, spender] })) : '0x' as Hex
      return { balance: BigInt(balance), allowance: spender ? BigInt(allowance) : 0n }
    },
    async nonceUsed(permit2, owner, nonce) {
      const bitmap = BigInt(await transport.call(permit2, encodeFunctionData({ abi: permit2Abi, functionName: 'nonceBitmap', args: [owner, nonce >> 8n] })))
      return (bitmap & (1n << (nonce & 255n))) !== 0n
    },
    async simulate(challenge, payload, payer) {
      if (payload.type === 'transaction') { const tx = await inspect(challenge.request, payload.signature, payer); await transport.call(tx.to, tx.data, payer); return }
      const call = callFor(challenge, payload, payer)
      if (!transport.payer) throw new Error('Relayer account required.')
      if (payload.type === 'permit2' && !P.isSameAddress(transport.payer, challenge.request.methodDetails.spender!)) throw new Error('Permit spender must match submitting account.')
      await transport.call(call.to, call.data, P.normalizeAddress(transport.payer))
    },
    async submit(challenge, payload, payer) {
      if (payload.type === 'transaction') {
        const tx = await inspect(challenge.request, payload.signature, payer)
        try {
          const hash = await transport.broadcast(payload.signature)
          if (hash !== tx.hash) throw new Error('Broadcast hash mismatch.')
          return hash
        } catch (error) {
          if (error instanceof TransactionNotSubmittedError) throw error
          throw new TransactionOutcomeUnknownError(tx.hash, error)
        }
      }
      const call = callFor(challenge, payload, payer)
      return transport.send(call.to, call.data)
    },
    async verify(hash, request, payer) {
      const info = await waitForReceipt(transport, hash, options)
      try { verifyTransfers(info, request.currency, payer, C.transfers(request)) }
      catch { throw new Errors.VerificationFailedError({ reason: 'Receipt does not contain every expected token transfer.' }) }
      return { hash, ...(info.blockTimeStamp ? { timestamp: new Date(info.blockTimeStamp).toISOString() } : {}) }
    },
    async createTransaction(request, broadcast) {
      const data = encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [request.recipient, BigInt(request.amount)] })
      if (!broadcast) return transport.signTransaction(request.currency, data)
      const hash = await transport.send(request.currency, data)
      await waitForReceipt(transport, hash, options)
      return hash
    },
  }
}
