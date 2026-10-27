import { createBase58check } from '@scure/base'
import { concat, hexToBytes, keccak256, recoverAddress, sha256, toBytes } from 'viem'

import type { ChargeRequest, TransactionPayload } from './Types.js'

const addressCodec = createBase58check((bytes: Uint8Array) => sha256(bytes, 'bytes'))

export type ProofParameters = {
  challengeId: string
  request: ChargeRequest
  payer: string
  txId: string
}

/** Domain-separated, fixed-order message signed with TRON signMessageV2. */
export function paymentProofMessage(parameters: ProofParameters): string {
  const { challengeId, request, payer, txId } = parameters
  const { asset, network, minConfirmations } = request.methodDetails
  return `TRON MPP charge proof v1\n${JSON.stringify([
    challengeId,
    network,
    payer,
    txId.toLowerCase(),
    request.amount,
    request.currency,
    request.recipient,
    asset.type,
    asset.type === 'trc20' ? asset.contractAddress : null,
    asset.decimals,
    asset.symbol,
    minConfirmations ?? 0,
  ])}`
}

/** Verify TRON's signed-message format without requiring TronWeb on the server. */
export async function verifyPaymentProof(
  parameters: ProofParameters & { signature: TransactionPayload['signature'] },
): Promise<boolean> {
  try {
    const message = toBytes(paymentProofMessage(parameters))
    const hash = keccak256(concat([toBytes(`\x19TRON Signed Message:\n${message.length}`), message]))
    const signature = `0x${parameters.signature.replace(/^0x/, '')}` as `0x${string}`
    const recovered = await recoverAddress({ hash, signature })
    const address = addressCodec.encode(hexToBytes(`0x41${recovered.slice(2)}`))
    return address === parameters.payer
  } catch {
    return false
  }
}
