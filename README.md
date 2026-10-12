# UwiFin

UwiFin is a Web3-enabled financial application for simple cross-border transactions, with an MVP focused on secure wallets, account abstraction, fiat onboarding, and transaction tracking.

## Stack

- Frontend: Next.js + TypeScript
- Backend: Rust + Axum
- Database: MariaDB
- Blockchain: EVM with Alchemy
- Payments: Stripe

## Monorepo structure

- `apps/web` — Next.js web client
- `services/api` — Rust Axum API
- `packages/shared` — shared types and utilities
- `docs` — product and engineering docs

## Getting started

1. Install dependencies:
   - Node.js 20.9+
   - pnpm
   - Rust
   - Docker

2. Start the database:

   ```bash
   docker compose up -d
   ```

3. Install workspace dependencies:

   ```bash
   pnpm install
   ```

4. Run the web app:

   ```bash
   pnpm dev:web
   ```

5. Run the API:
   ```bash
   cargo run --manifest-path services/api/Cargo.toml
   ```

## Code formatting

Run `pnpm format` from the repository root to format supported web source, tests,
JSON/JSONC, CSS, YAML, Markdown, and the Rust API. Run `pnpm format:check` to check
formatting without writing files. Prettier is pinned in the root dev dependencies;
Rust uses `cargo fmt` (Rust 1.90.0, matching CI). With mise, use
`mise exec rust@1.90.0 -- pnpm format` or `mise exec rust@1.90.0 -- pnpm format:check`.

Prettier keeps the existing single quotes and semicolons, uses two-space indentation
and a 100-column target, and preserves import order. Rust uses rustfmt defaults.
`.gitignore` and `.prettierignore` exclude dependencies, generated files, build
output, environment files, font assets, lockfiles, and versioned SQL migrations.
SQL, shell scripts, TOML, and SVG assets have no configured formatter and are not
rewritten by these commands. Keep migration contents stable for checksum validation.

The existing lint, type-check, build, and test commands remain separate checks; see
[verification commands](docs/wallet-operations.md#verification).

## Notes

See [CI/CD](docs/ci-cd.md) for automated checks, weekly dependency updates,
required GitHub branch protections, and deployment status.

This repository intentionally keeps the initial architecture simple and production-minded, with no unnecessary service sprawl or custom blockchain infrastructure in the MVP.

## Real wallet setup

See [Wallet operation and activation](docs/wallet-operations.md) for environment configuration, signing, sponsorship, Stripe setup, verification commands, and current release requirements. Copy both environment examples before starting. The wallet uses real provider APIs; absent configuration is displayed as unavailable. Real Alchemy testnet and approved Stripe test-mode checks are required before live activation. Fiat cash-out requires a supported payout partner and is not currently enabled.

## USDC networks

Base mainnet is the default, with Ethereum mainnet and Solana mainnet available on the wallet page. Only native USDC is supported. Set per-network RPC credentials and gas sponsorship policies in `.env`; see [wallet and network setup](docs/wallet-operations.md). Privy creates embedded signing wallets automatically after signup/login; configure its custom JWT authentication using the linked guide. Solana requires an approved Alchemy policy covering fees and account rent; users do not need SOL. Selecting another network does not move funds between chains.
