# tron-mpp-sdk

MPP payments for TRON **TRC-20 tokens**: one-time charges and escrow-backed sessions.
All amounts are integer strings in token atomic units. Native coin payments are
unsupported.

The public methods are `tron.charge(...)` and `tron.session(...)`, imported from
the client or server entry point. Shared schemas, address utilities and typed
signature helpers are available from `tron-mpp-sdk`.

## Install

```sh
npm install tron-mpp-sdk mppx viem
# When using the provided wallet/node integration:
npm install tronweb
```

## Charge server

```ts
import { Mppx, Store, tron } from 'tron-mpp-sdk/server'
import { chains } from 'tron-mpp-sdk'
import { createChargeAdapter, createTronWebTransport } from 'tron-mpp-sdk/tronweb'

const adapter = createChargeAdapter(
  createTronWebTransport(relayerTronWeb, { chainId: chains.nile }),
  { minConfirmations: 1 },
)
const payment = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,
  methods: [tron.charge({
    adapter,
    chainId: chains.nile,
    currency: tokenAddress,
    recipient: merchantAddress,
    credentialTypes: ['permit2', 'transaction'],
    permit2: { address: deployedPermit2Address, spender: relayerAddress },
    store: Store.redis(redisWithAtomicUpdate),
  })],
})
const paid = payment.charge({ amount: '1250000', externalId: 'invoice-42' })

export async function handler(request: Request) {
  const result = await paid(request)
  if (result.status === 402) return result.challenge
  return result.withReceipt(Response.json({ result: 'paid content' }))
}
```

`currency` identifies the TRC-20 contract. Accepted address formats are Base58Check,
`41`-prefixed hex and `0x`-prefixed 20-byte hex. The SDK compares decoded account
values. An amount of `1250000` represents 1.25 units of a six-decimal token.

## Charge client

```ts
import { Mppx, tron } from 'tron-mpp-sdk/client'
import { chains } from 'tron-mpp-sdk'
import { createChargeAdapter, createTronWebTransport } from 'tron-mpp-sdk/tronweb'

const adapter = createChargeAdapter(
  createTronWebTransport(walletTronWeb, { chainId: chains.nile }),
)
const { fetch } = Mppx.create({
  polyfill: false,
  methods: [tron.charge({
    adapter,
    chainIds: [chains.nile],
    currencies: [tokenAddress],
    recipients: [merchantAddress], // Include any expected split recipients too.
    maxAtomicAmount: '1250000',
    permit2: { address: deployedPermit2Address, spender: relayerAddress },
  })],
})
const response = await fetch('https://merchant.example/paid')
```

The client checks every primary and split recipient against the required
`recipients` allowlist before signing or broadcasting, then selects an advertised
credential supported by its wallet and local policy. Permit2 requires prior token approval of the locally trusted Permit2
contract. The SDK also supports token-native EIP-3009 authorization when explicitly
configured, signed TRON transactions submitted by the server, and confirmed hashes
for client-broadcast token transfers. Splits require Permit2.

Retain the charge method to call `chargeMethod.reconcile(challengeId)` after an
uncertain submission. Retrying the same credential also confirms its saved hash
without broadcasting again. Reconciliation returns a receipt without executing
the protected handler; submissions without a known hash need operator recovery.

## Sessions

`tron.session(...)` supports escrow funding, cumulative typed vouchers, top-ups,
settlement, cooperative close and forced-close recovery. Deploy `TronPaymentChannel`
from the separate [`tron-mpp-sdk-contract`](../tron-mpp-sdk-contract/README.md)
repository, configure its TRC-20 allowlist and network,
and provide a shared persistent atomic store for accounting. Close/settlement
failures retain enough state for `manager.reconcile(channelId)`; confirmed failures
release the operation for retry.

Session clients supply a `wallet` plus `preparePayment`, which returns an unsigned
payment plan. The SDK checks the cumulative spending limit and existing channel
balance before wallet signing or funding. Sponsored funding can be reconciled
after authorization expiry using the saved exact authorization and transaction
hash. The migration guide covers the updated client and streaming event APIs.

Request idempotency records are stored separately, capped by
`maxIdempotencyRecords` (default 10,000 per channel). Active keys are retained.
After closure and `requestRetentionMs` (default 24 hours), use
`manager.pruneRequests(channelId)` to clean up records in batches.

See the [protocol and integration guide](docs/PROTOCOL.md) for session examples,
credential formats and recovery requirements, and the
[end-to-end flow](docs/END_TO_END_FLOW.md) for implementation responsibilities.

## Validation

```sh
npm run check
npm test
npm run build
```

Contract tests and TRON compilation are maintained in the separate
[`tron-mpp-sdk-contract`](../tron-mpp-sdk-contract/README.md) repository.
