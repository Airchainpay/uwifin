export type User = {
  role: 'user' | 'admin';
  id: string;
  email: string;
  name?: string;
  created_at?: string;
};
export type Wallet = {
  id: string;
  address: string;
  network: string;
  wallet_type: string;
  signer_address: string | null;
};
export type Capabilities = {
  networks: { id: string; label: string }[];
  network_label: string;
  family: 'evm' | 'solana';
  transfers_enabled: boolean;
  network: string;
  chain_id: number;
  usdc_address: string;
  wallet_enabled: boolean;
  sponsorship_enabled: boolean;
  onramp_enabled: boolean;
  stripe_mode: string;
  offramp_enabled: boolean;
};
export type Balance = { asset: string; balance: string; network: string };

// Freeze the network for this page lifetime, including in-flight signing operations.
let networkPrefix: string | undefined;
function apiPrefix(): string {
  if (networkPrefix === undefined) {
    const selected =
      typeof window === 'undefined' ? null : sessionStorage.getItem('uwifin-network');
    networkPrefix =
      selected && ['base', 'eth-mainnet', 'solana-mainnet', 'base-sepolia'].includes(selected)
        ? `/networks/${selected}`
        : '';
  }
  return `/api/v1${networkPrefix}`;
}
export function selectNetwork(network: string) {
  sessionStorage.setItem('uwifin-network', network);
  window.location.reload();
}
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiPrefix()}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      body?.error?.message || 'This service is temporarily unavailable. Please try again.',
    );
  return body as T;
}
