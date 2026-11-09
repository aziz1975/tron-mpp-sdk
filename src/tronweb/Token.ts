import { keccak256, parseAbi, toBytes, type Address } from 'viem'
import * as P from '../protocol/Primitives.js'
import type { TransactionReceipt } from './Transport.js'

export const tokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)',
  'function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
])
export const permit2Abi = parseAbi([
  'function nonceBitmap(address,uint256) view returns (uint256)',
  'function permitWitnessTransferFrom(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,(address to,uint256 requestedAmount) transferDetails,address owner,bytes32 witness,string witnessTypeString,bytes signature)',
  'function permitWitnessTransferFrom(((address token,uint256 amount)[] permitted,uint256 nonce,uint256 deadline) permit,(address to,uint256 requestedAmount)[] transferDetails,address owner,bytes32 witness,string witnessTypeString,bytes signature)',
])

const transferTopic = keccak256(toBytes('Transfer(address,address,uint256)')).slice(2)
export function logAddress(value: string): Address { return P.normalizeAddress(`0x${value.replace(/^0x/, '').slice(-40)}`) }
export function verifyTransfers(info: TransactionReceipt, token: Address, payer: Address | undefined, expected: P.Transfer[]): void {
  const logs = (info.log ?? []).filter(l => P.isSameAddress(logAddress(l.address), token) && l.topics[0]?.replace(/^0x/, '').toLowerCase() === transferTopic)
  // Consume matching logs in transfer order. Duplicate recipients/amounts require distinct events.
  let cursor = 0
  for (const transfer of expected) {
    let found = false
    while (cursor < logs.length) {
      const log = logs[cursor++]!
      if (log.topics.length !== 3 || !/^[0-9a-fA-F]{64}$/.test(log.data.replace(/^0x/, ''))) continue
      if ((!payer || P.isSameAddress(logAddress(log.topics[1]!), payer)) && P.isSameAddress(logAddress(log.topics[2]!), transfer.to) && BigInt(`0x${log.data.replace(/^0x/, '')}`) === BigInt(transfer.amount)) { found = true; break }
    }
    if (!found) throw new Error('Receipt does not contain every expected token transfer.')
  }
}
