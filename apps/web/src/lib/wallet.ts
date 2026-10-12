import { createWalletClient, custom, type Address } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import {
  alchemyWalletTransport,
  createSmartWalletClient,
  type SignSignatureRequestParams,
} from '@alchemy/wallet-apis';
import { canSignWallet, type EmbeddedSigners } from './embedded-wallet';
import { request, type Wallet, type Capabilities } from './api';
import type { Transfer } from './transfers';

function walletSigner(chainId: number, signers: EmbeddedSigners) {
  const chain = [base, baseSepolia, mainnet].find((item) => item.id === chainId);
  if (!chain || !signers.evm)
    throw new Error('Your wallet is still being prepared. Please retry shortly.');
  return createWalletClient({
    account: signers.evm,
    chain,
    transport: custom({
      request: async () => {
        throw new Error('Only signing is available here.');
      },
    }),
  });
}
export async function provisionWallet(
  capabilities: Capabilities,
  signers: EmbeddedSigners,
  signal: AbortSignal,
): Promise<Wallet> {
  if (!capabilities.wallet_enabled)
    throw new Error('Automatic wallet setup is temporarily unavailable.');
  if (capabilities.family === 'solana') {
    if (!signers.solana) throw new Error('Your Solana wallet is still being prepared.');
    return (await import('./solana-wallet')).provisionSolanaWallet(signers.solana, signal);
  }
  const signer = walletSigner(capabilities.chain_id, signers);
  const challenge = await request<{ id: string; message: string }>('/wallets/challenge', {
    method: 'POST',
    signal,
    body: JSON.stringify({ signer_address: signer.account.address }),
  });
  signal.throwIfAborted();
  const signature = await signer.signMessage({ message: challenge.message });
  signal.throwIfAborted();
  return request<Wallet>('/wallets', {
    method: 'POST',
    signal,
    body: JSON.stringify({ challenge_id: challenge.id, signature }),
  });
}
/** Only the persisted server intent is prepared. No provider credentials reach the browser. */
export async function signTransfer(
  wallet: Wallet,
  capabilities: Capabilities,
  intent: Transfer,
  signers: EmbeddedSigners,
): Promise<void> {
  if (!canSignWallet(wallet, signers))
    throw new Error('This wallet is not managed by your current signing account.');
  if (['submitted', 'pending', 'confirmed', 'failed'].includes(intent.status)) return;
  if (capabilities.family === 'solana') {
    return (await import('./solana-wallet')).signSolanaTransfer(wallet, intent, signers.solana!);
  }
  const signer = walletSigner(capabilities.chain_id, signers);
  const rpc = <T>(method: string, params: unknown[]) =>
    request<T>(`/transactions/${intent.id}/rpc`, {
      method: 'POST',
      body: JSON.stringify({ method, params }),
    });
  const prepared = await rpc<{
    type: string;
    data: { sender: string };
    chainId: string;
    signatureRequest: SignSignatureRequestParams;
    feePayment: { sponsored: boolean };
  }>('wallet_prepareCalls', []);
  if (
    !['user-operation-v060', 'user-operation-v070'].includes(prepared.type) ||
    Number(BigInt(prepared.chainId)) !== capabilities.chain_id ||
    prepared.data.sender.toLowerCase() !== wallet.address.toLowerCase() ||
    !prepared.feePayment.sponsored ||
    !['personal_sign', 'eth_signTypedData_v4'].includes(prepared.signatureRequest.type)
  )
    throw new Error('The prepared transfer could not be verified.');
  // This SDK action only invokes the user's signer. Network operations use the intent-scoped API above.
  const client = createSmartWalletClient({
    signer,
    account: wallet.address as Address,
    chain: signer.chain,
    transport: alchemyWalletTransport({
      url: `${window.location.origin}/api/v1/transactions/${intent.id}/rpc`,
    }),
  });
  const signature = await client.signSignatureRequest(prepared.signatureRequest);
  // Preserve the exact provider payload; decoding/re-encoding can change hex representations.
  await rpc('wallet_sendPreparedCalls', [
    { type: prepared.type, chainId: prepared.chainId, data: prepared.data, signature },
  ]);
}
