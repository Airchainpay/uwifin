import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import {
  issueWalletToken,
  walletAuthJwks,
  WALLET_TOKEN_SECONDS,
} from '../src/lib/server/privy-auth.ts';
import { walletTokenResponse } from '../src/lib/server/privy-token.ts';
import {
  canSignWallet,
  matchesWalletIdentity,
  prepareEmbeddedWallet,
} from '../src/lib/embedded-wallet.ts';
import type { Wallet, Capabilities } from '../src/lib/api.ts';

const userId = '11111111-1111-4111-8111-111111111111';
function configure() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  process.env.PRIVY_JWT_PRIVATE_KEY = privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString()
    .replace(/\n/g, '\\n');
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = 'synthetic-test-app';
  process.env.PRIVY_JWT_KEY_ID = 'test-key';
  process.env.APP_BASE_URL = 'http://localhost:3000';
  process.env.APP_ENV = 'development';
  process.env.API_URL = 'http://127.0.0.1:8080';
}

test('wallet JWT verifies against public JWKS and expires in five minutes', async () => {
  configure();
  const result = await issueWalletToken(userId);
  const jwks = walletAuthJwks();
  assert.equal('d' in jwks.keys[0], false);
  const { payload, protectedHeader } = await jwtVerify(result.token, createLocalJWKSet(jwks), {
    audience: 'synthetic-test-app',
    issuer: 'http://localhost:3000',
    algorithms: ['ES256'],
  });
  assert.equal(payload.sub, userId);
  assert.equal(protectedHeader.kid, 'test-key');
  assert.equal(payload.exp! - payload.iat!, WALLET_TOKEN_SECONDS);
  assert.notEqual(
    payload.jti,
    (await jwtVerify((await issueWalletToken(userId)).token, createLocalJWKSet(jwks))).payload.jti,
  );
  await assert.rejects(
    jwtVerify(result.token, createLocalJWKSet(jwks), {
      currentDate: new Date((payload.exp! + 1) * 1000),
    }),
  );
  process.env.APP_ENV = 'production';
  assert.throws(walletAuthJwks);
  process.env.APP_BASE_URL = 'https://app.example.test';
  assert.equal(walletAuthJwks().keys.length, 1);
});

test('token bridge rejects missing session, foreign origin, revoked session and ignores caller subject', async () => {
  configure();
  const originalFetch = globalThis.fetch;
  const request = (origin = 'http://localhost:3000') =>
    new Request('http://localhost:3000/api/privy/token', {
      method: 'POST',
      headers: { origin },
      body: JSON.stringify({ user_id: 'attacker' }),
    });
  let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:8080/api/v1/auth/me');
      assert.equal(
        (options?.headers as Record<string, string>).Authorization,
        'Bearer synthetic-session',
      );
      assert.equal(options?.redirect, 'error');
      return Response.json({ id: userId });
    };
    assert.equal((await walletTokenResponse(request(), undefined)).status, 401);
    assert.equal(
      (await walletTokenResponse(request('https://evil.example'), 'synthetic-session')).status,
      403,
    );
    assert.equal(calls, 0);
    const response = await walletTokenResponse(request(), 'synthetic-session');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.user_id, userId);
    assert.equal(
      (await jwtVerify(result.token, createLocalJWKSet(walletAuthJwks()))).payload.sub,
      userId,
    );
    globalThis.fetch = async () => Response.json({}, { status: 401 });
    assert.equal((await walletTokenResponse(request(), 'synthetic-session')).status, 401);
    globalThis.fetch = async () => {
      throw new Error('secret infrastructure details');
    };
    const failed = await walletTokenResponse(request(), 'synthetic-session');
    assert.equal(failed.status, 503);
    assert.equal((await failed.text()).includes('secret'), false);
    process.env.APP_BASE_URL = 'malformed';
    assert.equal((await walletTokenResponse(request(), 'synthetic-session')).status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('restored signers require the current custom-auth identity and exact Solana case', () => {
  assert.equal(
    matchesWalletIdentity([{ type: 'custom_auth', customUserId: userId }], userId),
    true,
  );
  assert.equal(
    matchesWalletIdentity([{ type: 'custom_auth', customUserId: 'previous-user' }], userId),
    false,
  );
  assert.equal(matchesWalletIdentity([{ type: 'email' }], userId), false);
  const wallet = { network: 'solana-mainnet', signer_address: 'AbC' } as Wallet;
  const signers = {
    evm: null,
    solana: {
      address: 'AbC',
      signMessage: async (m: Uint8Array) => m,
      signTransaction: async (m: Uint8Array) => m,
    },
  };
  assert.equal(canSignWallet(wallet, signers), true);
  assert.equal(canSignWallet({ ...wallet, signer_address: 'abc' }, signers), false);
  assert.equal(canSignWallet(wallet, { evm: null, solana: null }), false);
});

test('automatic setup provisions the selected network, reuses its wallet, and can retry failures', async () => {
  const config = {
    network: 'solana-mainnet',
    family: 'solana',
    wallet_enabled: true,
  } as Capabilities;
  const wallet = { id: 'current-wallet', network: config.network, signer_address: 'AbC' } as Wallet;
  const signers = {
    evm: null,
    solana: {
      address: 'AbC',
      signMessage: async (m: Uint8Array) => m,
      signTransaction: async (m: Uint8Array) => m,
    },
  };
  let calls = 0;
  const provision = async () => {
    calls++;
    return wallet;
  };
  assert.equal(await prepareEmbeddedWallet(config, [], signers, provision), wallet);
  assert.equal(calls, 1);
  assert.equal(await prepareEmbeddedWallet(config, [wallet], signers, provision), wallet);
  assert.equal(calls, 1);
  assert.equal(
    await prepareEmbeddedWallet(config, [], { evm: null, solana: null }, provision),
    null,
  );
  assert.equal(
    await prepareEmbeddedWallet({ ...config, wallet_enabled: false }, [], signers, provision),
    null,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    prepareEmbeddedWallet(config, [], signers, async () => {
      throw new Error('offline');
    }),
    /offline/,
  );
  assert.equal(await prepareEmbeddedWallet(config, [], signers, provision), wallet);
  await assert.rejects(
    prepareEmbeddedWallet(config, [], signers, async () => ({ ...wallet, network: 'base' })),
    /verified/,
  );
  await assert.rejects(
    prepareEmbeddedWallet(config, [], signers, async () => ({
      ...wallet,
      signer_address: 'another-user',
    })),
    /verified/,
  );
  const previous = { ...wallet, signer_address: 'old-signer' };
  assert.equal(await prepareEmbeddedWallet(config, [previous], signers, provision), wallet);
});
