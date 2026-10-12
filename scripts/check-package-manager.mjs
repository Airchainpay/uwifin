import { readFileSync } from 'node:fs';

const { packageManager } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const actual = process.env.npm_config_user_agent?.split(' ')[0];
const expected = packageManager.replace('@', '/');

if (actual !== expected) {
  console.error(
    `Use ${packageManager} for this workspace. Other package managers ignore pnpm-lock.yaml and the security overrides.\n` +
      'From the repository root, run: pnpm install --frozen-lockfile\n' +
      'If pnpm is unavailable or npm was already used, follow the setup and cleanup steps in README.md.',
  );
  process.exit(1);
}
