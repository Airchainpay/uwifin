# Backend and database deployment

Step-by-step setup for the Rust API and MariaDB, locally and on Railway.
Commands below run from the repository root unless another directory is specified.

## Architecture and requirements

- Backend: `services/api`, Rust 1.90.0, binary `uwifin-api`.
- Database: MariaDB 11.4. Use MariaDB for the documented deployment; Railway's
  MySQL template is a different database and has not been validated here.
- Optional local frontend: Node 24.14.1 and pnpm 10.34.5.
- The API binds to **`0.0.0.0:8080`**. It currently does not read `PORT` or `HOST`.
- SQLx embeds `services/api/migrations` at build time and applies outstanding
  migrations before the API starts listening. No separate migration CLI is needed.
- Run **one API replica**: rate limits and reconciliation workers run in-process.

Browser requests go through the Next.js backend-for-frontend (BFF):

```text
Browser --HTTPS--> Next.js BFF --private HTTP--> Rust API --private TCP--> MariaDB
Stripe  --HTTPS--> restricted webhook ingress --> Rust API webhook route
```

## Part 1: Local deployment

### 1. Prepare the tools and environment

Install Git, Rust 1.90.0 (including Cargo), and Docker with Compose v2. Start Docker.
For the web app, also install the Node and pnpm versions above.

```bash
git clone https://github.com/oxylat/uwifin.git
cd uwifin
cp .env.example .env
```

If you already have a checkout, use it. Copy the environment example only if `.env`
does not exist, so you preserve existing settings. Keep `.env` out of Git.
The defaults are sufficient for starting the database and account API:

```dotenv
APP_ENV=development
APP_BASE_URL=http://localhost:3000
DATABASE_URL=mysql://uwifin:uwifin@localhost:3306/uwifin
ALCHEMY_NETWORK=base-sepolia
STRIPE_ONRAMP_ENABLED=false
```

For wallets, set `ALCHEMY_API_KEY` and `ALCHEMY_POLICY_ID` using
[wallet activation](wallet-operations.md#alchemy-activation). Start with test funds.
Missing provider configuration allows registration/login but leaves financial
features unavailable.

### 2. Start MariaDB

```bash
docker compose up -d --wait mariadb
docker compose ps
```

Wait for `uwifin-mariadb` to be healthy. Compose creates database `uwifin` and user
`uwifin`, exposes port `3306`, and persists data in the `mariadb_data` named volume.
These credentials are for local development only.

If startup fails, inspect:

```bash
docker compose logs --tail=100 mariadb
```

### 3. Start the backend

In a terminal at the repository root:

```bash
cargo run --locked --manifest-path services/api/Cargo.toml
```

The process loads root `.env`, connects to MariaDB, applies migrations, then listens
on port `8080`. Leave this terminal running. With mise, prefix the command with
`mise exec rust@1.90.0 --`.

For a local release build instead:

```bash
cargo build --locked --release --manifest-path services/api/Cargo.toml
./services/api/target/release/uwifin-api
```

### 4. Verify the backend and schema

In another terminal:

```bash
curl -fsS http://localhost:8080/health
curl -i http://localhost:8080/ready
curl -fsS http://localhost:8080/api/v1/capabilities
docker compose exec mariadb mariadb -uuwifin -p uwifin
```

Enter the local application database password at the prompt, then run:

```sql
SHOW TABLES;
SELECT version, description, success FROM _sqlx_migrations ORDER BY version;
EXIT;
```

Expected results:

- `/health`: HTTP 200, `{"status":"ok"}`.
- `/ready`: HTTP 200 when the database and wallet settings are present. HTTP 503
  with `database: true` and `wallet_configuration: false` is expected before
  configuring Alchemy. This endpoint does not verify provider access or Stripe approval.
- Migrations: all applied rows have `success = 1`.

### 5. Connect the local frontend (optional)

Copy the example only if `apps/web/.env.local` does not already exist:

```bash
cp apps/web/.env.example apps/web/.env.local
pnpm install --frozen-lockfile
pnpm dev:web
```

Use these server-side web settings:

```dotenv
API_URL=http://127.0.0.1:8080
APP_BASE_URL=http://localhost:3000
```

Open `http://localhost:3000` and verify registration, login and logout. Use this
same hostname consistently because the BFF checks request origins.

### 6. Stop and restart

Stop the API/web terminals with Ctrl+C, then:

```bash
docker compose down
```

This preserves database data. Restart with step 2, then step 3. **Adding `-v` to
`docker compose down` deletes the local database volume.**

## Part 2: Production backend and database on Railway

This procedure deploys a MariaDB image and a Docker-built Rust service. The
Dockerfile below is a file you create during setup; it is not currently supplied
in the repository. Railway dashboard labels may change.

### 1. Create the project and environment

1. Create a Railway project and a new production environment.
2. Use a separate staging environment and database for Base Sepolia testing.
3. Put the API, database and preferably the Next.js BFF in the **same environment**
   so they can communicate over Railway private networking.
4. Decide the public HTTPS web origin, for example `https://app.example.com`.
   This will be `APP_BASE_URL`, with no trailing slash or path.

Use a newly created environment with IPv4 private networking. Railway documents
that environments created after October 16, 2025 have IPv4 and IPv6 private DNS;
legacy environments have IPv6 only. The current API listens on IPv4. A legacy
IPv6-only environment needs a networking/bind-address change before this procedure
will work; create a new environment for this guide.

### 2. Deploy MariaDB with persistent storage

1. Add a service from Docker image **`mariadb:11.4`** and name it `mariadb`.
2. Attach a Railway volume mounted at **`/var/lib/mysql`** before the first deploy.
3. Add these service variables using Railway's private variable editor:

   | Variable                | Value                                      |
   | ----------------------- | ------------------------------------------ |
   | `MARIADB_DATABASE`      | `uwifin`                                   |
   | `MARIADB_USER`          | `uwifin`                                   |
   | `MARIADB_PASSWORD`      | A unique generated application password    |
   | `MARIADB_ROOT_PASSWORD` | A different unique generated root password |

   Long random hexadecimal passwords avoid URL-encoding ambiguity later. Keep
   the root password separate; the API uses the application user.

4. Keep the image's default entrypoint/start command. Deploy and inspect logs for
   MariaDB's “ready for connections” message.
5. Record its private hostname from Networking (normally `mariadb.railway.internal`)
   and use port `3306`. Do not add a public TCP proxy for normal application traffic.
6. Keep one database replica. A volume is persistent storage; also configure backups
   in step 7.

The image initializes users/passwords only when its data directory is empty.
Changing `MARIADB_PASSWORD` later does **not** rotate an existing database user's
password. Rotate it through SQL, update the API variable, and redeploy the API.
Never delete the volume to fix a password mismatch in production.

### 3. Prepare the API Docker build

Create `services/api/Dockerfile` with:

```dockerfile
FROM rust:1.90.0-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
RUN cargo build --locked --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/uwifin-api /usr/local/bin/uwifin-api
USER 10001:10001
EXPOSE 8080
CMD ["/usr/local/bin/uwifin-api"]
```

Commit this file to your deployment branch and push it to GitHub. The explicit
copies include migrations without copying `.env` or local build output. There is
no build-time database connection requirement.

In Railway:

1. Add a service from the GitHub repository and name it `api`.
2. Select the branch containing the Dockerfile.
3. Set **Root Directory** to `/services/api`. Railway should detect the Dockerfile
   in that directory. Verify the build logs use this Dockerfile, not the root Node workspace.
4. Use the Dockerfile's build and start commands; clear conflicting custom commands.
5. Set replicas to **1**, disable sleeping/serverless behavior, and configure restart
   on failure. The reconciliation worker must keep running.
6. Set `PORT=8080` so Railway health checks target the actual listener. Changing this
   variable alone cannot change the Rust bind port.
7. Configure health check path `/health`. Allow enough startup time for initial migrations.
   Monitor `/ready` separately; use it as a deployment gate only after wallet settings exist.
8. Keep the API private. Record its private hostname for the BFF.

Avoid overlapping old/new API processes during updates because both would run
reconciliation workers. Configure deployment overlap/draining accordingly; if your
Railway settings cannot guarantee this, use a maintenance window to stop the old
API before starting its replacement. Expect brief downtime.

### 4. Set API variables and deploy

Set these on **`api`**, not on the browser frontend:

| Variable                | Production value                                                         |
| ----------------------- | ------------------------------------------------------------------------ |
| `APP_ENV`               | `production`                                                             |
| `APP_BASE_URL`          | Your public web origin, e.g. `https://app.example.com`                   |
| `DATABASE_URL`          | See below                                                                |
| `PORT`                  | `8080`                                                                   |
| `ALCHEMY_NETWORK`       | `base-sepolia` for initial verification; `base` only after release gates |
| `ALCHEMY_API_KEY`       | Server-side Alchemy key with RPC and Wallet API access                   |
| `ALCHEMY_POLICY_ID`     | Restricted Gas Manager policy ID                                         |
| `BLOCK_CONFIRMATIONS`   | `3` (valid range 1–100)                                                  |
| `MAX_TRANSFER_ATOMIC`   | `1000000000` (1,000 USDC at six decimals; choose your approved cap)      |
| `STRIPE_ONRAMP_ENABLED` | `false` until approved and verified                                      |

For a service named `mariadb` and a URL-safe password, Railway reference syntax is:

```dotenv
DATABASE_URL=mysql://${{mariadb.MARIADB_USER}}:${{mariadb.MARIADB_PASSWORD}}@${{mariadb.RAILWAY_PRIVATE_DOMAIN}}:3306/${{mariadb.MARIADB_DATABASE}}
```

Enter this in Railway's variable editor, not your local shell. Use the actual service
name if different. For passwords containing reserved URL characters, percent-encode
the username/password components and store the resulting URL privately; variable
references do not encode them automatically. Keep traffic on the trusted private
network. For an external database, require verified TLS according to its provider's
SQLx-compatible connection settings; do not send credentials over public plaintext TCP.

Optional `ALCHEMY_RPC_URL` and `ALCHEMY_WALLET_URL` must use HTTPS in production.
Leave `STRIPE_API_URL` unset to use the official endpoint.

Deploy after MariaDB is ready. Inspect API logs for successful startup; database
connection or migration errors prevent listening. Do not edit previously applied
migration files: SQLx validates their checksums.

### 5. Connect the frontend and HTTPS ingress

For a Next.js service in the same Railway environment, set:

```dotenv
API_URL=http://api.railway.internal:8080
APP_BASE_URL=https://app.example.com
```

Replace the hostname with the API's actual private hostname. `API_URL` is server-only;
do not name it `NEXT_PUBLIC_API_URL`. Set `APP_BASE_URL` identically on the API and
web service. Serve the web app over HTTPS and apply edge rate limiting before it.
Ingress timeouts should exceed the BFF's 25-second upstream timeout.

A frontend hosted outside Railway cannot resolve `*.railway.internal`. It needs
HTTPS ingress restricted to that frontend's server traffic, or the BFF must be
moved into Railway. A generated public API domain by itself does not restrict access;
do not expose all API routes unrestricted. The repository does not include this
restricted ingress configuration, so configure and verify it before using an
external BFF.

For automatic embedded wallets, configure Privy custom JWT authentication, set
`NEXT_PUBLIC_PRIVY_APP_ID` before building, and supply the server-only P-256
`PRIVY_JWT_PRIVATE_KEY`, `PRIVY_JWT_KEY_ID`, and `APP_ENV=production`.
See [Privy activation](wallet-operations.md#privy-activation).

### 6. Enable Stripe only when eligible

1. Obtain approved Stripe Crypto Onramp access and matching test/live keys.
2. Configure a public HTTPS ingress that forwards **only**
   `POST /api/v1/payments/stripe/webhook` to the private API on port `8080`, preserving
   the raw body and `Stripe-Signature`. Configure this ingress separately; the
   Next.js BFF deliberately does not proxy the webhook.
3. Register that HTTPS endpoint in Stripe for `crypto.onramp_session_updated`.
4. Set `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, and the endpoint's
   `STRIPE_WEBHOOK_SECRET` on the API.
5. Set `STRIPE_ONRAMP_ENABLED=true` only after verification. On-ramp requires
   `ALCHEMY_NETWORK=base`; Stripe test mode still requires approval and Base support.

Keep on-ramp disabled for the initial Base Sepolia deployment. See
[Stripe setup](wallet-operations.md#stripe) for eligibility and reconciliation rules.

### 7. Configure backups before accepting data

1. Configure Railway volume backups if available for your plan, including retention.
2. Schedule a daily logical dump using `scripts/backup-db.sh` from a trusted backup
   runner with the MariaDB client and access to the private database. A laptop cannot
   use Railway private DNS directly.
3. Store database client credentials in a mode-0600 option file and backups on encrypted
   persistent storage, with a separate off-host copy.
4. Follow [backup and restore instructions](production.md#backups-and-recovery),
   including a monthly restore drill with `scripts/restore-check.sh` on a disposable
   MariaDB server. Alert on failed jobs and backups older than 26 hours.

### 8. Verify the deployment

From a diagnostic shell in a service in the same Railway environment with `curl`
installed (the minimal API image above does not include it):

```bash
curl -fsS http://api.railway.internal:8080/health
curl -i http://api.railway.internal:8080/ready
curl -fsS http://api.railway.internal:8080/api/v1/capabilities
```

Then:

1. Check MariaDB tables and `_sqlx_migrations` using the SQL from local step 4 through
   a private database console/client.
2. Open the HTTPS frontend; verify registration, login, logout and session persistence.
3. Restart the API and verify accounts/data still exist and migrations remain successful.
4. Exercise a real sponsored Base Sepolia transfer and provider failure/retry behavior.
5. When eligible, verify approved Stripe test-mode delivery, signature validation and replay.
6. Run the repository CI checks and complete the outstanding
   [production acceptance gates](production.md#srs-mvp-v10-acceptance-status), including
   the recorded dependency advisory and Stripe SDK discrepancy, before real funds.

A passing health check confirms process liveness. Neither health endpoint certifies
financial provider eligibility or completion of the release gates.

### 9. Redeploy and recover

1. Take and verify a database backup before deploying changes with migrations.
2. Build/test the new commit in staging, including startup against representative schema/data.
3. Deploy one API instance during the planned maintenance window and repeat step 8.
4. If a deploy fails, inspect logs first. Railway can redeploy an earlier application
   image, but **application rollback does not undo database migrations**. Confirm schema
   compatibility before rolling back code.
5. If database recovery is required, stop writes, restore into a separate MariaDB instance,
   validate it, update `DATABASE_URL`, then restart the API. Reconcile provider records
   before resuming financial operations; restoring a database does not reverse payments.

## Troubleshooting

| Symptom                                        | Check / action                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local port 3306 or 8080 already in use         | Stop the conflicting local service. If changing the Compose host database port, also update local `DATABASE_URL`. The API listener is fixed at 8080.         |
| Database connection refused                    | Confirm MariaDB is ready, credentials/port match, and both Railway services are in the same environment. Private DNS works at runtime, not from your laptop. |
| Access denied after password change            | Update the existing database user through SQL; image initialization variables do not modify existing users.                                                  |
| Railway health check fails                     | Set `PORT=8080`, path `/health`, inspect startup/migration logs, and allow migration startup time.                                                           |
| Private API calls fail in an older environment | Check for IPv6-only private DNS; use a new IPv4-capable environment with the current IPv4 listener.                                                          |
| `/ready` returns 503                           | Inspect `database` and `wallet_configuration`; configure Alchemy endpoints/key and policy when the database is healthy.                                      |
| Frontend returns 503                           | Check server-side `API_URL`, private network access, and API logs.                                                                                           |
| Frontend POST returns 403                      | Match `APP_BASE_URL` exactly to the browser's HTTPS origin, with no trailing slash.                                                                          |
| Stripe webhook returns 404 through the web app | Route the webhook directly through the dedicated ingress to Rust. The BFF rejects that route.                                                                |
| Migration checksum mismatch                    | Restore the original migration file and add a new migration for changes; do not clear SQLx history.                                                          |

## References

- [Production operations and acceptance gates](production.md)
- [Wallet and provider configuration](wallet-operations.md)
- [Railway Dockerfiles](https://docs.railway.com/builds/dockerfiles)
- [Railway monorepos](https://docs.railway.com/guides/monorepo)
- [Railway variables](https://docs.railway.com/variables)
- [Railway volumes](https://docs.railway.com/volumes)
- [Railway private networking](https://docs.railway.com/networking/private-networking/how-it-works)
- [Railway health checks](https://docs.railway.com/deployments/healthchecks)
