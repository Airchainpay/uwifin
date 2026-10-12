import { createHmac } from 'node:crypto';
// Synthetic RPC fixtures: no provider credentials or real blockchain broadcasts.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createPrivateKey, createPublicKey, sign, verify, randomUUID } from 'node:crypto';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { privateKeyToAccount } from 'viem/accounts';
import {
  transferTransaction,
  validateSponsoredTransaction,
} from '../src/lib/solana-transactions.ts';
const origin = 'http://127.0.0.1:8080';
const rpcOrigin = 'http://127.0.0.1:18545';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const solSigner = Keypair.fromSeed(new Uint8Array(32).fill(1));
const sponsor = Keypair.fromSeed(new Uint8Array(32).fill(4));
let sponsorshipMode = 'approve',
  blockhashValid = true;
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
const owner = solSigner.publicKey.toBase58();
const signingKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(solSigner.secretKey.slice(0, 32)),
  ]),
  format: 'der',
  type: 'pkcs8',
});
const evmSigner = privateKeyToAccount(`0x${'0'.repeat(63)}1`);
const evmAddress = `0x${'1'.repeat(40)}`;
const ethUsdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
let genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
let height = 100,
  nonce = 3,
  settle = false,
  chainFailure = false,
  ambiguous = false,
  deposits = false;
const sent = new Map();
const broadcasts = [];
const fixtureErrors = [];
const depositSignature = bs58.encode(new Uint8Array(64).fill(9));
const account = transferTransaction(
  owner,
  recipient,
  1n,
  new PublicKey(new Uint8Array(32).fill(3)).toBase58(),
).instructions[1].keys[0].pubkey.toBase58();
const balanceEntry = (amount) => ({
  accountIndex: 1,
  mint,
  owner,
  programId: tokenProgram,
  uiTokenAmount: { amount, decimals: 6 },
});
const onrampSessions = new Map();
const webhookSecret = 'whsec_multichain_synthetic_fixture';
let stripeCreates = 0;
const fixture = createServer(async (req, res) => {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url.startsWith('/v1/crypto/onramp_sessions')) {
      let session;
      if (req.method === 'POST') {
        const form = new URLSearchParams(body);
        const network = form.get('destination_network');
        assert.ok(['ethereum', 'solana'].includes(network));
        assert.deepEqual(form.getAll('destination_networks[]'), [network]);
        assert.deepEqual(form.getAll('destination_currencies[]'), ['usdc']);
        assert.equal(form.get('destination_currency'), 'usdc');
        assert.equal(form.get('lock_wallet_address'), 'true');
        const address = network === 'solana' ? owner : evmAddress;
        assert.equal(form.get(`wallet_addresses[${network}]`), address);
        const id = `cos_multi_${++stripeCreates}`;
        session = {
          id,
          object: 'crypto.onramp_session',
          livemode: false,
          client_secret: `${id}_secret_fixture`,
          status: 'initialized',
          metadata: {
            uwifin_payment_id: form.get('metadata[uwifin_payment_id]'),
            uwifin_user_id: form.get('metadata[uwifin_user_id]'),
          },
          transaction_details: {
            destination_network: network,
            destination_currency: 'usdc',
            lock_wallet_address: true,
            wallet_addresses: { [network]: address },
            source_currency: 'usd',
            source_amount: '10.00',
            destination_amount: '9.50',
          },
        };
        onrampSessions.set(id, session);
      } else session = onrampSessions.get(req.url.split('/').pop());
      assert.ok(session);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(session));
      return;
    }
    const { method, params } = JSON.parse(body);
    let result;
    if (req.url === '/eth' || req.url === '/base') {
      const eth = req.url === '/eth';
      switch (method) {
        case 'eth_chainId':
          result = eth ? '0x1' : '0x2105';
          break;
        case 'eth_call':
          assert.equal(params[0].to, eth ? ethUsdc : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
          result = '0x5f5e100';
          break;
        case 'wallet_requestAccount':
          result = { accountAddress: evmAddress, id: 'fixture-evm' };
          break;
        case 'wallet_prepareCalls':
          assert.equal(params[0].chainId, eth ? '0x1' : '0x2105');
          assert.equal(
            params[0].calls[0].to,
            eth ? ethUsdc : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          );
          assert.equal(
            params[0].capabilities.paymasterService.policyId,
            eth ? 'eth-policy' : 'base-policy',
          );
          result = {
            type: 'user-operation-v070',
            chainId: params[0].chainId,
            data: { sender: evmAddress, nonce: '0x0', paymaster: `0x${'2'.repeat(40)}` },
            signatureRequest: { type: 'personal_sign', data: { raw: `0x${'ab'.repeat(32)}` } },
            feePayment: { sponsored: true },
          };
          break;
        case 'eth_blockNumber':
          result = '0x100';
          break;
        case 'alchemy_getAssetTransfers':
          result = { transfers: [] };
          break;
        default:
          throw new Error(`Unexpected EVM RPC ${method}`);
      }
    } else {
      assert.equal(req.url, '/sol');
      switch (method) {
        case 'getGenesisHash':
          result = genesis;
          break;
        case 'getAccountInfo':
          if (params[0] === recipient) {
            result = { value: null };
            break;
          }
          assert.equal(params[0], account);
          result = {
            value: {
              owner: tokenProgram,
              data: {
                parsed: {
                  info: { mint, owner, tokenAmount: { amount: '100000000', decimals: 6 } },
                },
              },
            },
          };
          break;
        case 'getLatestBlockhash':
          result = {
            value: {
              blockhash: new PublicKey(new Uint8Array(32).fill(nonce++)).toBase58(),
              lastValidBlockHeight: 150,
            },
          };
          break;
        case 'alchemy_requestFeePayer': {
          assert.equal(params[0].policyId, 'solana-policy');
          assert.equal(params[0].prefundRent, undefined);
          if (sponsorshipMode === 'deny') {
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                error: { code: -32000, message: 'Policy denied' },
              }),
            );
            return;
          }
          const unsigned = VersionedTransaction.deserialize(
            Buffer.from(params[0].serializedTransaction, 'base64'),
          );
          const decoded = TransactionMessage.decompile(unsigned.message);
          assert.notEqual(decoded.payerKey.toBase58(), owner);
          assert.equal(decoded.instructions[0].keys[0].pubkey.toBase58(), owner);
          if (sponsorshipMode !== 'owner-rent')
            decoded.instructions[0].keys[0].pubkey = sponsor.publicKey;
          const sponsored = new VersionedTransaction(
            new TransactionMessage({
              payerKey: sponsor.publicKey,
              recentBlockhash: decoded.recentBlockhash,
              instructions: decoded.instructions,
            }).compileToV0Message(),
          );
          sponsored.sign([sponsor]);
          result = {
            serializedTransaction: Buffer.from(sponsored.serialize()).toString('base64'),
            estimatedFeeLamports: 10000,
            estimatedRentLamports: 2039280,
            usesDurableNonce: false,
            lastValidBlockHeight: 150,
          };
          break;
        }
        case 'sendTransaction': {
          const tx = VersionedTransaction.deserialize(Buffer.from(params[0], 'base64'));
          const decoded = TransactionMessage.decompile(tx.message);
          assert.equal(tx.signatures.length, 2);
          for (let i = 0; i < 2; i++) {
            const key = createPublicKey({
              key: Buffer.concat([
                Buffer.from('302a300506032b6570032100', 'hex'),
                tx.message.staticAccountKeys[i].toBuffer(),
              ]),
              format: 'der',
              type: 'spki',
            });
            assert.equal(verify(null, tx.message.serialize(), key, tx.signatures[i]), true);
          }
          assert.equal(decoded.payerKey.toBase58(), sponsor.publicKey.toBase58());
          assert.equal(
            decoded.instructions[0].keys[0].pubkey.toBase58(),
            sponsor.publicKey.toBase58(),
          );
          assert.equal(decoded.instructions.length, 2);
          assert.equal(decoded.instructions[1].programId.toBase58(), tokenProgram);
          assert.equal(decoded.instructions[1].keys[1].pubkey.toBase58(), mint);
          assert.equal(decoded.instructions[1].data[9], 6);
          assert.equal(params[1].preflightCommitment, 'confirmed');
          result = bs58.encode(tx.signatures[0]);
          sent.set(result, params[0]);
          broadcasts.push(params[0]);
          if (ambiguous) {
            ambiguous = false;
            res.writeHead(503);
            res.end('{}');
            return;
          }
          break;
        }
        case 'getTransaction':
          if (params[0] === depositSignature) {
            result = {
              blockTime: 1780000000,
              transaction: {
                signatures: [depositSignature],
                message: { accountKeys: [{ pubkey: recipient }, { pubkey: account }] },
              },
              meta: {
                err: null,
                preTokenBalances: [balanceEntry('0')],
                postTokenBalances: [balanceEntry('1000000')],
              },
            };
          } else
            result =
              settle && sent.has(params[0])
                ? {
                    transaction: [sent.get(params[0]), 'base64'],
                    meta: {
                      err: chainFailure ? { InstructionError: [1, 'InsufficientFunds'] } : null,
                    },
                  }
                : null;
          break;
        case 'getBlockHeight':
          result = height;
          break;
        case 'isBlockhashValid':
          result = { value: blockhashValid };
          break;
        case 'getSignatureStatuses':
          result = { value: [null] };
          break;
        case 'getSignaturesForAddress':
          assert.equal(params[0], account);
          result =
            deposits && params[1].until !== depositSignature
              ? [{ signature: depositSignature, err: null }]
              : [];
          break;
        default:
          throw new Error(`Unexpected Solana RPC ${method}`);
      }
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  } catch (error) {
    fixtureErrors.push(String(error));
    res.writeHead(500);
    res.end('{}');
  }
});
fixture.listen(18545, '127.0.0.1');
await once(fixture, 'listening');
const api = spawn('../../services/api/target/debug/uwifin-api', [], {
  env: {
    ...process.env,
    APP_ENV: 'development',
    DATABASE_URL:
      process.env.TEST_DATABASE_URL || 'mysql://uwifin:uwifin@127.0.0.1:3306/uwifin_test',
    ALCHEMY_NETWORK: 'base',
    ALCHEMY_API_KEY: '',
    ALCHEMY_RPC_URL: `${rpcOrigin}/base`,
    ALCHEMY_WALLET_URL: `${rpcOrigin}/base`,
    BASE_RPC_URL: `${rpcOrigin}/base`,
    BASE_WALLET_URL: `${rpcOrigin}/base`,
    BASE_POLICY_ID: 'base-policy',
    ETHEREUM_RPC_URL: `${rpcOrigin}/eth`,
    ETHEREUM_WALLET_URL: `${rpcOrigin}/eth`,
    ETHEREUM_POLICY_ID: 'eth-policy',
    SOLANA_RPC_URL: `${rpcOrigin}/sol`,
    SOLANA_POLICY_ID: 'solana-policy',
    STRIPE_ONRAMP_ENABLED: 'true',
    STRIPE_API_URL: rpcOrigin,
    STRIPE_SECRET_KEY: 'sk_test_multichain_fixture',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_multichain_fixture',
    STRIPE_WEBHOOK_SECRET: webhookSecret,
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
let token;
async function request(network, path, { body, key, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(`${origin}/api/v1${network ? `/networks/${network}` : ''}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}
const ok = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body;
};
const rpc = (id, method, params = []) =>
  request('solana-mainnet', `/transactions/${id}/rpc`, { body: { method, params } });
async function intent(wallet, amount = '1') {
  return ok(
    await request(wallet.network, '/transactions', {
      key: randomUUID(),
      body: {
        wallet_id: wallet.id,
        network: wallet.network,
        asset: 'USDC',
        recipient: wallet.network === 'solana-mainnet' ? recipient : `0x${'2'.repeat(40)}`,
        amount,
      },
    }),
    201,
  );
}
async function prepare(id) {
  const prepared = ok(await rpc(id, 'wallet_prepareCalls'));
  const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64'));
  assert.equal(prepared.sponsored, true);
  validateSponsoredTransaction(
    tx,
    owner,
    recipient,
    1000000n,
    sponsor.publicKey.toBase58(),
    prepared.blockhash,
  );
  const sponsorSignature = Buffer.from(tx.signatures[0]);
  tx.sign([solSigner]);
  assert.deepEqual(Buffer.from(tx.signatures[0]), sponsorSignature);
  return tx;
}

try {
  for (let i = 0; i < 80; i++) {
    if (api.exitCode !== null) throw new Error('API startup failed');
    if (
      await fetch(`${origin}/health`)
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const registration = ok(
    await request(null, '/auth/register', {
      body: {
        email: `multichain-${randomUUID()}@example.test`,
        password: 'Local_fixture_password_123!',
        name: 'Network fixture',
      },
    }),
    201,
  );
  token = registration.session_id;
  for (const [network, chain, contract] of [
    ['base', 8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
    ['eth-mainnet', 1, ethUsdc],
    ['solana-mainnet', 0, mint],
  ]) {
    const cap = ok(await request(network, '/capabilities'));
    assert.equal(cap.chain_id, chain);
    assert.equal(cap.usdc_address, contract);
    assert.equal(cap.transfers_enabled, true);
    assert.equal(cap.onramp_enabled, true);
  }
  assert.equal((await request('solana-devnet', '/capabilities')).status, 404);
  const challenge = ok(
    await request('solana-mainnet', '/wallets/challenge', { body: { signer_address: owner } }),
  );
  const signature = sign(null, Buffer.from(challenge.message), signingKey).toString('base64');
  const signed = { challenge_id: challenge.id, signature };
  assert.notEqual((await request('base', '/wallets', { body: signed })).status, 200);
  const solWallet = ok(await request('solana-mainnet', '/wallets', { body: signed }));
  assert.equal(solWallet.address, owner);
  assert.equal(solWallet.wallet_type, 'signing_account');
  assert.notEqual((await request('solana-mainnet', '/wallets', { body: signed })).status, 200);
  assert.equal((await request('base', `/wallets/${solWallet.id}`)).status, 404);
  const balances = ok(await request('solana-mainnet', `/wallets/${solWallet.id}/balances`));
  assert.equal(balances[0].balance, '100.000000');
  genesis = 'devnet';
  assert.equal(
    (await request('solana-mainnet', `/wallets/${solWallet.id}/balances`)).body.error.code,
    'UNSUPPORTED_NETWORK',
  );
  genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  assert.equal(
    (
      await request('solana-mainnet', '/transactions', {
        key: randomUUID(),
        body: {
          wallet_id: solWallet.id,
          network: 'solana-mainnet',
          asset: 'SOL',
          recipient,
          amount: '1',
        },
      })
    ).body.error.code,
    'UNSUPPORTED_ASSET',
  );
  const ethChallenge = ok(
    await request('eth-mainnet', '/wallets/challenge', {
      body: { signer_address: evmSigner.address },
    }),
  );
  const ethWallet = ok(
    await request('eth-mainnet', '/wallets', {
      body: {
        challenge_id: ethChallenge.id,
        signature: await evmSigner.signMessage({ message: ethChallenge.message }),
      },
    }),
  );
  assert.equal(ethWallet.network, 'eth-mainnet');
  // One default-network webhook URL must settle purchases on either other network.
  for (const [wallet, stripeNetwork] of [
    [ethWallet, 'ethereum'],
    [solWallet, 'solana'],
  ]) {
    const key = randomUUID();
    const body = { wallet_id: wallet.id, amount: '10.00', currency: 'USD' };
    const purchase = ok(await request(wallet.network, '/payments', { body, key }));
    assert.equal(ok(await request(wallet.network, '/payments', { body, key })).id, purchase.id);
    const provider = [...onrampSessions.values()].find(
      (s) => s.metadata.uwifin_payment_id === purchase.id,
    );
    assert.ok(provider);
    provider.status = 'fulfillment_complete';
    const deliver = async () => {
      const event = JSON.stringify({
        id: `evt_${randomUUID()}`,
        type: 'crypto.onramp_session_updated',
        livemode: false,
        data: { object: { id: provider.id } },
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac('sha256', webhookSecret)
        .update(`${timestamp}.${event}`)
        .digest('hex');
      return fetch(`${origin}/api/v1/payments/stripe/webhook`, {
        method: 'POST',
        body: event,
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': `t=${timestamp},v1=${signature}`,
        },
      });
    };
    if (stripeNetwork === 'solana') {
      provider.transaction_details.wallet_addresses.solana = owner.toLowerCase();
      assert.equal((await deliver()).status, 400, 'Solana destinations must preserve case');
      provider.transaction_details.wallet_addresses.solana = owner;
    }
    assert.equal((await deliver()).status, 200);
    assert.equal((await deliver()).status, 200);
    const record = ok(await request(wallet.network, '/payments')).payments.find(
      (p) => p.id === purchase.id,
    );
    assert.equal(record.status, 'confirmed');
    assert.equal(record.crypto_amount_atomic, '9500000');
    assert.equal(
      ok(await request('base', '/payments')).payments.some((p) => p.id === purchase.id),
      false,
    );
  }
  assert.equal(stripeCreates, 2);

  const ethIntent = await intent(ethWallet);
  const ethPrepared = ok(
    await request('eth-mainnet', `/transactions/${ethIntent.id}/rpc`, {
      body: { method: 'wallet_prepareCalls', params: [] },
    }),
  );
  assert.equal(ethPrepared.chainId, '0x1');
  assert.equal((await request('base', `/transactions/${ethIntent.id}`)).status, 404);
  assert.equal(
    (
      await request('base', `/transactions/${ethIntent.id}/rpc`, {
        body: { method: 'wallet_prepareCalls', params: [] },
      })
    ).status,
    404,
  );
  const first = await intent(solWallet);
  sponsorshipMode = 'deny';
  assert.equal((await rpc(first.id, 'wallet_prepareCalls')).body.error.code, 'PROVIDER_REJECTED');
  assert.equal(broadcasts.length, 0);
  sponsorshipMode = 'owner-rent';
  assert.equal((await rpc(first.id, 'wallet_prepareCalls')).body.error.code, 'PROVIDER_REJECTED');
  sponsorshipMode = 'approve';
  const tx = await prepare(first.id);
  const tampered = VersionedTransaction.deserialize(tx.serialize());
  tampered.message.compiledInstructions[1].data[1] ^= 1;
  tampered.sign([solSigner]);
  assert.equal(
    (
      await rpc(first.id, 'wallet_sendPreparedCalls', [
        { transaction: Buffer.from(tampered.serialize()).toString('base64') },
      ])
    ).status,
    403,
  );
  ambiguous = true;
  assert.equal(
    (
      await rpc(first.id, 'wallet_sendPreparedCalls', [
        { transaction: Buffer.from(tx.serialize()).toString('base64') },
      ])
    ).status,
    503,
  );
  // Reconciliation retries identical bytes; no newly generated blockhash or signature.
  ok(await rpc(first.id, 'wallet_getCallsStatus'));
  assert.equal(broadcasts[0], broadcasts[1]);
  settle = true;
  assert.equal(ok(await rpc(first.id, 'wallet_getCallsStatus')).status, 200);
  assert.equal(
    ok(await request('solana-mainnet', `/transactions/${first.id}`)).status,
    'confirmed',
  );
  const failed = await intent(solWallet);
  const failedTx = await prepare(failed.id);
  ok(
    await rpc(failed.id, 'wallet_sendPreparedCalls', [
      { transaction: Buffer.from(failedTx.serialize()).toString('base64') },
    ]),
  );
  chainFailure = true;
  assert.equal(ok(await rpc(failed.id, 'wallet_getCallsStatus')).status, 500);
  chainFailure = false;
  settle = false;
  const expired = await intent(solWallet);
  const expiredTx = await prepare(expired.id);
  ok(
    await rpc(expired.id, 'wallet_sendPreparedCalls', [
      { transaction: Buffer.from(expiredTx.serialize()).toString('base64') },
    ]),
  );
  height = 151;
  assert.equal(ok(await rpc(expired.id, 'wallet_getCallsStatus')).status, 100);
  blockhashValid = false;
  assert.equal(ok(await rpc(expired.id, 'wallet_getCallsStatus')).status, 500);
  const ethHistory = ok(await request('eth-mainnet', '/transactions'));
  assert.ok(ethHistory.transactions.every((item) => item.network === 'eth-mainnet'));
  deposits = true;
  let incoming = [];
  for (let i = 0; i < 40; i++) {
    incoming = ok(await request('solana-mainnet', '/transactions')).transactions.filter(
      (item) => item.kind === 'received',
    );
    if (incoming.length) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].amount_atomic, '1000000');
  assert.equal(incoming[0].tx_hash, depositSignature);
  assert.deepEqual(fixtureErrors, []);
  console.log(
    'Multichain integration passed: network isolation, native USDC, Ed25519 ownership, SDK signing, tampering, sponsored fees/rent, denial, ambiguous retry, finality, failure, expiry and deposits.',
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  api.kill('SIGTERM');
  if (api.exitCode === null) await once(api, 'exit');
  await new Promise((resolve) => fixture.close(resolve));
}
