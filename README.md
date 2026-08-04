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

const verifier = createTronWebVerifier(tronWeb)

const mppx = Mppx.create({
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

Each server method atomically claims a successful transaction by its network and
transaction ID, preventing the same on-chain payment from satisfying multiple
charges. The default in-memory store is suitable for tests and single-process
development. Production deployments should provide a shared, persistent atomic
store so protection survives restarts and works across server instances:

```ts
import { Mppx, Store, tron } from 'tron-mpp-sdk/server'

const store = Store.redis(redisClientWithAtomicUpdate)

const method = tron({
  verifier,
  network: 'mainnet',
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

const signer = createTronWebSigner(tronWeb)

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

## Custom verification

The core SDK does not require TronWeb. Server code can pass any verifier that
checks the transaction against the original MPP Challenge request.

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
to atomic units in the MPP Challenge. TRX defaults to 6 decimals.

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
