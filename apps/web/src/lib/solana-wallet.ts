import { VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { validateSponsoredTransaction } from './solana-transactions';
import { request, type Wallet } from './api';
import type { Transfer } from './transfers';
import type { SolanaSigner } from './embedded-wallet';
export async function provisionSolanaWallet(
  signer: SolanaSigner,
  signal: AbortSignal,
): Promise<Wallet> {
  const challenge = await request<{ id: string; message: string }>('/wallets/challenge', {
    method: 'POST',
    signal,
    body: JSON.stringify({ signer_address: signer.address }),
  });
  signal.throwIfAborted();
  const signature = await signer.signMessage(new TextEncoder().encode(challenge.message));
  signal.throwIfAborted();
  return request<Wallet>('/wallets', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      challenge_id: challenge.id,
      signature: Buffer.from(signature).toString('base64'),
    }),
  });
}
export async function signSolanaTransfer(
  wallet: Wallet,
  intent: Transfer,
  signer: SolanaSigner,
): Promise<void> {
  if (signer.address !== wallet.address)
    throw new Error('Your Solana signing account does not match this wallet.');
  const rpc = <T>(method: string, params: unknown[]) =>
    request<T>(`/transactions/${intent.id}/rpc`, {
      method: 'POST',
      body: JSON.stringify({ method, params }),
    });
  const prepared = await rpc<{
    type: string;
    transaction: string;
    blockhash: string;
    fee_payer: string;
    sponsored: boolean;
  }>('wallet_prepareCalls', []);
  if (prepared.type !== 'solana-transaction' || !prepared.sponsored)
    throw new Error('Approved Solana sponsorship is required.');
  const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64'));
  validateSponsoredTransaction(
    transaction,
    wallet.address,
    intent.address,
    BigInt(intent.amount_atomic),
    prepared.fee_payer,
    prepared.blockhash,
  );
  const signedBytes = await signer.signTransaction(transaction.serialize());
  const signed = VersionedTransaction.deserialize(signedBytes);
  if (
    Buffer.compare(
      Buffer.from(signed.message.serialize()),
      Buffer.from(transaction.message.serialize()),
    ) !== 0 ||
    Buffer.compare(Buffer.from(signed.signatures[0]), Buffer.from(transaction.signatures[0])) !== 0
  )
    throw new Error('The signed transfer changed. Please retry.');
  await rpc('wallet_sendPreparedCalls', [
    { transaction: Buffer.from(signed.serialize()).toString('base64') },
  ]);
}
