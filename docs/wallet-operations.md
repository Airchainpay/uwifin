# Wallet operation and activation

## What is implemented

Email/password sessions use an HttpOnly browser cookie via the Next.js BFF. After signup or login, Privy authenticates using a five-minute ES256 JWT issued by `/api/privy/token`. The server revalidates the UwiFin session and uses the immutable account UUID as `sub`; the caller cannot choose a wallet identity. Privy automatically creates and restores embedded Ethereum and Solana signing wallets. No wallet extension, Connect wallet button or separate OTP login is required. Keys remain with Privy.

The browser signs the existing single-use ownership challenge automatically. The backend verifies the signature before associating an Alchemy MAv2 (`sma-b`) smart account on EVM, or the embedded address on Solana. Repeated login/setup reuses the same Privy identity and persisted wallet. Alchemy account requests omit `createAdditional` so an ambiguous retry reuses the provider account. Provisioning runs for the selected network; switching to another configured network prepares that network's wallet automatically.

Base mainnet is the default. The wallet page switches between Base, Ethereum mainnet and Solana mainnet; balances, wallet records and history are isolated per network. Switching networks reloads the page to discard stale signing state and does not bridge funds. On EVM the receiving address is the smart account address, not the signing account. On Solana it is the embedded wallet address. Only native USDC with six decimals is allowed:

| Network ID       | Chain ID | USDC contract / mint                           |
| ---------------- | -------- | ---------------------------------------------- |
| `base`           | 8453     | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`   |
| `eth-mainnet`    | 1        | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`   |
| `solana-mainnet` | N/A      | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

Addresses are from [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses). They cannot be overridden through environment variables. Legacy Base Sepolia is available only when explicitly selected as the deployment default (`ALCHEMY_NETWORK=base-sepolia`). No sample balances or timed confirmations are used.

For EVM, the backend stores an idempotent transfer intent, constructs only USDC `transfer(address,uint256)` calldata, and requires approved sponsorship. The browser uses the official Alchemy SDK to sign the returned signature request through the user's wallet. The exact prepared envelope is preserved when submitting. Signed bytes are persisted before sending to Alchemy; an ambiguous retry resends the same operation, never a fresh nonce. One active operation per wallet is enforced by MariaDB. The worker verifies chain, canonical receipt block, confirmation depth, and the matching EntryPoint operation (version, sender, nonce and success), including the expected token Transfer event within its execution logs, before confirmation. A receipt failure, reverted operation, or completed operation without the intended transfer marks the transfer failed. Missing or malformed operation evidence remains unresolved for reconciliation. Pending operations must be reconciled before another operation uses the wallet. After a confirmed or failed result, the sender can explicitly start another transfer, releasing the browser retry key; pending or uncertain requests retain their key.

History supports server pagination and filters, with CSV export of the current page. Incoming deposits are fetched through Alchemy and recorded after canonical receipt verification. The receive screen identifies the selected network. No USDC/USD peg or PHP exchange-rate quote is assumed.

## Solana wallets and transfers

Privy creates the Solana embedded signing wallet automatically. Solana ownership uses Ed25519 signatures over a single-use challenge bound to the session, user, origin and network. Base58 addresses retain their case in the database and application.

The server builds a version-0 transaction containing only associated token account `CreateIdempotent` and SPL Token `TransferChecked` for native USDC, then calls Alchemy `alchemy_requestFeePayer` with `SOLANA_POLICY_ID`. It verifies Alchemy's fee-payer signature and allows only the expected payer and rent-funder rewrite. Extra instructions, address lookup tables, altered token amounts and user-funded rent are rejected. The browser checks the rewritten instructions against the intent before adding the user's signature; the server requires the exact persisted message and preserved sponsor signature before broadcasting. Transactions are persisted before RPC submission. Retries reuse the same signed bytes and signature. Finalized receipts must contain that exact transaction. Expired transactions become failed only after finalized block height exceeds the validity window, the blockhash is no longer valid, and the provider finds no signature status. Pending signature evidence stays pending.

**Users do not need SOL.** Alchemy sponsors network fees and top-level associated token account rent and bills your Alchemy account. A missing policy or denied sponsorship blocks sending; there is no wallet-paid fallback. Configure eligibility and spending limits in your policy. This flow does not request CPI rent prefunding; it uses top-level ATA creation. See [Alchemy's Solana sponsorship contract](https://www.alchemy.com/docs/wallets/transactions/solana/sponsor-gas). USDC is the only transfer currency. UwiFin reads and transfers from the standard associated USDC token account. Other auxiliary token accounts are not aggregated. Only ordinary signing-wallet recipient addresses are supported. Deposit history records the net USDC credit per finalized transaction; it does not attribute a single sender to transactions with multiple instructions. A provider with historical transaction access is required for full history; unavailable historical receipts defer indexing.

## Local startup

Tested toolchain: Node 24.14.1, pnpm 10.34.5, Rust 1.90.0, MariaDB 11.4. Install locked dependencies with `pnpm install --frozen-lockfile`. Copy root `.env.example` to `.env` and `apps/web/.env.example` to `apps/web/.env.local`; set secrets in those ignored files or your secret manager. Start `docker compose up -d`, then `cargo run --manifest-path services/api/Cargo.toml`, then `pnpm dev:web --hostname 0.0.0.0`. In environments using mise, prefix Rust commands with `mise exec rust@1.90.0 --`.

The browser uses `/api/v1/networks/{network}/...`; existing `/api/v1/...` calls use the deployment default. Challenges and record lookups reject cross-network reuse. `/health` is process liveness. `/ready` checks MariaDB and required wallet configuration for the default network; it does not certify external provider availability. With no provider keys, registration/login work, and financial features show unavailable states.

## Privy activation

1. Create a Privy application and set `NEXT_PUBLIC_PRIVY_APP_ID` in `apps/web/.env.local` **before building**. Enable Custom Authentication with client-side JWT authentication and the `sub` identity claim. Enable automatic embedded Ethereum and Solana wallet creation. Allow your exact frontend origin (`http://localhost:3000` locally, your HTTPS origin in production).
2. Generate a server-only P-256 PKCS8 key outside the repository:

   ```sh
   mkdir -p "$HOME/.config/uwifin"
   chmod 700 "$HOME/.config/uwifin"
   openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$HOME/.config/uwifin/privy-jwt.pem"
   chmod 600 "$HOME/.config/uwifin/privy-jwt.pem"
   openssl pkey -in "$HOME/.config/uwifin/privy-jwt.pem" -pubout -out "$HOME/.config/uwifin/privy-jwt-public.pem"
   ```

3. Set `PRIVY_JWT_PRIVATE_KEY` in the frontend **server** environment to the private PEM with newlines escaped as `\n`; set `PRIVY_JWT_KEY_ID=uwifin-1`. Never use a `NEXT_PUBLIC_` variable for this key. Keep `APP_BASE_URL` equal to the frontend origin. Local loopback HTTP requires `APP_ENV=development`; deployment requires `APP_ENV=production` and HTTPS.
4. Configure Privy's verification key with the **public** key, or an internet-accessible HTTPS JWKS URL: `https://YOUR_APP/api/privy/jwks`. Privy cannot fetch a localhost JWKS endpoint; use the dashboard's public-key option for local development. The endpoint exposes only public EC coordinates and the key ID. Keep the key persistent across restarts and coordinate rotation with Privy.
5. Start MariaDB, the Rust API and the frontend as described in the README. Register an account: the wallet screen should prepare its address automatically. Log out and back in to confirm the same addresses. Switch between Base, Ethereum and Solana, and test an eligible sponsored USDC transfer on each configured network. Dashboard access and live provider keys are required to verify these operations.

Existing external/Alchemy email wallets remain in the database with their balances and addresses. Privy cannot recover their keys or move their funds automatically. Sending from those older wallets requires a separately planned migration using their original signer; the UI displays them as previous wallets and disables sending through Privy.

References: [Privy custom JWT setup](https://docs.privy.io/authentication/user-authentication/jwt-based-auth/setup), [React integration](https://docs.privy.io/authentication/user-authentication/jwt-based-auth/usage), [Alchemy with Privy](https://www.alchemy.com/docs/wallets/third-party/signers/privy).

## Alchemy activation

1. Enable Base, Ethereum and Solana mainnet RPC access in Alchemy. Enable Wallet APIs and Gas Manager for the EVM networks. Set the server-only `ALCHEMY_API_KEY`, or separate `BASE_ALCHEMY_API_KEY`, `ETHEREUM_ALCHEMY_API_KEY`, and `SOLANA_ALCHEMY_API_KEY`. Configure `BASE_POLICY_ID`, `ETHEREUM_POLICY_ID`, and `SOLANA_POLICY_ID` for their networks. Solana sponsorship uses Gas Manager through the Solana RPC endpoint; EVM smart accounts use the Wallet API endpoint.
2. Optional overrides are `BASE_RPC_URL`, `ETHEREUM_RPC_URL`, `SOLANA_RPC_URL`, `BASE_WALLET_URL`, and `ETHEREUM_WALLET_URL`. Use HTTPS. Legacy `ALCHEMY_RPC_URL`, `ALCHEMY_WALLET_URL`, and `ALCHEMY_POLICY_ID` apply only to the default network. Missing provider configuration disables that network's financial features. Never expose provider keys in browser environment variables.
3. Configure each EVM Gas Manager policy for its chain, the exact USDC contract, and selector `0xa9059cbb`. Configure the Solana policy for mainnet, USDC transfers and sponsored ATA rent. Set per-user limits, aggregate daily/monthly budgets, and alerts in Alchemy. The server amount cap is additional protection, not a replacement for provider budgets.
4. For EVM testing, explicitly select Base Sepolia and its policy; fund the smart account with test USDC; send a small amount to a second wallet. Verify the returned user operation and receipt against the explorer. Test rejection, sponsorship denial, provider interruption and retry before switching to Base.
5. For live operation, configure HTTPS `APP_BASE_URL`, HTTPS provider URLs, production database credentials, backups with restore drills, monitoring for stale submitted/pending rows, and protected API routing. Never deploy the compose development passwords.

The API currently uses in-memory rate limits and runs its reconciliation worker in-process. Run a single API instance. Apply edge rate limits before the BFF; the API peer-based auth limit sees the BFF as one peer. Configure timeouts above provider request duration. Do not trust client-supplied forwarding headers. Account recovery, email verification, and production security review remain release requirements. No funds were moved during local fixture tests.

## Stripe

Local test setup (requires an approved Stripe Crypto Onramp account):

1. Set `STRIPE_ONRAMP_ENABLED=true` and matching `STRIPE_SECRET_KEY=sk_test_...`, `STRIPE_PUBLISHABLE_KEY=pk_test_...`, and the endpoint's `STRIPE_WEBHOOK_SECRET=whsec_...` in the backend `.env`. Never put the secret or webhook key in browser environment variables.
2. Start MariaDB, the API and frontend using the README commands. Configure Alchemy for the destination network and complete wallet setup.
3. Forward `crypto.onramp_session_updated` events to the API's webhook URL using an HTTPS tunnel or `stripe listen --events crypto.onramp_session_updated --forward-to localhost:8080/api/v1/payments/stripe/webhook`. For CLI forwarding, use the signing secret printed by that listener and restart the API after changing it.
4. Open **Add money**, verify the displayed address/network and test mode, enter an amount, and continue to Stripe. Stripe controls eligibility, payment details and the final quote.
5. Finish the approved Stripe test flow. Check that history changes to `confirmed` only after a verified session response. Test-mode purchases do not deliver real mainnet USDC. Failed purchases can be restarted with a new idempotency key.

Configure approved Crypto Onramp access, matching test or live secret/publishable keys, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_ONRAMP_ENABLED=true`. Purchases are restricted to native USDC on the selected Base, Ethereum or Solana mainnet; test mode still requires Stripe eligibility and supported destination settings. Stripe renders the quote and payment UI. Its final source amount may differ from the initial requested amount; records are reconciled against the retrieved session.

Route Stripe directly to the Rust `POST /api/v1/payments/stripe/webhook` endpoint through your HTTPS ingress, preserving the raw body and `Stripe-Signature`. The browser BFF intentionally does not proxy this webhook. Subscribe to `crypto.onramp_session_updated`. Signature checks, mode checks, current-session retrieval, deduplication and locked-wallet validation protect updates. The same webhook URL handles every network using the saved payment destination. Solana addresses are compared case-sensitively. Browser events refresh history and balance but never mark payment complete. The checkout can be reloaded after a loading error; a new purchase is offered only after the API reports a terminal status. Ambiguous creation retries use the same Stripe key for at most 23 hours; older unresolved records require operational reconciliation.

Stripe Connect stablecoin payouts are fiat-platform-balance-to-crypto-wallet payouts. They are not a generic wallet-to-fiat off-ramp. PHP/GCash/bank cash-out is unavailable until an eligible payout provider and destination corridor are selected and integrated. Do not present this as working Stripe cash-out.

## Verification

- `pnpm --dir apps/web type-check`
- `pnpm --dir apps/web lint`
- `pnpm --dir apps/web test`
- `pnpm --dir apps/web build`
- `cargo test --manifest-path services/api/Cargo.toml`
- `cargo build --manifest-path services/api/Cargo.toml`
- With an **empty disposable** MariaDB database named `uwifin_test` and port 8080 free: `cd apps/web && node tests/provider-integration.mjs`. Override `TEST_DATABASE_URL` if needed. The test creates synthetic users/payments/wallets and runs a temporary API plus local provider transport fixtures, then stops them. Then run `node tests/multichain-integration.mjs` for Ethereum and Solana coverage. Reset the test database before repeating the full suite. Never point this test at production or the development preview database.

The integration fixture checks request/response contracts and our security boundaries. It does not replace Alchemy testnet or Stripe approved test-mode verification. The CodeRabbit emulate v0.0.1 catalog was inspected: it provides no Privy, Alchemy or Stripe Crypto Onramp service, so those operations cannot be certified using that emulator.

## MVP completion update

See [production operations](production.md) for admin bootstrap, CI, backups and provider activation. Privy embedded wallets replace the deprecated Alchemy email signer and external-wallet connection UI. Transaction history now pages on the server and includes verified deposits fetched through Alchemy's transfer API. Transaction details expose receipt gas metrics and the user-operation hash when the EntryPoint event is available. Settings supports password changes and revoking other sessions.
