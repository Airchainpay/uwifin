# MVP operations

Run one Rust API instance and one Next.js web process, with MariaDB 11.4. Rate limits and reconciliation are in-process. Configure edge rate limiting before Next.js; never expose an unrestricted internal API origin to browsers. The default is now Base mainnet with real USDC; explicitly choose `ALCHEMY_NETWORK=base-sepolia` and a testnet policy for EVM testing. See [network activation](wallet-operations.md) for Base, Ethereum and Solana settings.

## Release

1. Run `.github/workflows/ci.yml` checks. Review dependency advisories and the financial flow code before real funds.
2. Install with `pnpm install --frozen-lockfile`; build with `pnpm build:web` and `cargo build --locked --release --manifest-path services/api/Cargo.toml` using Rust 1.90.0 and Node 24.14.1.
3. Supply environment secrets privately. Set `APP_ENV=production`, HTTPS `APP_BASE_URL`, production `DATABASE_URL`, Alchemy Wallet API/Gas Manager configuration, and eligible Stripe configuration. Never use development Compose passwords in production. Optional `NEXT_PUBLIC_ALCHEMY_SIGNER_KEY` is a separate browser key restricted to the application origin; enable **email OTP** in the Alchemy dashboard before the frontend build.
4. Back up MariaDB before deployment. API startup applies versioned migrations before listening. Start `services/api/target/release/uwifin-api`, then `pnpm --dir apps/web start --hostname 127.0.0.1`. Run processes under the host's service manager with restart-on-failure. Preserve environment secrets outside Git.
5. Put a managed HTTPS ingress in front. Forward the web entrypoint to Next.js and `/api/v1/payments/stripe/webhook` directly to Rust, preserving the raw body and Stripe signature. Set request timeout above 25 seconds. Only expose process health/readiness as needed by your monitor.
6. Verify `/health`, `/ready`, account flows, a sponsored Alchemy testnet transfer, and the approved Stripe test-mode flow. Alchemy Signer email delivery, account creation, recovery and signing must be tested with the approved origin. No local fixture substitutes for these provider checks.

The production hostname, TLS certificate, secret manager, Stripe approval, Alchemy policy and deployment monitoring account must be supplied by the operator. Repository code cannot certify these external settings. PHP payout is intentionally unavailable until a licensed, eligible partner is integrated.

## Administrator

Register a normal account, verify its owner operationally, then assign it using a privileged database console:

```sql
UPDATE users SET role = 'admin' WHERE id = '<verified-user-uuid>';
```

There is no public role-assignment endpoint. Sign in again to see Administration. It provides paginated users, payments, transfers, security events, operational exceptions, and supported asset/network switches. Only the configured USDC token can be enabled. Pauses block new transfer intents, preparation, user submission and purchases; already submitted operations continue reconciling. Changing a password signs out other sessions. Administrators cannot access signing keys or session tokens.

## Backups and recovery

Install the MariaDB client on the backup host. Store credentials in a mode-0600 client option file, and use a dedicated account with dump privileges. Keep backups on encrypted storage with a separate off-host copy and access restrictions.

Run daily using the host scheduler:

```sh
DB_CLIENT_CONFIG=/secure/backup.cnf BACKUP_DIR=/secure/backups DB_NAME=uwifin ./scripts/backup-db.sh
```

The script uses a consistent transactional dump, validates gzip integrity, atomically publishes it, and keeps 14 days of recovery points. Alert on nonzero exit and on backups older than 26 hours. Verify the scheduler and off-host replication in the deployed environment.

Run a restore drill at least monthly on a disposable database server:

```sh
DB_CLIENT_CONFIG=/secure/restore.cnf RESTORE_DATABASE=uwifin_restore_drill ./scripts/restore-check.sh /secure/backups/uwifin-TIMESTAMP.sql.gz
```

The script refuses ordinary production database names and refuses to overwrite an existing restore database. Compare row counts against the recorded backup baseline, then run a local application smoke check against the restored database before declaring recovery verified. Retain the result and delete the disposable database through the operator's normal process.

## Monitoring and recovery

- Monitor the external HTTPS entrypoint and `/health` every minute; `/ready` checks database/configuration, not provider eligibility.
- Alert on restart loops, sustained 5xx, missing daily backups, disk/database exhaustion and provider errors.
- Review Administration → errors for failed or submitted/pending transfers older than ten minutes. Review payment rows stuck in `creating`, `pending`, or `processing`. Check actual provider records before intervention.
- Never blindly reset a submitted transfer or recreate its nonce. Signed operations are durably retried with identical bytes. Ambiguous Stripe creations older than 23 hours need manual provider reconciliation.
- Structured API logs, error responses and audit events share a request ID. Background work has its own correlation scope.
- Deposits are fetched in small pages from Alchemy and checked against finalized canonical receipts. If history lags, inspect provider errors; balances remain independent live token reads. Failed page-token retries restart the bounded range and deduplicate persisted records.
- Test service restart, provider outage, denied sponsorship, webhook replay and failed transactions before enabling real funds. Measure latency and monthly availability; 99.5% is a target, not a certified result.

## SRS MVP v1.0 acceptance status

The repository contains the P0 identity, wallet, transfer, history, admin, and on-ramp surfaces. Local Rust tests and the MariaDB provider fixture exercise their application boundaries; they do not establish full MVP acceptance. The October 10 SRS pass corrected operation-specific settlement, a concurrent password-change/login race, deliberate repeat-transfer handling, and dashboard illustration overflow. No custom contract or new infrastructure was added. Historical remittance migrations remain intact to preserve database history; they do not enable a payout product.

Outstanding acceptance gates:

- Alchemy Base Sepolia wallet creation, real signed transfers, denied sponsorship, provider interruption, receipt verification, and email OTP must run with an approved application, origin and constrained Gas Manager policy.
- Stripe Crypto Onramp requires approved test-mode access and confirmation of the actual country/currency/Base USDC combination. The official webhook SDK requirement is unresolved for the Rust stack; see [dependency decisions](dependencies.md#stripe-sdk-requirement-discrepancy).
- The Rust advisory scan still fails for transitive `rsa` 0.9.10 (RUSTSEC-2023-0071, no patched version listed). SQLx uses public-key encryption in its database authentication path; this does not convert the scan into a pass. Preserve TLS/trusted database requirements and review upstream remediation before release.
- HTTPS ingress, secret management, deployed monitoring, daily backup scheduling/off-host copies, and a restoration drill require an operator's environment. Repository scripts and local checks alone do not certify these controls or the availability target.
- PHP bank/e-wallet cash-out remains unavailable pending an eligible licensed payout partner.
