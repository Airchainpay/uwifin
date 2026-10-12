import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { validateSponsoredTransaction } from './solana-transactions';
import { request, type Wallet } from './api';
import type { Transfer } from './transfers';
type SolanaProvider = {
  publicKey: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  signMessage(message: Uint8Array, encoding: 'utf8'): Promise<{ signature: Uint8Array }>;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
};
function provider(): SolanaProvider {
  const browser = window as Window & {
    phantom?: { solana?: SolanaProvider };
    solana?: SolanaProvider;
  };
  const wallet = browser.phantom?.solana || browser.solana;
  if (!wallet) throw new Error('Install a Solana wallet such as Phantom to connect.');
  return wallet;
}
export async function connectSolanaWallet(): Promise<Wallet> {
  const signer = provider();
  const { publicKey } = await signer.connect();
  const challenge = await request<{ id: string; message: string }>('/wallets/challenge', {
    method: 'POST',
    body: JSON.stringify({ signer_address: publicKey.toBase58() }),
  });
  const { signature } = await signer.signMessage(
    new TextEncoder().encode(challenge.message),
    'utf8',
  );
  return request<Wallet>('/wallets', {
    method: 'POST',
    body: JSON.stringify({
      challenge_id: challenge.id,
      signature: Buffer.from(signature).toString('base64'),
    }),
  });
}
export async function signSolanaTransfer(wallet: Wallet, intent: Transfer): Promise<void> {
  const signer = provider();
  const { publicKey } = await signer.connect();
  if (publicKey.toBase58() !== wallet.address)
    throw new Error('Select the Solana account that owns this wallet.');
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
  const signed = await signer.signTransaction(transaction);
  await rpc('wallet_sendPreparedCalls', [
    { transaction: Buffer.from(signed.serialize()).toString('base64') },
  ]);
}
