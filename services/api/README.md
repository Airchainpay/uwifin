# Rust API

UwiFin backend API built with Axum and Tokio.

## Development

```bash
cargo run
```

Server runs on `http://localhost:8080`

## Dependency compatibility

The API uses Rust edition 2024 and is verified with Rust 1.90.0, matching CI.
Authentication and webhook code uses Argon2 0.6.0 (password-hash 0.6.1), Rand
0.10.3, Base64 0.23.1, HMAC 0.13.0, and SHA2 0.11.0. Keep the committed
`Cargo.lock` when installing or checking the API. Run these commands from
`services/api`:

```bash
cargo check --locked
cargo fmt -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
```

Argon2's `hash_password` now generates its own random salt. Shared authentication
helpers handle password hashing and verification on the existing blocking workers.
Session tokens use Rand's fallible `SysRng` API, and HMAC initialization imports
`KeyInit`. Tests cover legacy password hashes, fresh salts, session token encoding,
and fixed SHA256/HMAC vectors. Update Rust source, `Cargo.toml`, and `Cargo.lock`
together when pulling this migration.

## Structure

- `src/main.rs` — entry point and routing
- `src/config.rs` — configuration from environment
- `src/state.rs` — shared application state
- `src/error.rs` — error types and responses
- `src/auth.rs`, `src/wallet.rs`, `src/transaction.rs`, `src/payments.rs` — HTTP handlers
- `src/db.rs` — database migrations and initialization

## Database

MariaDB is required. Start with:

```bash
docker compose up -d
```

Migrations run automatically on startup.
