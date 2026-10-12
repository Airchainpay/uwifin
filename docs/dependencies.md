# Dependency decisions

Exact JavaScript versions are pinned in apps/web/package.json and pnpm-lock.yaml; Rust resolutions are pinned in services/api/Cargo.lock. Install with locked resolution. Provider API compatibility must also be verified against an enabled account before release.

| Library                       | Tested version  | Purpose and choice                                          | Official source / alternative                                        | Security and license notes                                                               |
| ----------------------------- | --------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Next.js / React               | 16.4.0 / 19.3.0 | App Router, session BFF, UI                                 | vercel/next.js; facebook/react                                       | MIT; keep server-only secrets outside public variables                                   |
| viem                          | 2.56.5          | EIP-1193 wallet client, signing account and chain selection | wevm/viem; ethers is an alternative                                  | MIT; no custom private-key store                                                         |
| Alchemy wallet-apis           | 5.3.0           | Official Wallet API signature handling                      | alchemyplatform/aa-sdk; supersedes Account Kit v4 for this flow      | MIT; provider credentials stay server-side; fixed transfer intents                       |
| Stripe crypto                 | 1.1.3           | Official embedded Crypto Onramp loader                      | stripe/crypto-js; hosted flow is an alternative                      | MIT; requires approved provider access                                                   |
| Stripe.js                     | 1.54.2          | Satisfies crypto package's declared ^1.46.0 peer            | stripe/stripe-js                                                     | MIT; pinned to compatible peer, not independent latest; runtime scripts load from Stripe |
| QRCode                        | 1.5.4           | Encode actual receive address                               | soldair/node-qrcode                                                  | MIT; no network calls                                                                    |
| Alloy primitives              | 0.8.26          | EIP-191 signature recovery                                  | alloy-rs/core                                                        | MIT/Apache-2.0; k256 feature; no custom cryptography                                     |
| Axum / Tokio / SQLx / Reqwest | Cargo.lock      | One HTTP API, MariaDB persistence, provider HTTP            | tokio-rs/axum; tokio-rs/tokio; launchbadge/sqlx; seanmonstar/reqwest | Use lockfile; runtime SQL tests cover migrations and queries                             |
| Argon2 / HMAC / SHA2          | Cargo.lock      | Password hashes, webhook signatures, session hashes         | RustCrypto                                                           | Standard library implementations; never log keys or tokens                               |

Official provider docs and installed SDK source were inspected for request/response shapes and signing behavior. `pnpm audit --prod --json` reported zero known advisories in this sandbox on 2026-10-08. This is a point-in-time registry result, not a security certification. A Rust advisory scan and independent security review remain production gates. No custom Solidity contract is needed for direct USDC transfers.

## Automatic embedded wallets

`@privy-io/react-auth` **3.48.1** replaces the deprecated `@account-kit/signer`. Privy custom JWT authentication preserves UwiFin's email/password login and provisions embedded EVM/Solana signers. `jose` **6.2.12** signs five-minute ES256 tokens and exposes a public JWKS. Private wallet keys are not stored by the API. Browser loading is deferred through a client-only provider.

The direct viem dependency is **2.56.5**, matching Privy's declared version and satisfying Alchemy's peer range. Mixing it with 2.57.4 caused incompatible recursive account types. `@solana/kit` **8.4.0**, token **0.17.0**, system **0.15.0**, and memo **0.15.0** satisfy the Alchemy SDK's Solana peers. Validate live embedded signing with the configured Privy account before deployment.

The existing `js-cookie` 3.0.7 and `jayson` 5.0.0 overrides remain. Rerun the production audit for each release; older zero-advisory results do not cover this new dependency tree.

### Install warnings and package manager (2026-10-12)

The npm registry's `latest` tag for `@privy-io/react-auth` is **3.48.1**. Updating
Privy does not currently remove its obsolete transitive wallet connectors.
Its `x402@0.7.3` dependency declares `wagmi`, which pulls in the deprecated
MetaMask SDK, `@paulmillr/qr`, Safe gateway SDK, and WalletConnect 2.21.0/2.21.1.

The scoped override `"x402@0.7.3>wagmi": "-"` removes that unused dependency.
Privy's published JavaScript imports only `x402/client`; its declarations also
reference `x402/types`. Inspection of both the CommonJS and ESM distributions
found no wagmi imports in those entry points or their shared chunks. The wagmi
code belongs to x402's prebuilt paywall, which UwiFin does not use. This uses
[pnpm's documented removal of unused dependencies](https://pnpm.io/10.x/settings#overrides).
Keep the override restricted to the inspected x402 version, and recheck the
package graph when upgrading Privy/x402 or adding a paywall. Privy's own
WalletConnect 2.22.4 dependencies remain; the registry does not mark them deprecated.

`npm install` ignores `pnpm-lock.yaml` and `pnpm.overrides`, including the security
fixes below. Use **pnpm 10.34.5**. Root `devEngines` makes current npm reject the
wrong manager before dependency resolution; install lifecycle guards at the root
and web workspace provide a fallback for older npm. These guards are installation
guidance, not a security boundary (`--ignore-scripts` can bypass lifecycle checks).
See [cleanup instructions](../README.md#dependency-installation) after using npm.

### Remaining development-tool constraints

The full audit reports [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
in `braces@3.0.3`, reached through Next's ESLint plugin → fast-glob → micromatch.
The registry lists **3.0.3** as the latest braces release and reports no patched
version. Next's ESLint configuration **16.4.0** is also current. The affected
glob parser runs during linting; production dependency audits exclude this path.
The advisory is not suppressed, and a full audit remains a failing check.

ESLint **9.39.5** is deprecated upstream. ESLint **10.12.0** is current, but the
latest `eslint-plugin-react` **7.37.5** and `eslint-plugin-import` **2.32.0** still
declare peer support only through ESLint 9. Keep the compatible version until
those plugins support ESLint 10; do not force an unsupported major upgrade.

Version/deprecation and peer-range evidence was read from the published npm
metadata (`pnpm view <package>@latest version dependencies peerDependencies
deprecated --json`). New releases may change these constraints.

## Rust audit findings (2026-10-10)

`cargo audit` identifies RUSTSEC-2023-0071 in transitive `rsa` 0.9.10 via SQLx MySQL, with no patched release listed. Inspected SQLx 0.8.6 `connection/auth.rs` imports `RsaPublicKey` and uses public-key encryption for database authentication; UwiFin does not use RSA private-key decryption. This bounds the observed exposure but does not turn the advisory scan into a pass. Require a trusted/TLS database connection in production and monitor the upstream fix. `derivative` and `paste` also have transitive unmaintained notices. The direct unmaintained `dotenv` dependency was replaced with `dotenvy` 0.15.7 (MIT, dotenv-rs/dotenvy; already present through SQLx). These findings must remain visible in release review; no blanket audit suppression is added.

## Settlement verification (SRS MVP v1.0)

The receipt boundary reuses `alloy-primitives` **0.8.26** (`U256`, backed by locked `ruint` **1.20.1**), `hex` **0.4.3** and `serde_json` **1.0.151**. No new dependency is required. The installed sources verify `U256::from_str_radix(&str, u64)` and `U256::from_be_slice(&[u8])`; byte slices are bounded to one 32-byte word before conversion. Official references: [Alloy 0.8.26](https://docs.rs/alloy-primitives/0.8.26/alloy_primitives/), [hex 0.4.3](https://docs.rs/hex/0.4.3/hex/), [Serde JSON 1.0.151](https://docs.rs/serde_json/1.0.151/serde_json/).

EntryPoint event layout and execution ordering were checked against the tagged upstream [v0.7.0 interface](https://github.com/eth-infinitism/account-abstraction/blob/v0.7.0/contracts/interfaces/IEntryPoint.sol), [v0.7.0 implementation](https://github.com/eth-infinitism/account-abstraction/blob/v0.7.0/contracts/core/EntryPoint.sol), and [v0.6.0 interface](https://github.com/eth-infinitism/account-abstraction/blob/v0.6.0/contracts/interfaces/IEntryPoint.sol). `UserOperationEvent` indexes operation hash, sender and paymaster, and encodes nonce, success, actual gas cost and actual gas used. Receipt success alone is insufficient. Verification uses the prepared version, sender and full 256-bit nonce; token Transfer evidence must occur within that operation's execution logs. Canonical-block and confirmation-depth checks still apply. The stored gas fields describe the outer transaction, not an individual sponsored operation's bill.

The existing provider fixture exercises `@alchemy/wallet-apis` **5.3.0** `createSmartWalletClient` / `signSignatureRequest` with `viem` **2.56.5**. It does not prove provider account eligibility, real sponsorship, or Privy embedded signing. The Rust HTTP/database stack resolves to Axum **0.7.9**, Tokio **1.53.2**, SQLx **0.8.6**, and Reqwest **0.12.28** in Cargo.lock.

### Stripe SDK requirement discrepancy

[Stripe's official SDK catalog](https://docs.stripe.com/sdks), checked during this SRS implementation, lists Ruby, Python, Go, Java, Node, PHP and .NET server SDKs; it does not list an official Rust SDK. The existing Rust webhook boundary verifies raw-body HMAC-SHA256 using RustCrypto and tests timestamp tolerance, tampering and duplicate processing. This does **not** satisfy the master prompt's literal requirement to use an official Stripe webhook library. No unsupported Rust SDK has been substituted. The smallest architecture-preserving correction is an explicit exception permitting the tested documented signature protocol in Rust; otherwise the webhook boundary needs an approved official-SDK design. Treat this as an unresolved requirement, not a certification of the integration.

The SRS pass reran `pnpm audit --prod --json` (zero reported advisories) and `cargo audit --file services/api/Cargo.lock --json` (failed: RUSTSEC-2023-0071 in `rsa` 0.9.10; transitive unmaintained notices remain). SQLx 0.8.6's installed `connection/auth.rs` was inspected again: it imports `RsaPublicKey` and calls public-key `encrypt`, not RSA private-key decryption. No advisory suppression or unrelated upgrade was added. Password verification still uses Argon2 **0.5.3**, with default Argon2id parameters of 19 MiB memory, two iterations, and one lane, verified in the installed crate source ([official docs](https://docs.rs/argon2/0.5.3/argon2/)).

## Native USDC across mainnets

The Solana path uses `@solana/web3.js` 1.98.4 for wallet transaction interoperability and address derivation, plus `buffer` 6.0.3 for browser binary encoding. The test fixture uses `bs58` 6.0.0. Rust uses `solana-pubkey` 2.4.0, `solana-message` 2.4.0, `solana-instruction` 2.3.3 and `solana-hash` 2.3.0 (Anza Solana SDK components), `ed25519-dalek` 2.2.0 for strict signature verification and `bs58` 0.5.1. Versions resolve through the committed lockfiles. SDK instructions are independently decoded and signed in the JavaScript provider fixture, then verified by Rust. No private keys are stored by the API.

Alchemy documents EVM network availability in its [supported chains reference](https://www.alchemy.com/docs/wallets/supported-chains). Provider account eligibility and Gas Manager policies must still be checked with the deployment's own account. Solana uses standard RPC plus Alchemy's `alchemy_requestFeePayer` for required fee and rent sponsorship. Version-0 transactions preserve and validate both sponsor and owner signatures.

### Multichain dependency audit (2026-10-12)

`pnpm audit --prod --json` reports zero advisories for the updated JavaScript lockfile. `cargo audit --file services/api/Cargo.lock --json` still fails on the existing SQLx transitive `rsa` 0.9.10 advisory RUSTSEC-2023-0071 (no patched version). It also reports unmaintained notices for `derivative`, `paste`, and now `bincode` 1.3.3 (RUSTSEC-2025-0141), used by the Solana SDK's message serializer. These notices are retained without suppressions; the Rust audit is not a passing release gate.

### Privy dependency audit (2026-10-12)

The first production audit found seven advisory occurrences across `ws`, `uuid`, and `decode-uri-component` through Privy’s optional WalletConnect/x402 dependency paths. Scoped overrides use `ws` 8.21.0 for older 8.x resolutions, `uuid` 11.1.1 for affected 8–11.x resolutions, and `decode-uri-component` 0.5.0. UUID’s named v4/validate APIs and dual CommonJS/ESM exports remain available; the decoder retains its default function export. The frontend build and provider signing fixture passed with these resolutions. The subsequent `pnpm audit --prod --json` passed with zero advisories. Rust’s unchanged audit findings above remain unresolved.
