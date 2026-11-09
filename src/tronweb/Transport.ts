import { encodeFunctionData, hexToString, parseAbi, type Address, type Hex } from 'viem'
import type { TronWeb } from 'tronweb'
import { Errors } from 'mppx'
import { ContractCallRevertedError, InvalidRequestError, TransactionRevertedError, TransactionNotSubmittedError, TransactionOutcomeUnknownError } from '../protocol/Errors.js'
import * as P from '../protocol/Primitives.js'

export type TransactionReceipt = { id?: string; blockNumber?: number; blockTimeStamp?: number; result?: string; receipt?: { result?: string }; log?: { address: string; topics: string[]; data: string }[] }
export type TronTransport = {
  chainId: number
  payer?: string
  signTypedData?: P.TypedSigner
  /** Preserve definite VM reverts as ContractCallRevertedError with revert bytes; RPC failures remain distinct. */
  call: (to: Address, data: Hex, from?: Address) => Promise<Hex>
  send: (to: Address, data: Hex, from?: Address) => Promise<Hex>
  /** Validate envelope consistency and ECDSA ownership before returning it. */
  inspectTransaction: (envelope: string, payer?: Address) => Promise<{ hash: Hex; from: Address; to: Address; data: Hex }>
  signTransaction: (to: Address, data: Hex) => Promise<string>
  broadcast: (envelope: string) => Promise<Hex>
  info: (hash: Hex) => Promise<TransactionReceipt>
  blockNumber: () => Promise<number>
}
export type ConfirmationOptions = { minConfirmations?: number; timeoutMs?: number; pollIntervalMs?: number }

/** Bind one transport to one node. chainId is trusted configuration, not a remote challenge value. */
export function createTronWebTransport(tronWeb: TronWeb, options: { chainId: number; feeLimit?: number }): TronTransport {
  const payer = tronWeb.defaultAddress.base58 || undefined
  const owner = payer ? P.normalizeAddress(payer) : undefined
  const build = async (to: Address, data: Hex, from = owner) => {
    if (!from) throw new Error('A transaction account is required.')
    const built = await tronWeb.transactionBuilder.triggerSmartContract(P.toBase58Address(to), '',
      { input: data.slice(2), feeLimit: options.feeLimit ?? 100_000_000 }, [], P.toBase58Address(from))
    if (!built.result?.result || !built.transaction) throw new Error('Transaction construction failed.')
    return built.transaction
  }
  return {
    chainId: options.chainId, ...(payer ? { payer } : {}),
    signTypedData: async data => {
      const types = Object.fromEntries(Object.entries(data.types).map(([name, fields]) => [name, [...fields]]))
      const signature = await tronWeb.trx.signTypedData(data.domain, types, data.message)
      return P.SignatureSchema.parse(signature.startsWith('0x') ? signature : `0x${signature}`)
    },
    async call(to, data, from = owner) {
      // TronWeb's builder throws on result.message and discards constant_result,
      // including Solidity custom-error data. Preserve the raw node response.
      const result = await tronWeb.fullNode.request<{
        result?: { result?: boolean; code?: string; message?: string };
        constant_result?: string[]; transaction?: { ret?: { contractRet?: string }[] }
      }>('wallet/triggerconstantcontract', {
        owner_address: `41${(from ?? P.zeroAddress).slice(2)}`, contract_address: `41${to.slice(2)}`,
        data: data.slice(2), call_value: 0,
      }, 'post')
      let message = result.result?.message ?? ''
      if (/^(?:[0-9a-fA-F]{2})+$/.test(message)) message = hexToString(`0x${message}`)
      if (result.result?.code === 'CONTRACT_EXE_ERROR' || /\brevert(?:ed)?\b/i.test(message) || result.transaction?.ret?.some(r => r.contractRet === 'REVERT')) {
        const output = result.constant_result?.[0] ?? ''
        throw new ContractCallRevertedError(/^(?:[0-9a-fA-F]{2})*$/.test(output) ? `0x${output}` : '0x')
      }
      if (!result.result?.result || !result.constant_result?.length) throw new Error('Contract simulation/read failed.')
      return `0x${result.constant_result[0]}` as Hex
    },
    async send(to, data, from = owner) {
      let signed
      try {
        if (from && owner && !P.isSameAddress(from, owner)) throw new InvalidRequestError('Configured sender mismatch.')
        signed = await tronWeb.trx.sign(await build(to, data, from))
      } catch (cause) { throw new TransactionNotSubmittedError(cause) }
      const hash = P.Bytes32Schema.parse(`0x${signed.txID}`)
      let result
      try { result = await tronWeb.trx.sendRawTransaction(signed) }
      catch (cause) { throw new TransactionOutcomeUnknownError(hash, cause) }
      if (!result.result) {
        if (result.code === 'DUP_TRANSACTION_ERROR') throw new TransactionOutcomeUnknownError(hash)
        throw new TransactionNotSubmittedError(result)
      }
      return hash
    },
    async signTransaction(to, data) { return JSON.stringify(await tronWeb.trx.sign(await build(to, data))) },
    async inspectTransaction(envelope, expectedPayer) {
      const tx = JSON.parse(envelope)
      const { utils } = await import('tronweb')
      if (!utils.transaction.txCheck(tx)) throw new Error('Signed transaction protobuf/JSON mismatch.')
      if (!Array.isArray(tx.signature) || tx.signature.length !== 1) throw new Error('Expected one transaction signature.')
      const recovered = await tronWeb.trx.ecRecover(tx)
      const signers = Array.isArray(recovered) ? recovered : [recovered]
      if (signers.length !== 1) throw new Error('Transaction signer mismatch.')
      const signer = P.normalizeAddress(String(signers[0]))
      if (expectedPayer && !P.isSameAddress(signer, expectedPayer)) throw new Error('Transaction signer mismatch.')
      if (tx.raw_data?.contract?.length !== 1) throw new Error('Expected one smart-contract call.')
      const contract = tx.raw_data.contract[0]
      const value = contract.parameter?.value
      if (contract.type !== 'TriggerSmartContract' || !P.isSameAddress(value.owner_address, signer) ||
          (contract.Permission_id ?? 0) !== 0 || BigInt(value.call_value ?? 0) !== 0n || BigInt(value.call_token_value ?? 0) !== 0n ||
          Number(tx.raw_data.expiration) <= Date.now()) throw new Error('Invalid or expired token transfer transaction.')
      return { hash: P.Bytes32Schema.parse(`0x${tx.txID}`), from: signer, to: P.normalizeAddress(value.contract_address), data: `0x${value.data}` as Hex }
    },
    async broadcast(envelope) {
      const tx = JSON.parse(envelope)
      const hash = P.Bytes32Schema.parse(`0x${tx.txID}`)
      let result
      try { result = await tronWeb.trx.sendRawTransaction(tx) }
      catch (cause) { throw new TransactionOutcomeUnknownError(hash, cause) }
      if (!result.result) {
        if (result.code === 'DUP_TRANSACTION_ERROR') throw new TransactionOutcomeUnknownError(hash)
        throw new TransactionNotSubmittedError(result)
      }
      return hash
    },
    async info(hash) { return await tronWeb.trx.getTransactionInfo(hash.slice(2)) as TransactionReceipt },
    async blockNumber() { return (await tronWeb.trx.getCurrentBlock()).block_header.raw_data.number },
  }
}

export async function waitForReceipt(transport: TronTransport, hash: Hex, options: ConfirmationOptions = {}): Promise<TransactionReceipt> {
  const end = Date.now() + (options.timeoutMs ?? 60_000)
  const confirmations = requiredConfirmations(options)
  do {
    const info = await transport.info(hash)
    const status = await receiptStatus(transport, hash, info, confirmations)
    if (status === 'reverted') throw new TransactionRevertedError(hash)
    if (status === 'success') return info
    if (Date.now() >= end) break
    await new Promise(resolve => setTimeout(resolve, options.pollIntervalMs ?? 1000))
  } while (Date.now() <= end)
  throw new TransactionOutcomeUnknownError(hash, new Error('Transaction confirmation timed out.'))
}

export async function transactionStatus(transport: TronTransport, hash: Hex, options: ConfirmationOptions = {}): Promise<'pending' | 'success' | 'reverted'> {
  const confirmations = requiredConfirmations(options)
  return receiptStatus(transport, hash, await transport.info(hash), confirmations)
}

function requiredConfirmations(options: ConfirmationOptions): number {
  const confirmations = options.minConfirmations ?? 1
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new InvalidRequestError('At least one confirmation is required.')
  return confirmations
}

async function receiptStatus(transport: TronTransport, hash: Hex, info: TransactionReceipt, confirmations: number): Promise<'pending' | 'success' | 'reverted'> {
  if (!Number.isSafeInteger(info.blockNumber)) return 'pending'
  if (info.id && info.id.toLowerCase().replace(/^0x/, '') !== hash.slice(2)) throw new Errors.InternalPaymentError()
  if (await transport.blockNumber() - info.blockNumber! + 1 < confirmations) return 'pending'
  if ((info.receipt?.result && info.receipt.result !== 'SUCCESS') || (info.result && info.result !== 'SUCCESS')) return 'reverted'
  return info.receipt?.result === 'SUCCESS' ? 'success' : 'pending'
}

export function createContractSignatureVerifier(transport: TronTransport): P.ContractVerifier {
  return async (signer, digest, signature) => {
    try {
      const data = encodeFunctionData({ abi: parseAbi(['function isValidSignature(bytes32,bytes) view returns (bytes4)']), functionName: 'isValidSignature', args: [digest, signature] })
      return (await transport.call(signer, data)).slice(0, 10).toLowerCase() === '0x1626ba7e'
    } catch { return false }
  }
}
