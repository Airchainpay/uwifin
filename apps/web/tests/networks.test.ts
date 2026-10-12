import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { validateAddress } from '../src/lib/money.ts';
import { transactionUrl } from '../src/lib/networks.ts';
import {
  transferTransaction,
  validateSponsoredTransaction,
} from '../src/lib/solana-transactions.ts';
test('network-specific addresses and explorer links', () => {
  const owner = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey.toBase58();
  assert.equal(validateAddress(owner, 'solana-mainnet'), true);
  assert.equal(validateAddress(owner, 'base'), false);
  assert.equal(validateAddress('0x' + '1'.repeat(40), 'solana-mainnet'), false);
  assert.equal(validateAddress(PublicKey.default.toBase58(), 'solana-mainnet'), false);
  assert.equal(transactionUrl('base', 'hash'), 'https://basescan.org/tx/hash');
  assert.equal(transactionUrl('eth-mainnet', 'hash'), 'https://etherscan.io/tx/hash');
  assert.equal(transactionUrl('solana-mainnet', 'hash'), 'https://solscan.io/tx/hash');
  assert.equal(transactionUrl('unsupported', 'hash'), undefined);
});
test('Solana transfer encodes native USDC and exact six-decimal atomic amount', () => {
  const sender = Keypair.fromSeed(new Uint8Array(32).fill(1));
  const recipient = Keypair.fromSeed(new Uint8Array(32).fill(2));
  const tx = transferTransaction(
    sender.publicKey.toBase58(),
    recipient.publicKey.toBase58(),
    1234567n,
    new PublicKey(new Uint8Array(32).fill(3)).toBase58(),
  );
  assert.equal(tx.instructions.length, 2);
  assert.equal(tx.instructions[0].data.toString('hex'), '01');
  const transfer = tx.instructions[1];
  assert.equal(transfer.programId.toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  assert.equal(transfer.keys[1].pubkey.toBase58(), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(transfer.data[0], 12);
  assert.equal(transfer.data.readBigUInt64LE(1), 1234567n);
  assert.equal(transfer.data[9], 6);
  tx.sign(sender);
  assert.equal(tx.verifySignatures(), true);
});

test('sponsored Solana flow preserves the sponsor signature and rejects user-paid rent', () => {
  const sender = Keypair.fromSeed(new Uint8Array(32).fill(1));
  const recipient = Keypair.fromSeed(new Uint8Array(32).fill(2));
  const sponsor = Keypair.fromSeed(new Uint8Array(32).fill(4));
  const blockhash = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
  const build = (rentPayer: string) => {
    const tx = transferTransaction(
      sender.publicKey.toBase58(),
      recipient.publicKey.toBase58(),
      1234567n,
      blockhash,
      sponsor.publicKey.toBase58(),
      rentPayer,
    );
    const versioned = new VersionedTransaction(
      new TransactionMessage({
        payerKey: sponsor.publicKey,
        recentBlockhash: blockhash,
        instructions: tx.instructions,
      }).compileToV0Message(),
    );
    versioned.sign([sponsor]);
    return versioned;
  };
  const sponsored = build(sponsor.publicKey.toBase58());
  const validate = (tx: VersionedTransaction) =>
    validateSponsoredTransaction(
      tx,
      sender.publicKey.toBase58(),
      recipient.publicKey.toBase58(),
      1234567n,
      sponsor.publicKey.toBase58(),
      blockhash,
    );
  validate(sponsored);
  const signature = new Uint8Array(sponsored.signatures[0]);
  sponsored.sign([sender]);
  assert.deepEqual(sponsored.signatures[0], signature);
  assert.throws(() => validate(build(sender.publicKey.toBase58())));
  sponsored.signatures[0].fill(0);
  assert.throws(() => validate(sponsored));
});
