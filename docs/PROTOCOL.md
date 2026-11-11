# TRC-20 payment protocol

This SDK implements TRC-20 charges and escrow sessions using the mechanisms in the
[charge specification](https://github.com/tempoxyz/mpp-specs/blob/main/specs/methods/evm/draft-evm-charge-00.md)
and [session specification](https://github.com/tempoxyz/mpp-specs/blob/main/specs/methods/evm/draft-evm-session-00.md),
reviewed on November 6, 2026. The public methods are `tron.charge(...)` and
`tron.session(...)`. All amounts are integer strings in token atomic units.
Native coin payments are unsupported.

TRON uses its own nodes and protobuf transaction format. The method identifier
is `tron`, and payer sources use `did:pkh:tron:<numeric chain ID>:<Base58Check payer>`.
Schemas and typed signatures follow the referenced token-payment mechanisms;
Ethereum RLP transactions and ERC-4337 entry points are not implemented.

## Supported mechanisms

| Mechanism | Implementation |
| --- | --- |
| Shared MPP HTTP challenge, credential, retry and receipt | `mppx`; authenticated challenges, route binding, and persisted issued auth-params |
| Address comparison | Decoded 20-byte value; accepts Base58Check, TRON `41...`, and `0x...`; new requests normalize to checksummed `0x...` |
| Chain/domain separation | Numeric TRON chain ID; explicit contract addresses; TIP-712 interoperable typed data |
| `charge/permit2` | Explicit deployed TRON Permit2 and submitting spender; prior token approval; single/batch witness transfers and ordered splits |
| `charge/authorization` | Opt-in, only for a token configured with its actual EIP-3009 domain and entry point |
| `charge/transaction` | Client signs a TRON transaction; server validates its protobuf/JSON consistency, signature, owner, token and exact calldata before broadcasting |
| `charge/hash` | Client broadcasts; server confirms receipt and every required token event; single-use transaction hash |
| `session` core | Open, topUp, cumulative vouchers, settle, cooperative close, requestClose and withdraw |
| Session sponsored deposits | Permit2 witness or token-native `receiveWithAuthorization(bytes signature)` |
| Session relayed settle/close | Separate typed payee authorization plus voucher, shared nonce used-set |
| Delegation and contract wallets | `authorizedSigner`; canonical EOA signatures; ERC-1271 verification for vouchers and Permit2 |
| HTTP session authentication | Separate `SessionRequest` typed proof bound to the challenge, payload and a unique request nonce |
| Durable accounting | Atomic `Store.update`; accepted cumulative amount, spent and settled totals; request idempotency keys |
| Streaming primitives | `manager.consume`, `needVoucherEvent`, `receiptEvent`; application owns the streaming loop |
| Settlement evidence | Successful mined receipt, configurable confirmation depth, exact token transfers and escrow events |

There is no
assumption that TRON USDT implements EIP-3009: enabling `authorization` is an
explicit token-specific integration decision. Standard `transferWithAuthorization`
uses `(v,r,s)` for charge; session uses the draft's packed-signature
`receiveWithAuthorization` overload.

The charge draft has two ABI/encoding inconsistencies. Its literal `PaymentWitness`
suffix includes an extra space before `string externalId`; canonical EIP-712
encoding has no space after that comma. This implementation uses canonical
encoding in both signing and contract calls. The draft calls the batch Permit2
function `permitBatchWitnessTransferFrom`; deployed Permit2 uses an overload of
`permitWitnessTransferFrom`. The adapter calls that overload.

## Charge server

```ts
import { Mppx, tron, Store } from 'tron-mpp-sdk/server'
import { chains } from 'tron-mpp-sdk'
import { createTronWebTransport, createChargeAdapter } from 'tron-mpp-sdk/tronweb'

// relayerTronWeb holds the submitting account; bind it to the correct node.
const transport = createTronWebTransport(relayerTronWeb, { chainId: chains.nile })
const adapter = createChargeAdapter(transport, { minConfirmations: 1 })
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
// All route amounts are token ATOMIC units.
const paid = payment.charge({ amount: '1250000', externalId: 'invoice-42' })

export async function handler(request: Request) {
  const result = await paid(request)
  if (result.status === 402) return result.challenge
  return result.withReceipt(Response.json({ result: 'paid content' }))
}
```

To offer splits, include the complete `methodDetails` (chain ID, credential types,
Permit2 contract, spender and splits) in the route options. Splits are atomic-unit
strings, sum to less than the total amount, and require Permit2. The primary
recipient receives the total minus the splits. Remote decimals are display hints;
client spending policy uses atomic units.

## Charge client

```ts
import { Mppx, tron } from 'tron-mpp-sdk/client'
import { chains } from 'tron-mpp-sdk'
import { createTronWebTransport, createChargeAdapter } from 'tron-mpp-sdk/tronweb'

const adapter = createChargeAdapter(
  createTronWebTransport(walletTronWeb, { chainId: chains.nile }),
)
const { fetch } = Mppx.create({
  polyfill: false,
  methods: [tron.charge({
    adapter,
    chainIds: [chains.nile],
    currencies: [tokenAddress],
    recipients: [merchantAddress], // Include every expected split recipient.
    maxAtomicAmount: '1250000',
    // Trusted local configuration, never an automatic approval from a challenge.
    permit2: { address: deployedPermit2Address, spender: relayerAddress },
  })],
})
const response = await fetch('https://merchant.example/paid')
```

Charge clients require a local `recipients` allowlist. It must include the primary
recipient and every expected split recipient; addresses are compared by account
value across supported encodings. Unlisted recipients are rejected before signing
or broadcasting. Expired or invalid challenge expiry timestamps are also rejected
before payment, including when calling `createCredential` directly.

Client selection follows the server's preference order, intersected with wallet
capabilities and optional local `credentialTypes`. The user must approve the
configured TRON Permit2 contract separately before Permit2 payments. The SDK never
creates an unlimited approval automatically. Hardware/broadcast-only wallets can
restrict local types to `['hash']`. Hash mode has the charge draft's weaker binding:
a public transaction hash is not itself payer authentication. Prefer signed
transactions or Permit2, and apply application authentication when using hashes.

TRON `transaction.signature` is a serialized signed TRON transaction JSON envelope,
not an Ethereum RLP string. `hash` is always `0x` followed by 32 bytes, even though
TRON's native APIs usually return unprefixed transaction IDs.

Charge credentials may omit `source`. The server recovers an EOA Permit2 signer,
uses and verifies EIP-3009 `from`, or recovers a signed transaction's owner. Hash
mode checks the successful receipt's token, recipient and amount without requiring
a sender when `source` is absent. A supplied source must match the signer or token
event sender. Contract-wallet Permit2 credentials must identify the wallet through
`source` because its address cannot be recovered from an ERC-1271 signature.

Charge credential rejections return HTTP 402, a fresh `WWW-Authenticate: Payment`
challenge, and the standard `malformed-credential`, `invalid-challenge`, or
`verification-failed` problem type. Replays are rejected with 402 and never grant
access twice. No payment receipt is attached to an error. Infrastructure failures
and unresolved submissions retain 500/503 responses so a pending payment is not
treated as an unpaid charge.

## Sessions

Deploy `TronPaymentChannel` from the separate
[`tron-mpp-sdk-contract`](../../tron-mpp-sdk-contract/README.md) repository
with an allowlist of exact-transfer,
non-rebasing tokens, the selected TRON Permit2 address (or zero when disabled),
and a grace period of at least 900 seconds. No deployment is performed by this SDK.
Use a separate deployment per network. Confirm the address and supported entry
points before advertising sponsored formats. SUN.io publishes a TRON Permit2
deployment, but a deployment on Nile/Shasta must be configured independently.

```ts
import { Mppx, tron, Store } from 'tron-mpp-sdk/server'
import { createSessionAdapter } from 'tron-mpp-sdk/tronweb'

const sessionMethod = tron.session({
  adapter: createSessionAdapter(serverTransport, escrowAddress),
  currency: tokenAddress,
  recipient: serverPayeeAddress,
  credentialTypes: ['hash'],
  store: Store.redis(redisWithAtomicUpdate),
})
const payment = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,
  methods: [sessionMethod],
})
const paidSession = payment.session({ amount: '100', unitType: 'request' })
```

By default a successful open/voucher service request atomically consumes one service
unit before the handler runs. A `HEAD` voucher update is an idempotent management
action: it accepts the voucher and any merged funding without consuming service
credit, and returns an empty response with a `Payment-Receipt` header. It works
even when existing voucher credit is exhausted. TopUp/close are also management
actions and return a receipt without running the protected handler.

For a metered stream, set `chargeOnVerify: false` and pass the streaming response
to `result.withReceipt(response)`. Open/voucher service requests still run the
handler and consume their signed nonce once, with no automatic debit. The
application uses `sessionMethod.manager.consume(request, channelId, units,
idempotencyKey)` before delivering each paid chunk. Always provide unit count and
an application-controlled idempotency key consistently. The HTTP integration
rejects duplicate service credentials before granting another handler execution.
Control-only handlers using `chargeOnVerify: false` must supply their own response.
The client-supplied
`Idempotency-Key` header is not used for payment deduplication: fresh signed
requests are charged separately even when that header is reused. Applications
requiring business-operation idempotency must cache their results or reject
duplicates before invoking the paid operation. Helpers `needVoucherEvent` and `receiptEvent`
format SSE events; the application must stop delivery when authorization is
insufficient and emit the final receipt. Reuse the initial receipt headers for
streaming responses.

`needVoucherEvent` takes all four required fields, with amounts in atomic units:

```ts
yield needVoucherEvent({
  channelId,
  requiredCumulative: (BigInt(state.spent) + nextChunkCost).toString(),
  acceptedCumulative: state.acceptedCumulative,
  deposit: state.deposit,
})
```

The final `receiptEvent` must include updated accounting from the end of the
stream; the initial response receipt describes accounting at the start.

Each idempotency key has a separate durable record. The channel record holds only
constant-size accounting and a write-ahead marker, so interrupted marker writes
can be completed before a retry without charging twice. Active records are never
evicted. `maxIdempotencyRecords` defaults to 10,000 per channel: at the limit, a
new key returns `request-history-full` (409) before charging. Low-level `consume`
returns the prior accounting state for an existing key; HTTP service requests
reject an already consumed nonce with `request-replayed` (409). Set an appropriate
limit for your workload or close and open another channel. Keep the same key and
cost when retrying low-level accounting calls; a changed cost returns 400.

After closure, `requestRetentionMs` defaults to 24 hours. Call
`sessionMethod.manager.pruneRequests(channelId, 100)` from your cleanup job to
remove expired request records in batches (maximum batch size 1,000). Active
channels cannot be pruned. The closed channel tombstone remains permanently, so
pruning cannot reopen a channel or authorize another debit.

```ts
import { Mppx, tron } from 'tron-mpp-sdk/client'
import { createSessionWallet } from 'tron-mpp-sdk/tronweb'
import { Credential } from 'mppx'

const wallet = createSessionWallet(clientTransport, escrowAddress)
let channelId: `0x${string}` | undefined
const client = Mppx.create({
  polyfill: false,
  methods: [tron.session({
    chainIds: [clientTransport.chainId],
    currencies: [tokenAddress],
    escrowContracts: [escrowAddress],
    recipients: [serverPayeeAddress],
    payer: payerAddress,
    wallet,
    maxUnitAmount: '100',
    maxCumulativeAmount: '1000000',
    async preparePayment({ request }) {
      // Preparation returns unsigned instructions; choose deposits from local policy.
      const resume = request.methodDetails.channelId ?? channelId
      if (resume) return { action: 'voucher', channelId: resume, cumulativeAmount: '10000' }
      return { action: 'open', type: 'hash', deposit: '1000000', cumulativeAmount: '10000' }
    },
  })],
})
client.onCredentialCreated(({ credential }) => {
  const payload = Credential.deserialize(credential).payload
  if (payload.action === 'open') channelId = payload.channelId as `0x${string}`
})
const { fetch } = client
```

The required `recipients` allowlist is checked before payment preparation, signing,
or funding. `preparePayment` must only choose an unsigned `Session.PaymentPlan`; it must not
sign, approve, or broadcast. The SDK validates the plan and `maxCumulativeAmount`
before calling `wallet.createPayload`. The supplied wallet enforces the same
policy before signing or funding and rechecks expiry after asynchronous work.
Custom wallets must implement `Session.Wallet` and execute exactly the approved
plan, including `signRequest(data, action)` for HTTP request authentication.
Low-level `wallet.open`, `topUp`, `voucher`, `close`, and `signVoucher` calls
remain explicit application operations outside the configured client policy.

HTTP session payloads require `requestAuthorization: { nonce, signature }`.
The `SessionRequest` typed data uses the escrow's existing domain, with separate
fields for the canonical challenge hash, channel ID, canonical payload hash and
a random bytes32 nonce. It cannot be substituted with a `Voucher` signature.
The proof binds the entire normalized payload, including funding and settlement
signatures, and the challenge's ID, realm, expiry and normalized request.
These proofs are kept off-chain. Open/voucher/close requests use the channel's
voucher signer (the payer or its authorized delegate). Top-ups use the funding
owner, or the payer for direct hash funding. ERC-1271 request signatures are
verified through the configured adapter.

`tron.session` creates a fresh proof automatically after wallet execution. For
manual HTTP credentials, call `authorizeSessionRequest(challenge, payload,
signTypedData)` from `tron-mpp-sdk/client`, then serialize the returned payload.
Retries of a service credential that already succeeded are rejected; the SDK
does not cache protected-handler responses. A new signed nonce authorizes a new
billable request, subject to the accepted voucher's remaining credit.

For existing channels, the client queries the bound wallet's adapter before
signing. It verifies the payer, payee, token, active state and cumulative deposit
bounds, including any planned funding increase. Settlement transfers accepted
funds to the merchant; unused prepaid service credit remains available. The client
does not subtract on-chain settlement from service credit. Only the server's
`acceptedCumulative - spent` accounting determines whether another unit is paid.
Management top-ups and closes may operate on an exhausted channel. Prepared
updates must match an advertised resume channel.

The wallet helper's `open`/`topUp` explicitly approve the escrow for the requested
amount and wait for confirmed funding. Supply `voucherSigner` when delegating to
another signing key. Prepared sponsored opens/top-ups use the draft's authorization
fields without signatures. The wallet signs them after policy checks; configure
its `authorizationDomain` for EIP-3009. On Permit2 paths it checks the deployed
escrow's `PERMIT2()` against the advertised contract before signing. Include an
unsigned funding intent in a voucher plan's `deposit` to merge funding and voucher
submission. Permit2 open witnesses bind payee, salt and
authorizedSigner; topUp witnesses bind channelId. EIP-3009 uses deterministic
`authorizationNonce` / `topUpNonce`. Third-party sponsored topUps are donations to
the existing payer's channel; refunds always go to that payer. Sponsored topUps
preserve any pending forced-close deadline, including when a relayer submits
funding signed by the payer. Only a direct payer `topUp` cancels a pending close.
Standalone topUp management requests remain available during a pending forced
close; vouchers, including those with merged funding, and service consumption
remain unavailable. Finalized channels reject top-ups.

`manager.settle(channelId)` submits the highest persisted voucher. Cooperative
close uses a final voucher covering all delivered service and does not require a
`minVoucherDelta` increment. Ordinary voucher updates retain that minimum. A payer can call
`wallet.requestClose(channelId)`, wait for the grace period, then `wallet.withdraw`.
The payee can settle during the grace period. New vouchers/service are rejected
after a pending forced close is observed. `createSessionRelayer` and
`payeeAuthorizationTypedData` support signed, relayer-paid settle/close calls.

## Persistence and settlement recovery

Use a shared persistent atomic store for every server instance. Session state is
scoped by chain, escrow and channel. Charge replay keys are scoped by numeric chain ID and transaction hash. Session terms
remain fixed for the lifetime of a local accounting record.

Sponsored funding checks the intended channel, voucher, amount limits and local
accounting before submission. HTTP request proofs are also verified before
funding. Known uncertain funding hashes retain their existing reconciliation
behavior, without rebroadcasting an authorization.

The HTTP transport persists complete issued challenges and compares the
echoed auth-params before verification, in addition to Mppx's HMAC and route checks.
Challenges must have a finite future expiry; Mppx defaults to five minutes.
The registry uses 256 persistent buckets (`tron:issued:v2:<bucket>`), selected by
the hash of the challenge ID. Each bucket holds at most
`maxIssuedChallengesPerBucket` live entries (default 64, configurable on charge
and session methods). Use the same limit for methods sharing a store. Expired
entries are pruned atomically on issuance or verification in that bucket. Idle
buckets can retain expired entries, but total registry growth is bounded by the
256 buckets and configured limit. Full buckets return 503 without a payment
challenge; still-valid entries are never evicted to make room.

During upgrades, valid legacy `tron:issued:<id>` records migrate when verified
and bucket capacity is available; they remain usable if the bucket is full.
Expired legacy records are removed when accessed. The Store API cannot enumerate
old keys. After the last legacy challenge has expired, remove only legacy
`tron:issued:<id>` keys with your storage backend's maintenance tools, preserving
the new `tron:issued:v2:*` buckets and all payment journals and replay markers.
If previously configured challenges had no expiry, reissue them with finite expiry.

Low-level `manager.accept` and
`manager.consume` are trusted application APIs; callers must authenticate session
ownership and challenge issuance themselves. A declared `source` is not proof
of ownership. `manager.acceptRequest` additionally verifies the request proof,
but its caller must still verify challenge HMAC, expiry and route binding.
Applications should normally use the Mppx HTTP integration. Alternative
transports need equivalent issuance tracking and request authentication.

The charge/session journals reserve outgoing funding before broadcasting. A
submission timeout is ambiguous: an on-chain payment may have succeeded. Pending
reservations with unknown outcomes are retained, and sponsored funding is never
blindly resubmitted. Charge journals retain the exact credential binding, request,
payer when known, and submitted hash. Retrying the same credential before challenge
expiry rechecks a saved hash without resimulating, checking a consumed nonce, or broadcasting again.
Only one concurrent verification can complete the charge. A different credential
cannot take over a reserved charge, and settled credentials remain rejected.

Keep the returned charge method to reconcile a known submission explicitly, even
after challenge expiry:

```ts
const chargeMethod = tron.charge({ adapter, chainId, currency, recipient, store })
const receipt = await chargeMethod.reconcile(challengeId)
```

Reconciliation verifies the saved transaction evidence and returns its receipt;
it does not execute a protected handler. Calling it again after successful
reconciliation returns the saved receipt. The application owns any resulting
service delivery or refund. Unknown submissions without a saved hash remain
blocked for operator investigation. A provably unsubmitted attempt releases its
charge reservation; a confirmed reverted charge remains rejected and requires a
new challenge. Never delete an unresolved reservation merely to retry a payment.

In client-broadcast hash mode, the built-in adapter wraps RPC/confirmation errors
after submission in `TransactionOutcomeUnknownError`, retaining the known hash.
The client also preserves that hash if final credential validation fails after
payment, including challenge expiry. Read `error.hash` or `error.details.hash`
and confirm that transaction before paying again. A confirmed revert retains its
hash in `TransactionRevertedError` and remains a definitive failure. These client
errors occur before the server has a journal, so `chargeMethod.reconcile` cannot
recover them. Applications can confirm the known transfer and submit its hash
against an active matching challenge under their hash-payment policy, or arrange
service delivery/refund. They must not automatically broadcast another transfer.

Close and settle use persisted operation
records too. A confirmed revert or a `TransactionNotSubmittedError` clears that
operation; the channel can be used or retried. A timeout or an unclassified
submission exception retains it. A pending close blocks further service.

Call `sessionMethod.manager.reconcile(channelId)` to inspect an uncertain close or
settlement without broadcasting again. A known transaction hash confirmed successful
or reverted by `transactionStatus` resolves the operation. An adapter may also
implement `confirmedChannel`, returning only a snapshot at its required confirmation
depth, to reconcile hashless operations and forced withdrawals. The built-in adapter
does not provide confirmed channel snapshots, so forced withdrawals and hashless
operations require an adapter with that capability for automatic reconciliation.
An open channel alone does not prove that an outstanding transaction failed.
Custom adapters must report both transaction success and failure only at the
required confirmation depth, and close and settle must return only after confirmation.
Use `TransactionNotSubmittedError` only when no transaction was sent, and
`TransactionOutcomeUnknownError(hash, cause)` when submission may have succeeded.
These errors are exported from the package root.

Sponsored funding retries with a saved hash verify that transaction again instead
of broadcasting, including after the original funding authorization expires.
Recovery requires the exact authorization and signature previously validated and
reserved; it does not make an expired authorization valid for a new submission.
The original signed funding data can also be checked through the server-only
`manager.reconcileFunding(request, channelId, funding)` API. This never broadcasts
or delivers service and can be used after the HTTP challenge expires. Unknown
hashless submissions remain blocked. A crash between submission and recording its hash requires
looking up the submitting account's transaction; reconciliation cannot recover a
missing hash automatically. Do not delete replay history on restart or upgrade.

Sessions validate signatures before stale-voucher idempotency, enforce uint128
limits, and store spent amounts before delivery. Contract-wallet signature validity
is checked against current on-chain state. Accounting/storage failure stops service.
Public session manager calls and HTTP verification return typed payment errors:
invalid request/payload 400, signature or balance failures 402, confirmed reverts
409, unavailable channels 410, and uncertain/not-submitted transactions 503.
Infrastructure exceptions become generic 500 errors without exposing node or
storage details. Error causes remain available to server-side logging. Receipts,
including failed receipts, must reach the configured confirmation depth before
they are treated as definitive. Mppx's `{ status: 402, challenge }` is an internal
result discriminator: return the actual `challenge` Response with its error status.

Recognized contract simulation reverts use the standard session problem types
before any transaction is sent, including `invalid-signature`,
`amount-exceeds-deposit`, `channel-not-found`, `channel-finalized`, and
`insufficient-balance`; unknown VM reverts use `transaction-reverted`. RPC failures
remain distinct 500/503 errors. Custom transports must preserve definite VM
reverts as `ContractCallRevertedError(revertData)`. The provided TRON transport
retains raw constant-call revert bytes that TronWeb's builder would discard.

## Verification

### Upgrading existing integrations

Upgrade session clients and servers together. HTTP credentials without
`requestAuthorization` are now rejected, even when their voucher is valid.
The built-in wallet supplies request signing; custom `Session.Wallet`
implementations must add `signRequest(data, action)`. Manual HTTP integrations
must use `authorizeSessionRequest` or construct the equivalent typed proof.
Preserve session stores and request records during upgrades. HTTP billing no
longer uses `Idempotency-Key`; a successful service credential cannot be replayed
to run the handler again. Use application response caching for business retries.

Use `tron.charge` and `tron.session` with a configured adapter. Charge setup takes
`chainId`, `currency` (the TRC-20 contract) and `recipient`. Amounts are atomic
integer strings; display-unit conversion and native-asset configuration have been
removed. Import shared schemas and utilities from the package root. There are no
alternate factories or compatibility aliases.

Persisted charge replay keys now use
`tron:charge:transaction:<numeric chainId>:<0x-prefixed transaction hash>` and charge
journals use `tron:charge:challenge:<chainId>:<challengeId>`. Migrate any existing
token-payment replay history and reconcile pending submissions before upgrading a
running service. Keep session accounting and live issued-challenge records intact;
follow the bounded registry migration guidance above for expired legacy records.

Charge journals now have `version: 1` and retain the data needed for recovery.
Legacy consumed transaction markers continue blocking reuse. Legacy charge
journals without a version fail closed: reconcile their submissions with the old
deployment before upgrading; do not delete them to enable another payment.
Charge client integrations must now supply `recipients`. Custom charge adapters
must handle an omitted payer in `verify` for source-free hashes and implement
`transactionPayer` to accept source-free signed transactions. A custom TRON
transport's `inspectTransaction` accepts an optional expected payer and returns
the verified owner in `from`; it must always verify that owner against the
transaction signature, even when no expected payer was supplied.

Session clients now require `wallet` and `preparePayment` in place of the old
side-effecting `createPayload` callback. Move signing/funding out of preparation
and return an unsigned `Session.PaymentPlan`. Custom wallet execution belongs in
`wallet.createPayload(request, plan, policy)`. The `needVoucherEvent` helper now
takes an object with channel ID, required cumulative amount, accepted cumulative
amount and deposit. New funding journals bind the exact signed authorization;
legacy journals without that binding still require full authorization validation.
Reconcile pending legacy funding before upgrading, especially when its
authorization is near expiry. Keep all funding/replay history intact.

Session state now uses version 2. Reading an older session lazily migrates its
inline request map into separate durable records before removing the map. Stop
all old server writers before starting the upgraded version; mixed old/new
writers are unsupported. Migration preserves spent totals and request keys.
Legacy `closing: true` records become unknown close operations and require
reconciliation; they are not automatically unlocked. Back up the store before
upgrading. Versioned malformed state fails closed as an infrastructure error.

The store must provide durable, linearizable single-key atomic `update` across
all server instances. Callbacks may be retried and must run synchronously. Request
and deletion journals handle interruptions across keys without requiring a
multi-key transaction. Store adapters must preserve pending records and channel
tombstones; do not apply TTL eviction to active accounting or request records.

### Commands

```sh
npm run check
npm test
npm run build
```

Contract source, Foundry tests, and TRON compiler tooling are maintained in the
separate [`tron-mpp-sdk-contract`](../../tron-mpp-sdk-contract/README.md)
repository. See its README for contract validation and deployment configuration.
TypeScript tests exercise real TIP-712 signatures, mocked node/transport responses,
and complete in-process HTTP payment flows. These checks do not establish live
TRON deployment or compatibility with a particular production Permit2/token
deployment; run deployment-specific integration tests on your target TRON network.
