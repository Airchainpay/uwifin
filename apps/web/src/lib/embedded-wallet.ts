import type { LocalAccount } from 'viem';
import type { Wallet, Capabilities } from './api';

export type SolanaSigner = {
  address: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(transaction: Uint8Array): Promise<Uint8Array>;
};
export type EmbeddedSigners = { evm: LocalAccount | null; solana: SolanaSigner | null };

export function canSignWallet(wallet: Wallet, signers: EmbeddedSigners): boolean {
  return wallet.network === 'solana-mainnet'
    ? wallet.signer_address === signers.solana?.address
    : !!wallet.signer_address &&
        wallet.signer_address.toLowerCase() === signers.evm?.address.toLowerCase();
}

// Do not expose restored SDK wallets until their custom-auth subject matches the UwiFin session.
export function matchesWalletIdentity(
  linkedAccounts: readonly { type: string; customUserId?: string }[],
  userId: string,
): boolean {
  return linkedAccounts.some(
    (account) => account.type === 'custom_auth' && account.customUserId === userId,
  );
}

/** Resolve only a wallet controlled by this session, provisioning it when the network is enabled. */
export async function prepareEmbeddedWallet(
  capabilities: Capabilities,
  wallets: readonly Wallet[],
  signers: EmbeddedSigners,
  provision: () => Promise<Wallet>,
): Promise<Wallet | null> {
  const existing = wallets.find(
    (wallet) => wallet.network === capabilities.network && canSignWallet(wallet, signers),
  );
  if (existing) return existing;
  const signer = capabilities.family === 'solana' ? signers.solana : signers.evm;
  if (!capabilities.wallet_enabled || !signer) return null;
  const created = await provision();
  if (created.network !== capabilities.network || !canSignWallet(created, signers))
    throw new Error('Your wallet could not be verified. Please retry setup.');
  return created;
}
