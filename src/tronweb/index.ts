import { Errors } from 'mppx'

import * as Types from '../Types.js'
import { paymentProofMessage, verifyPaymentProof } from '../Proof.js'

type MaybePromise<T> = T | Promise<T>

export type TronWebLike = {
  address: {
    fromHex(address: string): string
    toHex(address: string): string
  }
  contract?: () => {
    at?: (address: string) => MaybePromise<{
      transfer: (
        recipient: string,
        amount: string,
      ) => {
        send: (options?: Record<string, unknown>) => Promise<string | { txid?: string }>
      }
    }>
  }
  defaultAddress?: {
    base58?: string | false
    hex?: string | false
  }
  trx: {
    signMessageV2?: (message: string) => MaybePromise<string>
    getCurrentBlock?: () => Promise<unknown>
    getTransaction: (txId: string) => Promise<unknown>
    getTransactionInfo: (txId: string) => Promise<unknown>
    sendTransaction: (
      recipient: string,
      amount: number,
      options?: Record<string, unknown>,
    ) => Promise<string | { result?: boolean; transaction?: { txID?: string }; txid?: string }>
  }
}

export type TronWebSignerOptions = {
  /** Network served by this configured TronWeb instance. */
  network: string
  /** Optional wallet callback for TRON signMessageV2; defaults to tronWeb.trx.signMessageV2. */
  signMessage?: (message: string) => MaybePromise<string>
  /** Wallet address to report as the payer. Defaults to `tronWeb.defaultAddress.base58`. */
  payer?: Types.TronAddress | undefined
  /** Options passed to TRC-20 `transfer(...).send(options)`. */
  trc20SendOptions?: Record<string, unknown> | undefined
  /** Options passed to native `trx.sendTransaction`. */
  nativeSendOptions?: Record<string, unknown> | undefined
}

export type TronWebVerifierOptions = {
  /** Network served by this configured TronWeb instance. */
  network: string
  /** Treat missing transaction info as zero confirmations instead of immediate failure. */
  allowUnconfirmed?: boolean | undefined
}

const transferEventTopic =
  'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export function createTronWebSigner(
  tronWeb: TronWebLike,
  options: TronWebSignerOptions,
): Types.ChargeSigner {
  assertConfiguredNetwork(options.network)
  return async ({ challengeId, request: input }) => {
    const request = Types.ChargeRequestSchema.parse(input)
    assertNetwork(request, options.network)
    Types.assertCanonicalCurrency(request)
    const signMessage = options.signMessage ?? tronWeb.trx.signMessageV2?.bind(tronWeb.trx)
    if (!signMessage) throw new Error('TRON payments require signMessageV2 to authenticate the payer.')
    const payer = resolvePayer(tronWeb, options)
    const txId =
      request.methodDetails.asset.type === Types.nativeAssetType
        ? await sendNativeTransfer(tronWeb, request, options)
        : await sendTrc20Transfer(tronWeb, request, options)

    const signature = await signMessage(paymentProofMessage({ challengeId, request, payer, txId }))
    if (!await verifyPaymentProof({ challengeId, request, payer, txId, signature })) {
      throw new Error('TRON payer signature does not match the payment payer.')
    }
    return {
      payer,
      signature,
      txId,
      type: Types.transactionCredentialType,
    }
  }
}

export function createTronWebVerifier(
  tronWeb: TronWebLike,
  options: TronWebVerifierOptions,
): Types.ChargeVerifier {
  assertConfiguredNetwork(options.network)
  return async ({ credential, request: input }) => {
    const request = Types.ChargeRequestSchema.parse(input)
    assertNetwork(request, options.network)
    Types.assertCanonicalCurrency(request)
    const txId = credential.payload.txId
    const [transaction, transactionInfo] = await Promise.all([
      tronWeb.trx.getTransaction(txId),
      tronWeb.trx.getTransactionInfo(txId),
    ])

    assertTransactionSuccess(transaction, transactionInfo, options)
    await assertConfirmations(tronWeb, transactionInfo, request.methodDetails.minConfirmations ?? 0)

    const verified =
      request.methodDetails.asset.type === Types.nativeAssetType
        ? verifyNativeTransfer(tronWeb, transaction, request)
        : verifyTrc20Transfer(tronWeb, transaction, transactionInfo, request)

    if (verified.payer !== credential.payload.payer) {
      throw new Errors.VerificationFailedError({ reason: 'TRON credential payer mismatch' })
    }

    return {
      payer: verified.payer,
      reference: txId,
      timestamp: timestampFromTransactionInfo(transactionInfo),
    }
  }
}

async function sendNativeTransfer(
  tronWeb: TronWebLike,
  request: Types.ChargeRequest,
  options: TronWebSignerOptions,
): Promise<Types.TransactionId> {
  const amount = Number(request.amount)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('TRON native transfer amount must be a positive safe integer.')
  }
  const result = await tronWeb.trx.sendTransaction(
    request.recipient,
    amount,
    options.nativeSendOptions,
  )
  return normalizeTxId(result)
}

async function sendTrc20Transfer(
  tronWeb: TronWebLike,
  request: Types.ChargeRequest,
  options: TronWebSignerOptions,
): Promise<Types.TransactionId> {
  if (!tronWeb.contract) throw new Error('TRC-20 transfers require tronWeb.contract.')

  const asset = request.methodDetails.asset
  if (asset.type !== Types.trc20AssetType) throw new Error('Expected a TRC-20 asset.')

  const contractFactory = tronWeb.contract()
  if (!contractFactory.at) throw new Error('TRC-20 transfers require tronWeb.contract().at.')

  const contract = await contractFactory.at(asset.contractAddress)
  const result = await contract.transfer(request.recipient, request.amount).send(options.trc20SendOptions)
  return normalizeTxId(result)
}

function verifyNativeTransfer(
  tronWeb: TronWebLike,
  transaction: unknown,
  request: Types.ChargeRequest,
): { payer: Types.TronAddress } {
  const contract = firstContract(transaction)
  if (contract?.type !== 'TransferContract') {
    throw new Errors.VerificationFailedError({ reason: 'TRON transaction is not a native transfer' })
  }

  const value = asRecord(contract.parameter).value
  const amount = String(readRequired(value, 'amount'))
  const recipient = tronWeb.address.fromHex(String(readRequired(value, 'to_address')))
  const payer = tronWeb.address.fromHex(String(readRequired(value, 'owner_address')))

  if (amount !== request.amount) {
    throw new Errors.VerificationFailedError({ reason: 'TRON native transfer amount mismatch' })
  }
  if (recipient !== request.recipient) {
    throw new Errors.VerificationFailedError({ reason: 'TRON native transfer recipient mismatch' })
  }

  return { payer: payer as Types.TronAddress }
}

function verifyTrc20Transfer(
  tronWeb: TronWebLike,
  transaction: unknown,
  transactionInfo: unknown,
  request: Types.ChargeRequest,
): { payer: Types.TronAddress } {
  const asset = request.methodDetails.asset
  if (asset.type !== Types.trc20AssetType) throw new Error('Expected a TRC-20 asset.')

  const contract = firstContract(transaction)
  if (contract?.type !== 'TriggerSmartContract') {
    throw new Errors.VerificationFailedError({ reason: 'TRON transaction is not a smart-contract call' })
  }

  const contractAddress = tronWeb.address.fromHex(
    String(readRequired(asRecord(contract.parameter).value, 'contract_address')),
  )
  if (contractAddress !== asset.contractAddress) {
    throw new Errors.VerificationFailedError({ reason: 'TRON TRC-20 contract mismatch' })
  }

  const transfer = findTransferLog(tronWeb, transactionInfo, asset.contractAddress, request.recipient)
  if (!transfer) {
    throw new Errors.VerificationFailedError({ reason: 'TRON TRC-20 transfer log not found' })
  }
  if (transfer.amount !== request.amount) {
    throw new Errors.VerificationFailedError({ reason: 'TRON TRC-20 transfer amount mismatch' })
  }

  return { payer: transfer.from as Types.TronAddress }
}

function findTransferLog(
  tronWeb: TronWebLike,
  transactionInfo: unknown,
  contractAddress: string,
  recipient: string,
): { amount: string; from: string } | undefined {
  const logs = asRecord(transactionInfo).log
  if (!Array.isArray(logs)) return undefined

  for (const log of logs) {
    const entry = asRecord(log)
    const address = normalizeLogAddress(tronWeb, String(entry.address ?? ''))
    const topics = Array.isArray(entry.topics) ? entry.topics.map(String) : []
    if (address !== contractAddress) continue
    if (topics[0]?.replace(/^0x/, '').toLowerCase() !== transferEventTopic) continue

    const from = topicToTronAddress(tronWeb, topics[1])
    const to = topicToTronAddress(tronWeb, topics[2])
    const amount = BigInt(`0x${String(entry.data ?? '0').replace(/^0x/, '')}`).toString()
    if (to === recipient) return { amount, from }
  }

  return undefined
}

function assertTransactionSuccess(
  transaction: unknown,
  transactionInfo: unknown,
  options: TronWebVerifierOptions,
) {
  const info = asRecord(transactionInfo)
  const receiptResult = asRecord(info.receipt).result
  const transactionResults = asRecord(transaction).ret
  const transactionResult = Array.isArray(transactionResults)
    ? asRecord(transactionResults[0]).contractRet
    : undefined
  for (const result of [receiptResult, transactionResult]) {
    if (result !== undefined && result !== 'SUCCESS') {
      throw new Errors.VerificationFailedError({ reason: `TRON transaction failed with result ${String(result)}` })
    }
  }
  if (!Object.keys(info).length) {
    if (options.allowUnconfirmed) return
    throw new Errors.VerificationFailedError({ reason: 'TRON transaction info is unavailable' })
  }
  if (receiptResult === undefined && transactionResult === undefined) {
    throw new Errors.VerificationFailedError({ reason: 'TRON transaction result is unavailable' })
  }
}

async function assertConfirmations(
  tronWeb: TronWebLike,
  transactionInfo: unknown,
  minConfirmations: number,
) {
  if (minConfirmations <= 0) return

  const blockNumber = Number(asRecord(transactionInfo).blockNumber)
  if (!Number.isFinite(blockNumber)) {
    throw new Errors.VerificationFailedError({ reason: 'TRON transaction is not confirmed' })
  }
  if (!tronWeb.trx.getCurrentBlock) {
    throw new Errors.VerificationFailedError({ reason: 'TRON confirmation checks require getCurrentBlock' })
  }

  const currentBlock = asRecord(await tronWeb.trx.getCurrentBlock())
  const currentBlockNumber = Number(
    asRecord(currentBlock.block_header).raw_data
      ? asRecord(asRecord(currentBlock.block_header).raw_data).number
      : currentBlock.number,
  )
  if (!Number.isFinite(currentBlockNumber)) {
    throw new Errors.VerificationFailedError({ reason: 'TRON current block number is unavailable' })
  }

  const confirmations = currentBlockNumber - blockNumber + 1
  if (confirmations < minConfirmations) {
    throw new Errors.VerificationFailedError({
      reason: `TRON transaction has ${confirmations} confirmations; ${minConfirmations} required`,
    })
  }
}

function resolvePayer(tronWeb: TronWebLike, options: TronWebSignerOptions): Types.TronAddress {
  const payer = options.payer ?? tronWeb.defaultAddress?.base58
  if (!payer) throw new Error('A TRON payer address is required.')
  return payer as Types.TronAddress
}

function normalizeTxId(result: unknown): Types.TransactionId {
  if (typeof result === 'string') return Types.TransactionIdSchema.parse(result)

  const record = asRecord(result)
  if (record.result !== undefined && record.result !== true) {
    throw new Error(`TRON broadcast failed: ${String(record.code ?? record.message ?? 'node rejected transaction')}`)
  }
  const txId = record.txid ?? asRecord(record.transaction).txID
  if (typeof txId !== 'string') throw new Error('TRON transaction response did not include a txid.')
  return Types.TransactionIdSchema.parse(txId)
}

function firstContract(transaction: unknown) {
  const contracts = asRecord(asRecord(transaction).raw_data).contract
  if (!Array.isArray(contracts) || contracts.length === 0) {
    throw new Errors.VerificationFailedError({ reason: 'TRON transaction has no contract data' })
  }
  return asRecord(contracts[0])
}

function readRequired(record: unknown, key: string) {
  const value = asRecord(record)[key]
  if (value === undefined || value === null) {
    throw new Errors.VerificationFailedError({ reason: `TRON transaction is missing ${key}` })
  }
  return value
}

function normalizeLogAddress(tronWeb: TronWebLike, address: string) {
  const normalized = address.replace(/^0x/, '')
  if (/^[0-9a-fA-F]{40}$/.test(normalized)) return tronWeb.address.fromHex(`41${normalized}`)
  if (/^41[0-9a-fA-F]{40}$/.test(normalized)) return tronWeb.address.fromHex(normalized)
  throw new Errors.VerificationFailedError({ reason: 'TRON transfer log has an invalid contract address' })
}

function assertConfiguredNetwork(network: string) {
  if (typeof network !== 'string' || !network.trim()) throw new Error('A TRON adapter network is required.')
}

function assertNetwork(request: Types.ChargeRequest, network: string) {
  if (request.methodDetails.network !== network) {
    throw new Errors.VerificationFailedError({ reason: 'TRON adapter network mismatch' })
  }
}

function topicToTronAddress(tronWeb: TronWebLike, topic: string | undefined) {
  if (!topic) throw new Errors.VerificationFailedError({ reason: 'TRON transfer log is missing address topics' })
  const stripped = topic.replace(/^0x/, '')
  return tronWeb.address.fromHex(`41${stripped.slice(-40)}`)
}

function timestampFromTransactionInfo(transactionInfo: unknown) {
  const blockTimeStamp = asRecord(transactionInfo).blockTimeStamp
  if (typeof blockTimeStamp !== 'number') return undefined
  return new Date(blockTimeStamp).toISOString()
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {}
  return value as Record<string, unknown>
}
