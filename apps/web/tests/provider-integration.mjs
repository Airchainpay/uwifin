// Transport fixtures verify our boundaries; they do not certify provider compatibility.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createSmartWalletClient, alchemyWalletTransport } from '@alchemy/wallet-apis';
import { base } from 'viem/chains';
const origin = 'http://127.0.0.1:8080';
const fixtureOrigin = 'http://127.0.0.1:18545';
const address = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const token = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const txHash = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'cd'.repeat(32)}`;
const webhookSecret = 'whsec_synthetic_local_fixture_only';
const signer = privateKeyToAccount(`0x${'0'.repeat(63)}1`);
const wrongSigner = privateKeyToAccount(`0x${'0'.repeat(63)}2`);
let submitted = 0,
  accountRequests = 0,
  stripeCreates = 0,
  settles = false,
  receiptFailed = false;
let providerSession;
let operationSuccess = true,
  operationNonce = 0n,
  omitOperation = false,
  wrongEntryPoint = false;
let canonicalHash = blockHash,
  tip = '0x66',
  includeTransfer = true;
const prepared = {
  type: 'user-operation-v070',
  chainId: '0x2105',
  data: { sender: address, nonce: '0x0', callData: '0x1234', paymaster: recipient },
  signatureRequest: { type: 'personal_sign', data: { raw: `0x${'ab'.repeat(32)}` } },
  feePayment: { sponsored: true },
};
let depositsReady = false;
const depositHash = '0x' + 'd'.repeat(64);
const operationHash = '0x' + 'e'.repeat(64);
const fixture = createServer(async (req, res) => {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    let result;
    if (req.url.startsWith('/v1/crypto/onramp_sessions')) {
      if (req.method === 'POST') {
        stripeCreates++;
        const form = new URLSearchParams(body);
        assert.equal(form.get('destination_networks[]'), 'base');
        assert.equal(form.get('destination_currencies[]'), 'usdc');
        assert.equal(form.get('lock_wallet_address'), 'true');
        assert.equal(form.get('wallet_addresses[base]'), address);
        assert.ok(req.headers['idempotency-key']);
        providerSession = {
          id: 'cos_fixture',
          object: 'crypto.onramp_session',
          livemode: false,
          client_secret: 'cos_fixture_secret_local',
          status: 'initialized',
          metadata: {
            uwifin_payment_id: form.get('metadata[uwifin_payment_id]'),
            uwifin_user_id: form.get('metadata[uwifin_user_id]'),
          },
          transaction_details: {
            destination_currency: 'usdc',
            destination_network: 'base',
            lock_wallet_address: true,
            wallet_address: address,
            source_currency: 'usd',
            source_amount: '0',
            destination_amount: '0',
          },
        };
      }
      result = providerSession;
    } else {
      const rpc = JSON.parse(body);
      switch (rpc.method) {
        case 'alchemy_getAssetTransfers':
          result = {
            transfers: depositsReady
              ? [
                  {
                    hash: depositHash,
                    from: recipient,
                    to: address,
                    uniqueId: depositHash + ':log:0',
                    rawContract: { address: token, value: '0xf4240' },
                  },
                ]
              : [],
          };
          break;
        case 'eth_chainId':
          result = '0x2105';
          break;
        case 'eth_call':
          assert.equal(rpc.params[0].to, token);
          assert.match(rpc.params[0].data, /^0x70a08231/);
          result = `0x${1000000000n.toString(16)}`;
          break;
        case 'wallet_requestAccount':
          accountRequests++;
          assert.equal(rpc.params[0].signerAddress.toLowerCase(), signer.address.toLowerCase());
          assert.equal(rpc.params[0].creationHint.accountType, 'sma-b');
          assert.equal(rpc.params[0].creationHint.createAdditional, undefined);
          result = { accountAddress: address, id: 'fixture_account' };
          break;
        case 'wallet_prepareCalls':
          assert.equal(rpc.params[0].calls.length, 1);
          assert.equal(rpc.params[0].calls[0].to, token);
          assert.match(rpc.params[0].calls[0].data, /^0xa9059cbb/);
          assert.equal(rpc.params[0].capabilities.paymasterService.policyId, 'fixture_policy');
          result = prepared;
          break;
        case 'wallet_sendPreparedCalls':
          submitted++;
          assert.deepEqual(rpc.params[0].data, prepared.data);
          result = { id: `fixture_call_${submitted}` };
          break;
        case 'wallet_getCallsStatus':
          result = settles
            ? { status: 200, receipts: [{ transactionHash: txHash }] }
            : { status: 100 };
          break;
        case 'eth_getTransactionReceipt':
          if (rpc.params[0] === depositHash) {
            result = {
              transactionHash: depositHash,
              status: '0x1',
              blockNumber: '0x63',
              blockHash,
              logs: [
                {
                  address: token,
                  topics: [
                    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                    `0x${recipient.slice(2).padStart(64, '0')}`,
                    `0x${address.slice(2).padStart(64, '0')}`,
                  ],
                  data: '0xf4240',
                },
              ],
            };
            break;
          }
          result = {
            transactionHash: txHash,
            status: receiptFailed ? '0x0' : '0x1',
            blockNumber: '0x64',
            blockHash,
            gasUsed: '0x100',
            effectiveGasPrice: '0x1',
            logs: [
              {
                address: '0x0000000071727de22e5e9d8baf0edac6f37da032',
                topics: ['0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972'],
                data: '0x',
              },
              ...(includeTransfer
                ? [
                    {
                      address: token,
                      topics: [
                        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                        `0x${address.slice(2).padStart(64, '0')}`,
                        `0x${recipient.slice(2).padStart(64, '0')}`,
                      ],
                      data: `0x${1000001n.toString(16).padStart(64, '0')}`,
                    },
                  ]
                : []),
              ...(omitOperation
                ? []
                : [
                    {
                      address: wrongEntryPoint
                        ? recipient
                        : '0x0000000071727de22e5e9d8baf0edac6f37da032',
                      topics: [
                        '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f',
                        operationHash,
                        `0x${address.slice(2).padStart(64, '0')}`,
                        `0x${recipient.slice(2).padStart(64, '0')}`,
                      ],
                      data:
                        '0x' +
                        [operationNonce, operationSuccess ? 1n : 0n, 256n, 256n]
                          .map((value) => value.toString(16).padStart(64, '0'))
                          .join(''),
                    },
                  ]),
            ],
          };
          break;
        case 'eth_blockNumber':
          result = tip;
          break;
        case 'eth_getBlockByNumber':
          result = { hash: canonicalHash, timestamp: '0x68000000' };
          break;
        default:
          throw new Error(`Unexpected method: ${rpc.method}`);
      }
      result = { jsonrpc: '2.0', id: rpc.id, result };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(error) }));
  }
});
fixture.listen(18545, '127.0.0.1');
await once(fixture, 'listening');
const api = spawn('../../services/api/target/debug/uwifin-api', [], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    APP_ENV: 'development',
    DATABASE_URL:
      process.env.TEST_DATABASE_URL || 'mysql://uwifin:uwifin@127.0.0.1:3306/uwifin_test',
    ALCHEMY_NETWORK: 'base',
    ALCHEMY_RPC_URL: fixtureOrigin,
    ALCHEMY_WALLET_URL: fixtureOrigin,
    ALCHEMY_POLICY_ID: 'fixture_policy',
    STRIPE_API_URL: fixtureOrigin,
    STRIPE_SECRET_KEY: 'sk_test_synthetic',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_synthetic',
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_ONRAMP_ENABLED: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
api.stdout.on('data', (chunk) => {
  logs += chunk;
});
api.stderr.on('data', (chunk) => {
  logs += chunk;
});
async function request(path, { method = 'GET', token, body, key, headers = {} } = {}) {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (api.exitCode !== null) throw new Error(`API exited: ${logs}`);
    try {
      if ((await fetch(`${origin}/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  assert.equal((await request('/wallets')).status, 401);
  const register = async () => {
    const result = await request('/auth/register', {
      method: 'POST',
      body: {
        email: `${randomUUID()}@example.test`,
        password: 'synthetic-password-123',
        name: 'Fixture User',
      },
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.session_id;
  };
  const alice = await register(),
    bob = await register();
  const forbidden = await request('/admin/users', { token: alice });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.request_id, forbidden.headers.get('x-request-id'));
  assert.equal(
    (await request('/auth/register', { method: 'POST', body: {} })).body.error.code,
    'INVALID_REQUEST',
  );
  const aliceUser = (await request('/auth/me', { token: alice })).body;
  assert.match(aliceUser.id, /^[a-f0-9-]{36}$/);
  execFileSync('docker', [
    'exec',
    'uwifin-mariadb',
    'mariadb',
    '-uroot',
    '-prootpassword',
    'uwifin_test',
    '-e',
    `UPDATE users SET role = 'admin' WHERE id = '${aliceUser.id}'`,
  ]);
  assert.equal((await request('/admin/users', { token: alice })).status, 200);
  assert.equal((await request('/admin/users', { token: bob })).status, 403);
  assert.equal(
    (
      await request('/admin/networks/base', {
        method: 'PATCH',
        token: bob,
        body: { active: false },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/admin/networks/base', {
        method: 'PATCH',
        token: alice,
        body: { active: false },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('/payments', {
        method: 'POST',
        token: alice,
        key: randomUUID(),
        body: { wallet_id: 'none', amount: '1', currency: 'USD' },
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await request('/admin/networks/base', {
        method: 'PATCH',
        token: alice,
        body: { active: true },
      })
    ).status,
    200,
  );
  let challenge = await request('/wallets/challenge', {
    method: 'POST',
    token: alice,
    body: { signer_address: signer.address },
  });
  assert.equal(challenge.status, 200);
  const signature = await signer.signMessage({ message: challenge.body.message });
  assert.equal(
    (
      await request('/wallets', {
        method: 'POST',
        token: bob,
        body: { challenge_id: challenge.body.id, signature },
      })
    ).status,
    400,
  );
  const invalid = await wrongSigner.signMessage({ message: challenge.body.message });
  assert.equal(
    (
      await request('/wallets', {
        method: 'POST',
        token: alice,
        body: { challenge_id: challenge.body.id, signature: invalid },
      })
    ).status,
    403,
  );
  let wallet = await request('/wallets', {
    method: 'POST',
    token: alice,
    body: { challenge_id: challenge.body.id, signature },
  });
  assert.equal(wallet.status, 200, JSON.stringify(wallet.body));
  wallet = wallet.body;
  assert.equal(
    (
      await request('/wallets', {
        method: 'POST',
        token: alice,
        body: { challenge_id: challenge.body.id, signature },
      })
    ).status,
    400,
  );
  assert.equal((await request(`/wallets/${wallet.id}`, { token: bob })).status, 404);
  challenge = await request('/wallets/challenge', {
    method: 'POST',
    token: alice,
    body: { signer_address: signer.address },
  });
  const reconnected = await request('/wallets', {
    method: 'POST',
    token: alice,
    body: {
      challenge_id: challenge.body.id,
      signature: await signer.signMessage({ message: challenge.body.message }),
    },
  });
  assert.equal(reconnected.body.id, wallet.id);
  assert.equal(accountRequests, 1);
  assert.equal(
    (await request(`/wallets/${wallet.id}/balances`, { token: alice })).body[0].balance,
    '1000.000000',
  );
  const intentBody = {
    wallet_id: wallet.id,
    network: 'base',
    asset: 'USDC',
    recipient,
    amount: '1.000001',
  };
  assert.equal(
    (await request('/transactions', { method: 'POST', token: alice, body: intentBody })).status,
    400,
  );
  const key = randomUUID();
  const [first, retry] = await Promise.all(
    [1, 2].map(() =>
      request('/transactions', { method: 'POST', token: alice, body: intentBody, key }),
    ),
  );
  assert.equal(first.body.id, retry.body.id, JSON.stringify([first, retry]));
  assert.ok(first.body.id);
  assert.equal(
    (
      await request('/transactions', {
        method: 'POST',
        token: alice,
        body: { ...intentBody, amount: '2' },
        key,
      })
    ).status,
    409,
  );
  const id = first.body.id;
  assert.equal((await request(`/transactions/${id}`, { token: bob })).status, 404);
  const rpc = (method, params = [], token = alice) =>
    request(`/transactions/${id}/rpc`, { method: 'POST', token, body: { method, params } });
  assert.equal((await rpc('eth_sendTransaction')).status, 403);
  assert.equal((await rpc('wallet_prepareCalls', [], bob)).status, 404);
  const prepare = await rpc('wallet_prepareCalls');
  assert.equal(prepare.status, 200, JSON.stringify(prepare.body));
  // Exercise the actual Alchemy SDK signing action used by the frontend.
  const client = createSmartWalletClient({
    signer,
    account: address,
    chain: base,
    transport: alchemyWalletTransport({ url: fixtureOrigin }),
  });
  const signed = {
    type: prepared.type,
    chainId: prepared.chainId,
    data: prepared.data,
    signature: await client.signSignatureRequest(prepare.body.signatureRequest),
  };
  assert.equal(
    (
      await rpc('wallet_sendPreparedCalls', [
        { ...signed, data: { ...signed.data, nonce: '0xff' } },
      ])
    ).status,
    403,
  );
  const sent = await rpc('wallet_sendPreparedCalls', [signed]);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal((await rpc('wallet_sendPreparedCalls', [signed])).body.id, sent.body.id);
  assert.equal(submitted, 1);
  assert.equal((await request(`/transactions/${id}`, { token: alice })).body.status, 'pending');
  assert.equal((await rpc('wallet_getCallsStatus')).body.status, 100);
  settles = true;
  omitOperation = true;
  assert.equal(
    (await rpc('wallet_getCallsStatus')).body.status,
    100,
    'outer success without our operation stays pending',
  );
  omitOperation = false;
  operationNonce = 1n;
  assert.equal(
    (await rpc('wallet_getCallsStatus')).body.status,
    100,
    'another nonce cannot settle this intent',
  );
  operationNonce = 0n;
  wrongEntryPoint = true;
  assert.equal(
    (await rpc('wallet_getCallsStatus')).body.status,
    100,
    'another entrypoint cannot settle this intent',
  );
  wrongEntryPoint = false;
  tip = '0x64';
  assert.equal(
    (await rpc('wallet_getCallsStatus')).body.status,
    100,
    'wait for confirmation depth',
  );
  tip = '0x66';
  canonicalHash = '0x' + 'f'.repeat(64);
  assert.equal(
    (await rpc('wallet_getCallsStatus')).body.status,
    100,
    'noncanonical receipt stays pending',
  );
  canonicalHash = blockHash;
  assert.equal((await rpc('wallet_getCallsStatus')).body.status, 200);
  const confirmed = (await request(`/transactions/${id}`, { token: alice })).body;
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.tx_hash, txHash);
  const purchaseKey = randomUUID();
  const purchaseBody = { wallet_id: wallet.id, amount: '10.00', currency: 'USD' };
  let purchase = await request('/payments', {
    method: 'POST',
    token: alice,
    key: purchaseKey,
    body: purchaseBody,
  });
  assert.equal(purchase.status, 200, JSON.stringify(purchase.body));
  assert.equal(
    (
      await request('/payments', {
        method: 'POST',
        token: alice,
        key: purchaseKey,
        body: purchaseBody,
      })
    ).body.id,
    purchase.body.id,
  );
  assert.equal(stripeCreates, 1);
  const event = {
    id: 'evt_' + randomUUID(),
    type: 'crypto.onramp_session_updated',
    livemode: false,
    data: { object: { id: 'cos_fixture' } },
  };
  const webhook = async (body) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${JSON.stringify(body)}`)
      .digest('hex');
    return request('/payments/stripe/webhook', {
      method: 'POST',
      body,
      headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
    });
  };
  assert.equal(
    (await request('/payments/stripe/webhook', { method: 'POST', body: event })).status,
    400,
  );
  assert.equal((await webhook(event)).status, 200); // zero provisional amounts are allowed
  providerSession.status = 'fulfillment_complete';
  providerSession.transaction_details.source_amount = '10.00';
  providerSession.transaction_details.destination_amount = '9.500001';
  event.id = 'evt_' + randomUUID();
  assert.equal((await webhook(event)).status, 200);
  assert.equal((await webhook(event)).status, 200);
  const records = (await request('/payments', { token: alice })).body.payments;
  assert.equal(records[0].status, 'confirmed');
  assert.equal(records[0].crypto_amount_atomic, '9500001');
  assert.equal(records[0].fiat_amount_minor, '1000');
  assert.equal(records[0].request_fingerprint, undefined);
  assert.equal((await request('/payments', { token: bob })).body.payments.length, 0);
  assert.equal(
    (
      await request('/auth/password', {
        method: 'POST',
        token: alice,
        body: { current_password: 'wrong', new_password: 'a-new-synthetic-password' },
      })
    ).status,
    403,
  );
  const login = await request('/auth/login', {
    method: 'POST',
    body: { email: aliceUser.email, password: 'synthetic-password-123' },
  });
  assert.equal(login.status, 200);
  assert.equal(
    (
      await request('/auth/password', {
        method: 'POST',
        token: alice,
        body: {
          current_password: 'synthetic-password-123',
          new_password: 'a-new-synthetic-password',
        },
      })
    ).status,
    200,
  );
  assert.equal((await request('/auth/me', { token: login.body.session_id })).status, 401);
  assert.equal(
    (await request('/transactions?page=2&limit=1&kind=sent', { token: alice })).status,
    200,
  );
  assert.equal(confirmed.user_operation_hash, operationHash);
  const failing = await request('/transactions', {
    method: 'POST',
    token: alice,
    body: intentBody,
    key: randomUUID(),
  });
  const failingRpc = (method, params = []) =>
    request(`/transactions/${failing.body.id}/rpc`, {
      method: 'POST',
      token: alice,
      body: { method, params },
    });
  assert.equal((await failingRpc('wallet_prepareCalls')).status, 200);
  assert.equal((await failingRpc('wallet_sendPreparedCalls', [signed])).status, 200);
  operationSuccess = false; // A bundled receipt succeeds even when our operation reverts.
  assert.equal((await failingRpc('wallet_getCallsStatus')).body.status, 500);
  const failed = (await request(`/transactions/${failing.body.id}`, { token: alice })).body;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'TRANSACTION_FAILED');
  operationSuccess = true;
  const outerFailure = await request('/transactions', {
    method: 'POST',
    token: alice,
    body: intentBody,
    key: randomUUID(),
  });
  const outerRpc = (method, params = []) =>
    request(`/transactions/${outerFailure.body.id}/rpc`, {
      method: 'POST',
      token: alice,
      body: { method, params },
    });
  assert.equal((await outerRpc('wallet_prepareCalls')).status, 200);
  assert.equal((await outerRpc('wallet_sendPreparedCalls', [signed])).status, 200);
  receiptFailed = true;
  assert.equal((await outerRpc('wallet_getCallsStatus')).body.status, 500);
  receiptFailed = false;
  const missingTransfer = await request('/transactions', {
    method: 'POST',
    token: alice,
    body: intentBody,
    key: randomUUID(),
  });
  const missingRpc = (method, params = []) =>
    request(`/transactions/${missingTransfer.body.id}/rpc`, {
      method: 'POST',
      token: alice,
      body: { method, params },
    });
  assert.equal((await missingRpc('wallet_prepareCalls')).status, 200);
  assert.equal((await missingRpc('wallet_sendPreparedCalls', [signed])).status, 200);
  includeTransfer = false;
  assert.equal(
    (await missingRpc('wallet_getCallsStatus')).body.status,
    500,
    'successful operation without intended transfer fails',
  );
  includeTransfer = true;
  depositsReady = true;
  let deposits = [];
  for (let attempt = 0; attempt < 25; attempt++) {
    deposits = (await request('/transactions?kind=received', { token: alice })).body.transactions;
    if (deposits.length) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(deposits.length, 1, 'incoming deposits should be reconciled');
  assert.equal(deposits[0].amount_atomic, '1000000');
  assert.equal(deposits[0].tx_hash, depositHash);
  assert.equal(deposits[0].address, recipient);
  assert.equal(
    (await request('/transactions?kind=received', { token: bob })).body.transactions.length,
    0,
  );
  assert.equal(confirmed.gas_used, '256');
  assert.equal(confirmed.gas_price, '1');
  // Hold the user row while a login verifies the old password, then rotate the stored hash.
  const raceSession = await register();
  const raceUser = (await request('/auth/me', { token: raceSession })).body;
  const rotation = spawn(
    'docker',
    [
      'exec',
      '-i',
      'uwifin-mariadb',
      'mariadb',
      '--unbuffered',
      '-N',
      '-uroot',
      '-prootpassword',
      'uwifin_test',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  try {
    const locked = once(rotation.stdout, 'data');
    rotation.stdin.write(
      `START TRANSACTION; SELECT id FROM users WHERE id = '${raceUser.id}' FOR UPDATE;\n`,
    );
    await locked;
    const loginDuringRotation = request('/auth/login', {
      method: 'POST',
      body: { email: raceUser.email, password: 'synthetic-password-123' },
    });
    // Wait for issuance to reach its database lock; password hashing runs off-thread.
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const count = execFileSync(
        'docker',
        [
          'exec',
          'uwifin-mariadb',
          'mariadb',
          '-N',
          '-uroot',
          '-prootpassword',
          '-e',
          'SELECT COUNT(*) FROM information_schema.INNODB_LOCK_WAITS',
        ],
        { encoding: 'utf8' },
      ).trim();
      if (Number(count) > 0) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(waiting, 'login must serialize session issuance with the user row');
    const rotated = once(rotation, 'exit');
    rotation.stdin.end(
      `UPDATE users target JOIN users replacement ON replacement.id = '${aliceUser.id}' SET target.password_hash = replacement.password_hash WHERE target.id = '${raceUser.id}'; COMMIT;\n`,
    );
    assert.equal((await rotated)[0], 0);
    assert.equal(
      (await loginDuringRotation).status,
      401,
      'old password must not issue a session after rotation',
    );
  } finally {
    rotation.stdin.end();
    if (rotation.exitCode === null) rotation.kill();
  }
  assert.equal((await request('/auth/logout', { method: 'POST', token: alice })).status, 200);
  assert.equal((await request('/wallets', { token: alice })).status, 401);
  console.log(
    'PASS: MariaDB migrations, authentication/revocation, wallet ownership/replay/reconnect, cross-user isolation, exact balances, concurrent idempotency, SDK signing, tampered submissions, pending/confirmed receipt verification, Stripe creation, signature/dedup/amount reconciliation. Synthetic provider fixtures only.',
  );
} finally {
  api.kill('SIGINT');
  await Promise.race([once(api, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (api.exitCode === null) api.kill('SIGKILL');
  fixture.closeAllConnections();
  fixture.close();
}
