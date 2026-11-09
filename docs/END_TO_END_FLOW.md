# TRC-20 payment flow and implementation map

The SDK has two payment intents: `tron.charge` for one-time payments and
`tron.session` for escrow-backed metered service. Both use TRC-20 contract addresses
as currencies and integer strings for atomic amounts. The method identifier is
`tron`; transaction construction, networks and signatures use TRON interfaces.
See [protocol integration](PROTOCOL.md) for configuration examples.

## Charge flow

1. The application configures a token contract, recipient, numeric chain ID,
   supported credential types and an atomic replay store.
2. A request without payment receives HTTP 402 and a `WWW-Authenticate: Payment`
   challenge. Mppx authenticates it with the server secret. The HTTP transport
   persists the exact issued challenge before returning it.
3. The client validates expiry, chain, currency, amount cap, the primary and split
   recipients against a local allowlist, credential preference, and any locally
   trusted Permit2 contract/spender before signing or broadcasting.
4. The client creates one negotiated credential:
   - `permit2`: signs a challenge-bound typed witness after checking token balance,
     prior approval and nonce availability; the server submits the token transfer.
   - `authorization`: signs a token-native transfer authorization with a nonce
     derived from the challenge; the server submits it. The token must support
     this operation and its signing domain must be configured explicitly.
   - `transaction`: signs a TRON protobuf transaction envelope; the server verifies
     its signature, owner, token, exact transfer calldata and absence of attached
     native value before broadcasting it.
   - `hash`: broadcasts the token transfer and returns its confirmed transaction
     hash. This format has weaker payer/challenge binding.
5. The client retries with `Authorization: Payment ...`. Mppx verifies the
   challenge HMAC and route binding; the SDK checks the stored auth-params.
6. The server validates the credential and simulates server-submitted calls. It
   reserves outgoing payments before submission, waits for a successful mined
   receipt and sufficient confirmations, then verifies the required token events.
   A rejected hash does not consume its challenge.
7. Atomic challenge and transaction markers prevent duplicate payment use. Success
   returns a `Payment-Receipt` with the protected response. Retries of a submitted
   credential confirm its saved hash without another broadcast. The returned charge
   method also exposes `reconcile(challengeId)` for explicit recovery. Credential
   rejection returns 402, a fresh challenge and standard Problem Details; unknown
   submission outcomes remain 503 pending recovery.

## Session flow

1. A session challenge quotes a token price per unit, payee, escrow and supported
   funding formats. The server requires a persistent atomic store.
2. The wallet opens a channel directly or authorizes a relayed deposit. Its ID binds
   payer, payee, token, salt, delegated signer, escrow and chain ID.
   Client `preparePayment` returns an unsigned plan. The SDK checks its spending
   limit and any existing channel's identity and balance before `wallet.createPayload`
   signs or broadcasts. Management top-ups may replenish an exhausted channel.
3. The server confirms that funding affected the exact escrow/channel and verifies
   the initial voucher and channel state. Sponsored deposits bind channel terms
   through Permit2 witnesses or deterministic authorization nonces. Before
   sponsoring a transaction, it validates the intended channel, voucher, amounts,
   and HTTP request proof.
4. The client submits cumulative vouchers. The server verifies signatures before
   stale-voucher idempotency, checks uint128/deposit limits and minimum increments,
   and persists the highest accepted amount. Each HTTP payload also includes a
   separate off-chain signature over its challenge, payload and request nonce;
   signatures published during settlement cannot authenticate HTTP requests.
5. Service consumption atomically advances `spent` before delivery. Request keys
   prevent duplicate charging through separate durable records and a write-ahead
   marker. The channel record stays constant in size. Available credit is
   `min(acceptedCumulative, deposit) - spent`.
   HTTP service credentials consume their signed nonce once; replay attempts
   cannot run another paid handler. A client-supplied `Idempotency-Key` does not
   suppress billing for a fresh signed request. Applications own business-response
   caching when they need idempotent retries.
6. The payee settles a persisted voucher or cooperatively closes the channel. The
   payer can request forced close and recover uncommitted funds after the grace
   period, during which the payee may still settle. Finalized records stay on-chain
   so old vouchers cannot be replayed against a reopened channel ID.
   Confirmed failures release local operation reservations; uncertain submissions
   require `manager.reconcile` without another broadcast. Closed request history
   can be pruned after retention, while the closed channel tombstone remains.

## Naming and responsibilities

| Module or function | Responsibility |
| --- | --- |
| `src/protocol/Charge.ts` | Charge schema, method definition, witnesses and credential validation |
| `src/protocol/Session.ts` | Session schema, method definition and funding authorization validation |
| `src/protocol/Primitives.ts` | Shared address, integer and signature validation; channel IDs and typed data |
| `src/protocol/Errors.ts` | Shared transaction and session Problem Details errors |
| `src/client/Charge.ts` | Client charge policy, negotiation and credential creation |
| `src/client/Session.ts` | Client session policy and voucher helper |
| `src/server/Charge.ts` | Charge orchestration, replay reservations and receipts |
| `src/server/Session.ts` | Channel verification, durable accounting, consumption and settlement |
| `src/server/SessionStore.ts` | Versioned session persistence, monotonic observations, request deduplication and pruning |
| `src/server/Challenges.ts` | Persistence and exact comparison of issued HTTP challenges |
| `src/tronweb/Transport.ts` | TronWeb calls, signatures, broadcasts and receipt confirmation |
| `src/tronweb/Token.ts` | Token/Permit2 ABIs and ordered TRC-20 transfer-event verification |
| `src/tronweb/Charge.ts` | Charge settlement adapter |
| `src/tronweb/Session.ts` | Escrow adapter, wallet funding and settlement relayer |
| `normalizeAddress` / `toBase58Address` | Convert address representations without changing the account |
| `formatSource` / `parseSource` | Format or validate a chain-scoped payer identity |
| `createChargeAdapter` / `createSessionAdapter` | Connect the corresponding intent to a TRON node |
| [`TronPaymentChannel.sol`](../../tron-mpp-sdk-contract/contracts/TronPaymentChannel.sol) in the separate `tron-mpp-sdk-contract` repository | On-chain escrow, voucher enforcement and refunds |

There is one implementation for each intent. Client and server entry points expose
`tron.charge` and `tron.session`; the package root exposes their protocol namespaces
and shared primitives. Native-transfer branches and alternate charge factories are
absent.

The exact signing-domain name `EVM Payment Channel` remains in typed data and the
escrow because the session specification requires it. Renaming that value would
change every voucher and payee-authorization digest. Compiler configuration and
specification URLs likewise retain their standard names.
