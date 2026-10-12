UwiFin --- Local Development Setup
This guide documents the local development setup for UwiFin on Kali
Linux running under WSL2 on Windows. It follows this order:
1. Prepare the repository and environment
2. Start MariaDB with Docker Compose
3. Run the Rust API
4. Run the Next.js web app
Prerequisites: Git, Docker Engine and Docker Compose, Node.js 24,
pnpm 10.34.5, Rust via rustup, and the Rust 1.90.0 toolchain.

1. Update the repository
Open a Kali terminal and run:
cd ~/uwifin
git fetch origin
git switch coderabbit/document-local-development-setup/79a13f51
git pull --ff-only origin coderabbit/document-local-development-setup/79a13f51
If that branch is not available in your checkout, confirm the branch
name with your project maintainer before proceeding.
2. Configure environment variables
Create or update the repository-root .env file:
APP_ENV=development
APP_BASE_URL=http://localhost:3000
DATABASE_URL=mysql://localhost:3306/uwifin
ALCHEMY_NETWORK=base-sepolia
STRIPE_ONRAMP_ENABLED=false
Create or update apps/web/.env.local:
API_URL=http://127.0.0.1:8080
APP_BASE_URL=http://localhost:3000
NEXT_PUBLIC_ALCHEMY_SIGNER_KEY=
Keep real secrets out of Git. Do not commit .env or .env.local files
containing credentials or private keys.
3. Install frontend dependencies
From the repository root:
cd ~/uwifin
pnpm --version
pnpm install --frozen-lockfile
The expected pnpm version is 10.34.5. The project expects Node.js
24.
If pnpm is not installed or the version is incorrect, install/activate
the project-required version using your preferred Node.js version
manager and Corepack/pnpm workflow, then retry.
4. Start MariaDB
Start the database service and wait for it to become healthy:
cd ~/uwifin
sudo docker compose up -d --wait --wait-timeout 120 mariadb
sudo docker compose ps
sudo is shown because Docker socket permissions may require it on a
fresh Kali/WSL setup. If your user has been configured for Docker
access, you can omit sudo.
If the database does not start, inspect its logs:
sudo docker compose logs --tail=100 mariadb
Optional: allow your user to run Docker without sudo
Docker group membership grants root-equivalent privileges. Only do this
if you understand and accept that security implication:
sudo usermod -aG docker "$USER"
Then close and reopen the Kali terminal (or log out and back in) before
testing docker ps.
5. Run the Rust API
Open a second Kali terminal and leave the database running. From the
repository root, run:
cd ~/uwifin
rustup toolchain install 1.90.0
cargo +1.90.0 run --locked --manifest-path services/api/Cargo.toml
Keep this terminal open while developing. On successful startup, the API
should report that it is listening on port 8080.
Check API health
Open a third terminal and run:
curl http://localhost:8080/health
Expected response:
{"status":"ok"}
A slow SQL statement warning during initial migrations may be non-fatal
if the API continues starting. If the API exits or the health check
fails, review the API terminal output first.
/ready may return HTTP 503 when optional wallet/financial provider
settings are not configured. For the basic local startup check, use
/health.

6. Run the Next.js web app
In another terminal:
cd ~/uwifin
pnpm dev:web
If dependencies have not yet been installed, run this first from the
repository root:
pnpm install --frozen-lockfile
Open the app in your Windows browser:
- Web app: http://localhost:3000
- Registration: http://localhost:3000/register
- API health: http://localhost:8080/health
Register with a password of at least 12 characters, as required by
the setup instructions.
7. Wallet and provider configuration
The app's local registration and login flow can be tested without
completing wallet-provider configuration. Wallet-related features may
require provider settings for the Base Sepolia network. Keep
NEXT_PUBLIC_ALCHEMY_SIGNER_KEY empty unless you have the appropriate
key and know how the project expects it to be configured.
Do not place private keys or secret credentials in public
NEXT_PUBLIC_* variables. Only values explicitly designed to be public
should use that prefix.
8. Troubleshooting
Docker permission denied
If you see a permission error for /var/run/docker.sock, use
sudo docker compose ... or configure Docker group membership as
described above.
API health check fails
1. Confirm MariaDB is running: sudo docker compose ps.
2. Check the API terminal for startup errors.
3. Confirm the API is listening on port 8080.
4. Retry curl http://localhost:8080/health.
Frontend command or dependency errors
Check the required versions:
node --version
pnpm --version
Use Node.js 24 and pnpm 10.34.5, then reinstall dependencies from the
repository root:
cd ~/uwifin
pnpm install --frozen-lockfile
pnpm dev:web
MariaDB startup problems
Inspect the service logs:
sudo docker compose logs --tail=100 mariadb
Kali package repository/key problems
If apt update fails with repository 404s or a missing Kali archive
signing key, check that /etc/apt/sources.list points to the current
Kali rolling repository and follow Kali's official archive-keyring
recovery instructions. Do not bypass signature verification or mark
repositories as trusted to work around a key error.
9. Stop the development environment
Stop each running development process with Ctrl+C in its terminal:
- Next.js web app
- Rust API
Then stop the Compose services:
cd ~/uwifin
sudo docker compose down
This stops containers but normally preserves named database volumes.
Do not add --volumes unless you intentionally want to delete the
database's persisted data.
Quick startup checklist
After the initial setup is complete, the usual startup sequence is:
1. Start MariaDB:
   sudo docker compose up -d --wait --wait-timeout 120 mariadb
2. Start the API:
   cargo +1.90.0 run --locked --manifest-path services/api/Cargo.toml
3. Start the web app in another terminal: pnpm dev:web
4. Check the API at http://localhost:8080/health and open
   http://localhost:3000.