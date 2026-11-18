# tron-mpp-sdk

Accept TRON **TRC-20 token payments** through the Machine Payments Protocol (MPP). The SDK supports two payment flows, called intents:

- **Charge:** collect one payment for one request, such as buying an article.
- **Session:** deposit tokens into escrow, then authorize payments for repeated use, such as API requests or streamed messages.

The SDK handles payment rules and verification. Your app chooses what to sell, sets prices, connects wallets and storage, and delivers the product or service. Smart contracts move or hold the tokens.

| Question | Charge | Session |
| --- | --- | --- |
| Where do the payer's tokens go first? | Directly to the merchant | Into the session escrow |
| Is there a blockchain payment for each paid request? | Yes | Individual vouchers and usage charges are off-chain; funding and settlement are on-chain |
| When does the merchant receive tokens? | When the payment is confirmed | When an authorized amount is settled or the channel closes |
| Main public method | `tron.charge(...)` | `tron.session(...)` |

## Install and connect to TRON

```sh
npm install tron-mpp-sdk mppx viem
# Also install TronWeb if using the SDK's provided TRON integration.
npm install tronweb
```

The package provides these entry points:

| Import | Purpose |
| --- | --- |
| `tron-mpp-sdk` | Shared schemas, address helpers, chain IDs, signature helpers, and errors |
| `tron-mpp-sdk/client` | Client payment methods and the Mppx HTTP client |
| `tron-mpp-sdk/server` | Server payment methods, receipts, storage helpers, and session management |
| `tron-mpp-sdk/tronweb` | Connect the payment methods to TronWeb wallets and nodes |
| `tron-mpp-sdk/session` | Node.js session helpers using the escrow address embedded in the SDK build |

### Amounts, wallets, and networks

- **Amounts are integer strings in token atomic units.** For a token with six decimals, `'1000000'` means 1 token and `'100000'` means 0.1 token. Your app must know the token's decimals and format prices for users.
- **The currency is a TRC-20 contract address.** Native TRX payments are unsupported. Wallets may still spend TRX or resources to execute transactions.
- **The payer** owns the tokens. **The merchant/payee** receives payment. **The relayer** submits sponsored transactions and pays their transaction costs. The merchant and relayer can use different wallets.
- **A private key is not an address.** When an app configures a private key, the corresponding wallet signs. Your app owns key management and access control.
- Addresses can be Base58Check (`T...`), `41`-prefixed hex, or 20-byte `0x` hex. The SDK compares the underlying account values. Use `toBase58Address` when displaying an address.

Your app creates a wallet/node connection and passes it to the SDK:

```ts
import { TronWeb } from 'tronweb'
import { chains } from 'tron-mpp-sdk'
import { createTronWebTransport } from 'tron-mpp-sdk/tronweb'

const walletTronWeb = new TronWeb({
  fullHost: 'https://nile.trongrid.io',
  privateKey: process.env.TRON_PAYER_PRIVATE_KEY!,
})
const payerTransport = createTronWebTransport(walletTronWeb, {
  chainId: chains.nile,
})
```

The same package supports configured TRON networks; there are no separate mainnet and Nile SDK packages. The **app must supply a node and chain ID for the intended network**, along with contracts deployed on that network. `TRON_FULL_HOST` is an app configuration convention, not an environment variable the SDK reads automatically. The SDK accepts an already configured TronWeb instance or a custom transport.

The transport trusts its configured chain ID; it does not discover or independently verify the node's network. Changing only the node URL does not change the chain ID. For sessions, the embedded escrow address must also belong to the intended network; the current SDK embeds one address, not a registry of deployments by chain ID. See [session deployment configuration](#session-deployment-configuration).

## Charge: one payment for one request

For example, Alice pays 1 USDT to read an article from Bob's API. With Permit2, Alice signs permission to pay and Bob's relayer submits the payment. USDT moves **from Alice directly to Bob**. There is no session escrow.

### Charge sequence with Permit2

The SDK runs inside the client app and merchant server. In this diagram, the client SDK includes Mppx's HTTP handling, and the server SDK includes Mppx's challenge and receipt handling.

```mermaid
sequenceDiagram
    participant Buyer as Buyer app
    participant Client as Client SDK
    participant Server as Server SDK
    participant Store as App-provided store
    participant Permit2 as Permit2 contract
    participant Token as USDT contract
    participant Service as Merchant app
    Note over Buyer,Token: Before payment, the buyer app arranges token approval to Permit2
    Buyer->>Client: Fetch the paid resource
    Client->>Server: Request without payment
    Server->>Store: Save issued challenge
    Server-->>Client: HTTP 402 with payment terms
    Client->>Client: Check trusted network, token, recipients, and amount cap
    Client->>Client: Sign payment with the configured payer wallet
    Client->>Server: Request with signed payment credential
    Server->>Store: Reserve payment before submission
    Server->>Permit2: Relayer submits signed authorization
    Permit2->>Token: Transfer USDT from payer to merchant
    Server->>Server: Confirm execution and verify token-transfer events
    Server->>Store: Save payment result and replay markers
    Server-->>Service: Payment verified
    Service-->>Buyer: Content with payment receipt
```

### What the SDK does for charge

- Creates and verifies payment terms sent as an HTTP 402 challenge.
- Checks the client's trusted chain IDs, tokens, recipients, price cap, and supported payment format before signing or broadcasting. Every split recipient must also be trusted.
- Uses the configured wallet to create the selected payment credential.
- Checks signatures and payment details, submits server-relayed payments, waits for confirmations, and checks the token-transfer events.
- Uses the supplied atomic store to record issued challenges, pending submissions, confirmed results, and duplicate-payment markers. An atomic update means concurrent requests cannot both claim the same payment.
- Returns a payment receipt after verification and offers recovery for known pending submissions.

### What your app must do for charge

- Choose the token, amount, merchant, network, accepted payment formats, and any payment splits.
- Provide payer and relayer wallet connections and enough token balance and transaction resources.
- Configure the locally trusted Permit2 address and spender. With the provided adapter, the charge spender must be the relayer's address.
- Arrange the payer's token approval before a Permit2 payment. The SDK does not silently grant unlimited token approval.
- Supply storage that survives restarts when payment records must survive restarts. Multiple server processes need a shared store with atomic updates.
- Mount the paid route and return content only after the SDK verifies payment.
- Decide how orders, invoices, content delivery, and customer retries work. Payment recovery does not automatically deliver or cache your product.

### Charge server example

These are integration snippets, not a complete server. The app supplies the wallet connections, token and wallet addresses, HTTP routing, server secret, and storage connection used below. `redisWithAtomicUpdate` represents a Redis connection implementing the atomic operations required by `Store.redis`; see the [integration guide](docs/PROTOCOL.md).

```ts
import { Mppx, Store, tron } from 'tron-mpp-sdk/server'
import { chains } from 'tron-mpp-sdk'
import { createChargeAdapter, createTronWebTransport } from 'tron-mpp-sdk/tronweb'

const adapter = createChargeAdapter(
  createTronWebTransport(relayerTronWeb, { chainId: chains.nile }),
  { minConfirmations: 1 },
)
const chargeMethod = tron.charge({
  adapter,
  chainId: chains.nile,
  currency: tokenAddress,
  recipient: merchantAddress,
  credentialTypes: ['permit2'],
  permit2: { address: permit2Address, spender: relayerAddress },
  store: Store.redis(redisWithAtomicUpdate),
})
const payment = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,
  methods: [chargeMethod],
})
const paid = payment.charge({ amount: '1000000', externalId: 'invoice-42' })

export async function handler(request: Request) {
  const result = await paid(request)
  if (result.status === 402) return result.challenge
  return result.withReceipt(Response.json({ article: 'Paid content' }))
}
```

The SDK verifies the 1-USDT payment, assuming a six-decimal token. Your app supplies the article and connects `handler` to its HTTP framework. `externalId` is an app-chosen reference such as an invoice ID.

### Charge client example

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
    recipients: [merchantAddress], // Also include every expected split recipient.
    maxAtomicAmount: '1000000',
    credentialTypes: ['permit2'],
    permit2: { address: permit2Address, spender: relayerAddress },
  })],
})
const response = await fetch('https://merchant.example/article')
```

The client handles the 402 challenge and sends the payment credential. Your app configures spending policy and uses the returned content. Each new successful charge payment spends tokens again.

### Other charge payment formats

Both ends must support the selected format. The client chooses from the server's advertised preference order, subject to wallet capabilities and local policy.

| Format | How it works | Who pays transaction costs? |
| --- | --- | --- |
| `permit2` | Payer signs a Permit2 authorization; relayer calls Permit2 to transfer the tokens | Relayer; payer separately pays token-approval costs |
| `authorization` | Payer signs a token-native EIP-3009 transfer authorization; relayer submits it | Relayer; requires a compatible token and explicitly configured signing domain |
| `transaction` | Payer signs a TRON token-transfer transaction; server checks and broadcasts it | The payer account signing that transaction |
| `hash` | Client broadcasts a token transfer and supplies its confirmed hash | Payer |

Payment splits require Permit2. A public transaction hash alone is weaker evidence of payer identity than a signed payment credential; apps using hash mode must provide any required user authentication. See the [protocol guide](docs/PROTOCOL.md) for format details and contract-wallet support.

### Charge recovery

If submission times out, your app must check the original payment before creating another payment:

- Keep the charge method and call `chargeMethod.reconcile(challengeId)` to check a known saved submission. It returns a receipt when recovery succeeds, without executing your content handler or broadcasting another transaction.
- Retrying the same pending credential can check its saved hash without another broadcast. A completed charge credential cannot buy a second response; a replay is rejected with HTTP 402.
- In client-broadcast hash mode, errors after submission retain the hash as `error.hash` and `error.details.hash`. Save it and check its outcome before paying again. A confirmed revert remains a `TransactionRevertedError`.
- If a submission has no known hash, the app/operator must investigate the submitting wallet. Do not discard the pending record to force another payment.

## Session: fund once, authorize ongoing use

For example, Alice deposits 1 USDT into escrow to buy messages from Bob at 0.1 USDT each. Instead of sending a blockchain transaction for each message, Alice signs **vouchers** and Bob records usage off-chain. Later, escrow pays Bob and refunds Alice's unsettled remainder.

A voucher is a signed authorization for a **cumulative total**. A voucher for 0.4 USDT followed by one for 0.8 USDT authorizes 0.8 USDT total, not 1.2 USDT. The merchant can settle the accepted authorized amount even if some corresponding service has not been used yet.

### Session terms in plain language

| Term | Meaning |
| --- | --- |
| Channel | One payer/merchant agreement backed by tokens in escrow |
| Deposit | Total tokens funded into the channel; this total does not shrink when settlement pays the merchant |
| Voucher / `acceptedCumulative` | The highest cumulative amount authorized by an accepted spending voucher |
| `spent` | Total price of service the app has charged through the SDK's accounting |
| `settledOnChain` | Total tokens already paid from escrow to the merchant, as recorded by the server |
| Top-up | Additional tokens moved from payer to escrow; it does not itself raise voucher authorization |
| Settlement | Pay an authorized amount from escrow while keeping the channel open |
| Cooperative close | Finalize the channel with payer/merchant cooperation, pay any further amount owed, and refund the remainder |
| Forced close | Payer starts a waiting period, then withdraws the unsettled remainder without needing merchant cooperation |

Available service credit is `min(acceptedCumulative, deposit) - spent`. Remaining tokens in escrow are a different amount: deposit minus tokens already settled.

### Session opening sequence with Permit2

This diagram uses sponsored funding and an app-controlled opening with no service charge. The app selects this behavior with `chargeOnVerify: false` and handles the opening response itself. Default automatic billing is explained below.

```mermaid
sequenceDiagram
    participant Buyer as Buyer app
    participant Client as Client SDK
    participant Server as Server SDK
    participant Store as App-provided store
    participant Escrow as Escrow contract
    participant Permit2 as Permit2 contract
    participant Token as USDT contract
    Note over Buyer,Token: Buyer explicitly approves the USDT contract to allow Permit2 transfers
    Buyer->>Client: Choose a 1-USDT opening deposit
    Client->>Server: Request session terms
    Server-->>Client: HTTP 402 with unit price and channel terms
    Client->>Client: Validate policy, sign funding permit and opening request
    Buyer->>Buyer: Save exact pending credential before sending it
    Client->>Server: Signed opening credential
    Server->>Store: Reserve sponsored funding
    Server->>Escrow: Relayer calls openWithPermit2
    Escrow->>Permit2: Call permitWitnessTransferFrom
    Permit2->>Permit2: Verify signature and use one-time nonce
    Permit2->>Token: Transfer 1 USDT from payer to escrow
    Server->>Server: Confirm funding and verify the channel
    Server->>Store: Save funding and channel accounting
    Server-->>Buyer: Receipt through the app's opening response
    Buyer->>Buyer: Save channel ID and receipt
```

The outer transaction targets **escrow**, which then calls **Permit2**. For a Permit2 charge, the relayer calls Permit2 directly. In both flows, Permit2 instructs the token contract to move tokens directly to their destination; it does not hold the payment.

### Session voucher and service sequence

This diagram uses app-controlled metering. A message can instead be an API request, generated token, byte, or another unit your app defines.

```mermaid
sequenceDiagram
    participant Buyer as Buyer app
    participant Client as Client SDK
    participant Server as Server SDK
    participant Store as App-provided store
    participant Service as Merchant app
    Buyer->>Client: Authorize 0.4 USDT cumulatively
    Client->>Client: Sign voucher and separate HTTP request proof
    Client->>Server: HEAD request with signed voucher credential
    Server->>Store: Save accepted voucher without charging service
    Server-->>Buyer: Receipt
    loop Each paid message
        Buyer->>Client: Request a message using authorized credit
        Client->>Server: Credential with fresh signed HTTP request proof
        Server->>Store: Verify voucher and reserve request nonce
        Server-->>Service: Allow handler to run
        Service->>Server: manager.consume for one unit and a stable request key
        Server->>Store: Save increased spent and duplicate-charge record
        Server-->>Service: Debit saved
        Service-->>Buyer: Message and updated receipt
    end
    Note over Buyer,Service: No blockchain transaction for voucher updates or individual messages
```

The request proof authenticates this particular HTTP request. A voucher published during settlement cannot be reused to obtain someone else's service. Replaying a successful service credential returns HTTP 409; a new signed request is a new service attempt, subject to available credit. Updating the same voucher through `HEAD` is idempotent and does not charge a unit.

### Session settlement and close sequence

```mermaid
sequenceDiagram
    participant Buyer as Buyer app and SDK
    participant Service as Merchant app
    participant Server as Server SDK
    participant Store as App-provided store
    participant Escrow as Escrow contract
    participant Token as USDT contract
    Service->>Server: Choose to settle the accepted voucher
    Server->>Store: Reserve settlement and load voucher
    Server->>Server: Use configured merchant signer for authorization
    Server->>Escrow: Relayer submits settlement
    Escrow->>Token: Transfer newly owed amount to merchant
    Server->>Store: Save confirmed settlement accounting
    Buyer->>Buyer: Choose final total and sign close credential
    Buyer->>Server: Submit cooperative close
    Server->>Store: Reserve close and validate final voucher
    Server->>Server: Use configured merchant signer for close authorization
    Server->>Escrow: Relayer submits close
    Escrow->>Token: Pay any additional amount to merchant
    Escrow->>Token: Refund remaining tokens to original payer
    Server->>Store: Save finalized channel accounting
    Server-->>Buyer: Close receipt
```

This shows `createConfiguredSession(...).serverAdapter(payeeSigner)`, where the merchant signs off-chain and a relayer submits. Permit2 is used for funding; settlement and refunds spend tokens already held by escrow.

### What the SDK does for sessions

- Checks trusted channel terms, token, chain, merchant, unit-price cap, and cumulative spending cap before the configured wallet signs or funds a payment plan.
- Uses the wallet to sign vouchers, funding authorizations, and separate HTTP request proofs. Custom wallets must implement `signRequest` as well as payment signing.
- With the configured helpers, resolves the embedded escrow, builds sponsored funding calls, and confirms the expected channel and deposit events.
- Verifies vouchers and request proofs, rejects reused service credentials, and updates accounting through the app-provided atomic store.
- Debits a service unit automatically by default, or debits explicit usage when the app calls `manager.consume`.
- Provides settlement, close, reconciliation, receipt, and stream-event helpers. It enforces payment rules when the app calls these operations; it does not decide when your business should invoke them.

### What your app must do for sessions

- Arrange a compatible escrow deployment, its token allowlist, Permit2 address, and network. The SDK does not deploy contracts. Supported tokens must transfer the exact amount and must not rebase balances.
- Set the service price and unit, payer spending limits, deposit/top-up amounts, trusted merchant, network, and funding format.
- Provide wallets and transaction resources. The merchant signer must belong to the channel's payee; a separate relayer may pay transaction costs.
- Arrange token approval when funding requires it. The escrow is the Permit2 spender for sessions; the payer's token allowance is still granted to Permit2.
- Implement `preparePayment` to return unsigned instructions: open, update a voucher, top up, merge funding with a voucher, or close. Choose amounts from local policy and saved state. Do not sign, approve, or broadcast inside that callback; the SDK checks the plan before wallet execution.
- Supply shared persistent storage with atomic updates for server accounting. Save client channel IDs, receipts, exact pending credentials, and submitted hashes durably as needed for recovery.
- Build the HTTP routes and service responses. Choose automatic billing or explicit metering, and persist each manual debit before delivering that unit.
- Decide when to ask for a higher voucher, accept more deposits, settle, close, reconcile, and prune old request records. Operator routes and their authentication belong to the app.
- Handle delivery failures and business retries. The SDK does not cache article/message bodies or guarantee that a saved debit reached the user's screen.

### Session deployment configuration

Deploy `TronPaymentChannel` from the separate [contract repository](../tron-mpp-sdk-contract/README.md), or use a compatible existing deployment on the intended network. Configure its token allowlist and Permit2 contract. Its close grace period must be at least 900 seconds.

**For SDK maintainers building a release:** set the deployed escrow in the SDK repository's `.env` before building:

```dotenv
TRON_SESSION_ESCROW_ADDRESS=<deployed escrow address>
```

```sh
npm run build
```

The build validates and embeds the public address. A missing, invalid, or zero address fails the build, including when building only to use charge. `npm pack` and `npm publish` also run the build through `prepack`. The release build environment therefore needs this configuration. `.env` files are excluded from the package.

**For apps using a built package:** use `createConfiguredSession` from `tron-mpp-sdk/session`. It uses the embedded escrow; it does not read an escrow address from the app's `.env` or from `node_modules` at runtime. The app supplies the transport, token, and Permit2 address. Changing a published embedded deployment requires a rebuilt SDK release; restart apps after changing a local SDK build.

Call `session.inspect()` before using the configured deployment. It checks the escrow's Permit2 address, token allowlist, grace period, and both signing domains against the configured chain ID. It does not independently prove the RPC node's network. Lower-level APIs accepting an explicit escrow remain available for existing integrations.

### Session server example

The app supplies `relayerTronWeb`, `merchantTronWeb`, `tokenAddress`, `merchantAddress`, `permit2Address`, and `redisWithAtomicUpdate`. The merchant wallet must match `merchantAddress`. This example uses automatic one-unit billing; app-controlled opening and streaming require the explicit metering mode described next.

```ts
import { Mppx, Store, tron } from 'tron-mpp-sdk/server'
import { chains } from 'tron-mpp-sdk'
import { createTronWebTransport } from 'tron-mpp-sdk/tronweb'
import { createConfiguredSession } from 'tron-mpp-sdk/session'

const relayerTransport = createTronWebTransport(relayerTronWeb, {
  chainId: chains.nile,
})
const merchantTransport = createTronWebTransport(merchantTronWeb, {
  chainId: chains.nile,
})
const session = createConfiguredSession(relayerTransport, {
  currency: tokenAddress,
  permit2Contract: permit2Address,
})
await session.inspect()

const sessionMethod = tron.session({
  adapter: session.serverAdapter(merchantTransport.signTypedData!),
  currency: tokenAddress,
  recipient: merchantAddress,
  credentialTypes: ['permit2'],
  permit2Contract: permit2Address,
  store: Store.redis(redisWithAtomicUpdate),
})
const payment = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,
  methods: [sessionMethod],
})
const paid = payment.session({
  amount: '100000', // 0.1 USDT per unit for a six-decimal token.
  unitType: 'message',
  suggestedDeposit: '1000000',
})

export async function handler(request: Request) {
  const result = await paid(request)
  if (result.status === 402) return result.challenge
  return result.withReceipt(Response.json({ message: 'Paid message' }))
}
```

Mppx handles management responses such as `HEAD` voucher updates, top-ups, and close without running the paid-content handler. Your framework must forward its response and receipt. See the [integration guide](docs/PROTOCOL.md) for the full HTTP behavior.

### What the configured session helper provides

`createConfiguredSession(transport, options)` returns helpers bound to the same embedded escrow:

| Helper | Use it to |
| --- | --- |
| `session.inspect()` | Read and check the deployed contracts before use |
| `session.metadata` | Display the configured chain ID and escrow address |
| `session.wallet` | Sign and execute session payment plans with the supplied payer transport |
| `session.client(...)` | Create the client method with the embedded escrow and transport chain ID already selected |
| `session.assertRequest(request)` | Reject a challenge with a different chain ID or escrow |
| `session.computeChannelId(...)` | Calculate the channel ID from its participants, token, salt, signer, chain, and escrow |
| `session.serverAdapter(payeeSigner)` | Build the server adapter using merchant authorization signatures and relayer submission |
| `session.approve(amount, hooks)` | Explicitly approve Permit2 on the configured token contract |
| `session.force(action, channelId, hooks)` | Submit payer forced-close or withdrawal operations |
| `session.stateBinding(...)` | Identify which deployment and wallets a saved client state belongs to |

For tooling, `getSessionEscrowAddress()` from `tron-mpp-sdk/config` returns the embedded address without reading runtime environment variables. App session flows should use the configured session helper so signing, policy, and transaction targets use the same deployment.

### Session client example

The app supplies `payerTransport`, token/Permit2/merchant/payer addresses, and a `choosePaymentPlan` callback implementing `preparePayment`. The [integration guide](docs/PROTOCOL.md#sessions) shows payment-plan examples and alternative funding formats.

```ts
import { Mppx } from 'tron-mpp-sdk/client'
import { createConfiguredSession } from 'tron-mpp-sdk/session'

const session = createConfiguredSession(payerTransport, {
  currency: tokenAddress,
  permit2Contract: permit2Address,
})
await session.inspect()

const method = session.client({
  recipients: [merchantAddress],
  payer: payerAddress,
  maxUnitAmount: '100000',
  maxCumulativeAmount: '2000000',
  preparePayment: choosePaymentPlan, // App returns an unsigned payment plan.
})
const client = Mppx.create({ polyfill: false, methods: [method] })
```

Your app chooses the action and amount in `choosePaymentPlan` and saves the resulting channel ID and pending credential before submitting a request. A standalone voucher update uses `HEAD`; a paid request uses the route and method your app defines. Creating a new credential is not a recovery strategy for an unresolved payment.

`createConfiguredSession` is a **Node.js entry point**. The separate protocol and client entry points remain browser-compatible; browser apps need an appropriate wallet integration rather than importing the Node.js helper.

### Automatic billing versus app-controlled metering

- **Automatic billing (default):** a successful open/voucher service request consumes one unit before your handler runs. The opening voucher must cover that first unit. `HEAD` voucher updates, top-ups, and close are management operations and do not charge a service unit.
- **App-controlled metering:** set `chargeOnVerify: false` on `tron.session`. The SDK still authenticates the request and prevents service-credential replay, but your app decides how many units to charge. Call `sessionMethod.manager.consume(requestTerms, channelId, units, stableRequestKey)` before delivering each unit. The `requestTerms` are the verified session request terms, and the stable key identifies that particular debit. Opening can then be a management-only response with a zero-value initial voucher, as in the opening diagram.
- **Streaming:** your app creates the stream, records each debit before sending a chunk, stops when credit is insufficient, and sends a final receipt with the updated totals. SDK helpers `needVoucherEvent` and `receiptEvent` format the payment events. `result.withReceipt(streamingResponse)` preserves the stream, but its initial receipt does not describe later usage; emit the final updated receipt too.

A stream is a way to deliver content progressively, not a required unit of payment. `SESSION_STREAM_UNITS` and commands such as `npm run session:pay` belong to the separate test app, not to this SDK's public API.

### Which session actions send blockchain transactions?

These are SDK operations or payment-plan actions; your app chooses command names and HTTP routes.

| Action | Token or contract effect | Who pays transaction costs? |
| --- | --- | --- |
| Explicit `session.approve(amount)` | Calls the token contract to approve Permit2; no tokens move | Payer transport |
| Open with Permit2 | Payer tokens go directly into escrow through Permit2 | Relayer |
| Top-up or voucher merged with Permit2 funding | More payer tokens go directly into escrow | Relayer |
| Voucher update, paid message, or streamed unit | Signed messages and stored accounting only | No blockchain transaction |
| `sessionMethod.manager.settle(channelId)` | Escrow pays accepted cumulative authorization minus what was already settled | Relayer in the configured server example |
| Cooperative close | Escrow pays any additional agreed amount and refunds the remainder | Relayer in the configured server example |
| `session.force('requestClose', channelId)` | Starts the payer's waiting period; no refund yet | Payer transport |
| `session.force('withdraw', channelId)` | After the waiting period, refunds the unsettled remainder to the original payer | Payer transport |
| `sessionMethod.manager.reconcile(channelId)` | Checks a known operation and may update stored accounting; no new transfer | No new blockchain transaction |

Use a payer transport for approval and forced recovery, and the configured relayer transport for sponsored server operations. `session.approve(amount)` is an explicit transaction helper; the app decides whether approval is needed and can pass `'0'` to revoke. It does not automatically skip an unchanged allowance. Permit2 funding consumes a one-time nonce on successful execution; token allowance is stored separately in the token contract. For direct hash funding instead, the payer funds the channel and pays transaction costs.

### Session accounting example

With a six-decimal token:

1. Alice deposits **1 USDT**. Escrow holds it; Bob has received no tokens yet.
2. Alice signs a voucher for **0.4 USDT cumulatively**. No tokens move.
3. The app delivers three 0.1-USDT messages and records **`spent = 0.3 USDT`**.
4. If Bob settles the accepted voucher, escrow pays him **0.4 USDT**, including 0.1 USDT of unused prepaid service credit. That remaining service credit can still be consumed while the channel is open.
5. Closing cannot refund an amount already settled. If the channel closes at 0.4 USDT, Alice receives **0.6 USDT back**.

The app chooses the final close amount and obtains the payer's signature. The SDK rejects a close voucher below recorded service spending, and the contract enforces what has already been settled. The test app chooses the greater of recorded spending and previous settlement; this choice is app policy, not an automatic refund rule for every SDK integration.

### Where session records live

**Your app supplies storage; the SDK supplies the payment-accounting logic.** The SDK does not automatically create `.data/session/server.json` or `client.json`.

- **On-chain:** channel funding, settled totals, forced-close requests, and finalization. Token contracts record balances and transfers. Individual usage debits are not separate blockchain transactions.
- **Server store supplied by the app:** accepted vouchers, `spent`, observed deposit/settlement totals, used request IDs, funding records, and pending settlement/close operations. The SDK reads and updates these through `Store.AtomicStore`.
- **Client storage supplied by the app:** channel ID, deployment binding, exact pending signed credentials, transaction hashes, and the latest receipt. The app must decide when and how to save these.
- **Product records supplied by the app:** orders, message bodies, delivery results, business idempotency keys, and any response cache.

The local test app uses JSON journals in `.data/session`. Those filenames and its `jq` inspection commands are app features. A production deployment needs a store appropriate for its process and recovery model. `Store.memory()` loses records on restart and is suitable only where that loss is acceptable, such as disposable tests. Multiple workers need a shared atomic store.

### Session recovery and record cleanup

- Call `sessionMethod.manager.reconcile(channelId)` for a known uncertain settlement or close. For saved sponsored funding, use `manager.reconcileFunding(request, channelId, funding)`; see the integration guide for the required saved inputs. These checks do not broadcast a new payment or deliver content. Confirmed failures release the operation so the app can choose to retry; unknown results remain pending.
- Preserve the exact funding authorization and submitted hash. Sponsored funding can be checked after its authorization expires. A missing hash requires operator investigation.
- A service debit is persisted before delivery. If delivery fails afterward, the app must reconcile the service result or recover its cached response. A new signed request is a new service attempt; an `Idempotency-Key` header alone does not bypass billing.
- For payer recovery, request forced close, wait until the on-chain close timestamp plus the contract's grace period, then withdraw the unsettled remainder. The merchant may settle during the waiting period. The built-in adapter cannot automatically confirm external forced withdrawal in server accounting; that needs a custom `confirmedChannel` adapter at the required confirmation depth.
- Keep a deployment binding with saved client state: `session.stateBinding({ serverUrl, recipient, payer })`. Reject saved state when it no longer matches the configured wallets, token, network, and escrow.
- For explicit approval and forced recovery, use `beforeSubmit` to save a pending reservation after simulation and `onSubmitted(hash)` to save the hash before waiting for confirmation. If the result is uncertain, retain those records instead of starting another transaction.
- Request records are capped by `maxIdempotencyRecords` (default **10,000 per channel**). At the limit, new records fail before charging. Once the channel is closed and `requestRetentionMs` has elapsed (default **24 hours**), schedule `manager.pruneRequests(channelId)` to remove expired records in batches. Active records are retained; the closed-channel marker remains so cleanup cannot reopen the channel.

## Challenge lifetime and storage limits

Issued HTTP challenges need a finite future expiry. Mppx defaults to five minutes. The SDK saves the exact issued challenge so altered terms cannot be accepted later.

The challenge store uses 256 bounded groups, each holding at most `maxIssuedChallengesPerBucket` live challenges (default 64). Expired entries are removed when a group is accessed. A full group returns HTTP 503 without issuing another challenge; existing challenges remain valid. See the [protocol guide](docs/PROTOCOL.md) before upgrading a store using an older challenge format.

## Build and validate this repository

Use the SDK `.env` deployment configuration described above before building locally:

```sh
npm run check
npm test
npm run build
npm run test:package
```

- `check` checks TypeScript.
- `test` runs the automated SDK tests using a deterministic test escrow address; the source tests do not need the SDK `.env`.
- `build` reads the SDK `.env`, validates the escrow address, and builds the package.
- `test:package` packs and extracts the real package, checks that `.env` files are excluded, and checks installed and bundled consumers with a conflicting runtime escrow variable. It makes no chain calls.

Changing the SDK code or embedded escrow requires rebuilding and restarting apps using that build. Contract tests and TRON compilation live in the separate [contract repository](../tron-mpp-sdk-contract/README.md).

## More detail

- [Protocol and integration guide](docs/PROTOCOL.md): full request formats, payment plans, HTTP behavior, storage, migration, and recovery.
- [End-to-end implementation map](docs/END_TO_END_FLOW.md): how protocol, client, server, transport, and contracts fit together.
- [Contract repository](../tron-mpp-sdk-contract/README.md): escrow implementation and deployment requirements.
- [Local test app](../tron-mpp-sdk-app-test/README.md): command-by-command Nile charge and session walkthroughs, wallet impacts, and JSON-journal inspection.
