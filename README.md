# tron-mpp-sdk

MPP payment method SDK for TRON charge payments. It packages a reusable `tron`
payment method with separate client and server entry points, following the
custom payment method pattern from the MPP docs.

For a source-level walkthrough of every entry point and the complete HTTP 402,
TRON payment, verification, replay-protection, and Receipt flow, see
[`docs/END_TO_END_FLOW.md`](docs/END_TO_END_FLOW.md).

## Install

```sh
npm install tron-mpp-sdk mppx viem
```

Install `tronweb` too when using the included TronWeb adapter:

```sh
npm install tronweb
```

## Server

```ts
import { Mppx, tron } from 'tron-mpp-sdk/server'
import { createTronWebVerifier } from 'tron-mpp-sdk/tronweb'

const verifier = createTronWebVerifier(tronWeb, { network: 'nile' })

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,
  methods: [
    tron({
      verifier,
      network: 'nile',
      recipient: 'TQGfKPHs3AwiBT44ibkCU64u1G4ttojUXU',
      asset: { type: 'native', symbol: 'TRX', decimals: 6 },
      minConfirmations: 1,
    }),
  ],
})
```

### Replay protection

Each server method enforces single-use challenge IDs and transaction IDs. After
payment verification, it atomically reserves the challenge, then atomically
claims the transaction by network and transaction ID. A rejected transaction
claim releases that challenge reservation, allowing a valid payment to retry.
Concurrent submissions can produce at most one success for either identifier.
The default in-memory store is suitable for tests and single-process
development. Production deployments should provide a shared, persistent atomic
store so protection survives restarts and works across server instances:

```ts
import { Mppx, Store, tron } from 'tron-mpp-sdk/server'

const store = Store.redis(redisClientWithAtomicUpdate)

const method = tron({
  verifier,
  network: 'nile',
  recipient: 'T...',
  asset: { type: 'native' },
  store,
})
```

The store must implement MPP's atomic `update` operation. A non-atomic `get`
followed by `put` is not safe against concurrent credential submissions.

## Client

```ts
import { Mppx, tron } from 'tron-mpp-sdk/client'
import { createTronWebSigner } from 'tron-mpp-sdk/tronweb'

const signer = createTronWebSigner(tronWeb, { network: 'nile' })

const { fetch } = Mppx.create({
  methods: [
    tron({
      signer,
      networks: ['nile'],
      currencies: ['TRX'],
      maxAmount: '10',
    }),
  ],
  polyfill: false,
})

const response = await fetch('https://api.example.com/premium')
```

The adapter's `network` must identify the network served by its TronWeb node.
Both adapters reject challenges for a different network before querying or
broadcasting. Use a separate configured adapter for each network.

TRX always uses six decimals and the currency `TRX`. Token currencies must equal
their TRC-20 contract address. A token payment with `maxAmount` also requires
client-configured decimals; values in a remote challenge are not trusted:

```ts
tron({
  signer,
  networks: ['nile'],
  currencies: [usdtContractAddress],
  tokenDecimals: { [usdtContractAddress]: 6 },
  maxAmount: '1.25',
})
```

`maxAtomicAmount` can cap atomic units without configuring token decimals.

## Payer authentication

Every credential payload must contain a TRON `signMessageV2` signature over
`paymentProofMessage({ challengeId, request, payer, txId })`. The core server
verifies ownership before calling any payment verifier or consuming the replay
store. Public transaction IDs alone cannot satisfy a charge.

The TronWeb signer creates this signature after a successful broadcast. For a
browser or hardware wallet, pass a `signMessage` callback that signs with the
same TRON message format. Custom signers must return the signature too:

```ts
import { paymentProofMessage } from 'tron-mpp-sdk'

const signature = await wallet.signMessageV2(
  paymentProofMessage({ challengeId, request, payer, txId }),
)
return { type: 'transaction', payer, txId, signature }
```

The server can verify signatures without installing TronWeb or holding a private
key. Unsigned credentials from earlier versions must be regenerated.

## Custom verification

The core SDK does not require TronWeb. Server code can pass any verifier that
checks the transaction against the original MPP Challenge request. Payer
signature verification is performed by the core server before this callback.

```ts
import { tron } from 'tron-mpp-sdk/server'

const method = tron({
  network: 'mainnet',
  recipient: 'T...',
  asset: { type: 'trc20', symbol: 'USDT', decimals: 6, contractAddress: 'T...' },
  verifier: async ({ credential, request }) => {
    // Verify txId paid request.amount to request.recipient on request.methodDetails.network.
    return {
      payer: credential.payload.payer,
      reference: credential.payload.txId,
      timestamp: new Date().toISOString(),
    }
  },
})
```

## Request schema

The public server route input accepts display-unit amounts and normalizes them
to atomic units in the MPP Challenge. Native TRX requires 6 decimals.

```ts
{
  amount: '1.25',
  network: 'nile',
  recipient: 'T...',
  asset: { type: 'native', symbol: 'TRX', decimals: 6 }
}
```

The Challenge request uses:

```ts
{
  amount: '1250000',
  currency: 'TRX',
  recipient: 'T...',
  methodDetails: {
    network: 'nile',
    asset: { type: 'native', symbol: 'TRX', decimals: 6 },
    minConfirmations: 1
  }
}
```
