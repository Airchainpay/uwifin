import {
  createWalletClient,
  custom,
  getAddress,
  type EIP1193Provider,
  type Address,
  type WalletClient,
  type Transport,
  type Chain,
  type Account,
} from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import {
  alchemyWalletTransport,
  createSmartWalletClient,
  type SignSignatureRequestParams,
} from '@alchemy/wallet-apis';
import { emailWalletAccount } from './email-wallet';
import { request, type Wallet, type Capabilities } from './api';
import type { Transfer } from './transfers';

export async function browserSigner(
  chainId: number,
  expected?: string,
  useEmail = true,
): Promise<WalletClient<Transport, Chain, Account>> {
  const chain = [base, baseSepolia, mainnet].find((item) => item.id === chainId);
  if (!chain) throw new Error('Unsupported wallet network.');
  const embedded = useEmail ? emailWalletAccount() : null;
  if (embedded && (!expected || embedded.address.toLowerCase() === expected.toLowerCase())) {
    return createWalletClient({
      account: embedded,
      chain,
      transport: custom({
        request: async () => {
          throw new Error('Only signing is available here.');
        },
      }),
    });
  }
  const provider = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
  if (!provider)
    throw new Error(
      'Open UwiFin in a wallet browser or install an Ethereum wallet extension to connect.',
    );
  const client = createWalletClient({ transport: custom(provider), chain });
  const [address] = await client.requestAddresses();
  if (!address || (expected && address.toLowerCase() !== expected.toLowerCase()))
    throw new Error('Select the wallet account that owns this UwiFin smart wallet, then retry.');
  if ((await client.getChainId()) !== chainId) await client.switchChain({ id: chainId });
  return createWalletClient({ account: getAddress(address), transport: custom(provider), chain });
}
export async function connectSmartWallet(
  capabilities: Capabilities,
  mode: 'external' | 'email' = 'external',
): Promise<Wallet> {
  if (!capabilities.wallet_enabled)
    throw new Error('Wallet connection is temporarily unavailable.');
  if (capabilities.family === 'solana') {
    if (mode === 'email') throw new Error('Connect a Solana wallet extension for this network.');
    return (await import('./solana-wallet')).connectSolanaWallet();
  }
  const signer = await browserSigner(capabilities.chain_id, undefined, mode === 'email');
  const challenge = await request<{ id: string; message: string }>('/wallets/challenge', {
    method: 'POST',
    body: JSON.stringify({ signer_address: signer.account.address }),
  });
  const signature = await signer.signMessage({ message: challenge.message });
  return request<Wallet>('/wallets', {
    method: 'POST',
    body: JSON.stringify({ challenge_id: challenge.id, signature }),
  });
}
/** Only the persisted server intent is prepared. No provider credentials reach the browser. */
export async function signTransfer(
  wallet: Wallet,
  capabilities: Capabilities,
  intent: Transfer,
): Promise<void> {
  if (!wallet.signer_address) throw new Error('Reconnect your wallet to verify ownership.');
  if (['submitted', 'pending', 'confirmed', 'failed'].includes(intent.status)) return;
  if (capabilities.family === 'solana') {
    return (await import('./solana-wallet')).signSolanaTransfer(wallet, intent);
  }
  const signer = await browserSigner(capabilities.chain_id, wallet.signer_address);
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
