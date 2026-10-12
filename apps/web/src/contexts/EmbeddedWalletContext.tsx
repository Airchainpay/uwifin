'use client';
import { createContext, useContext, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import type { EmbeddedSigners } from '@/lib/embedded-wallet';

export type EmbeddedWalletState = EmbeddedSigners & {
  status: 'loading' | 'ready' | 'unavailable' | 'error';
  error: string;
  retry: () => void;
};
const unavailable: EmbeddedWalletState = {
  evm: null,
  solana: null,
  status: 'unavailable',
  error: 'Automatic wallet setup is not available yet. Please try again later.',
  retry: () => {},
};
export const EmbeddedWalletContext = createContext<EmbeddedWalletState>(unavailable);
const PrivyWalletProvider = dynamic(() => import('./PrivyWalletProvider'), {
  ssr: false,
  loading: () => (
    <div className="loading-page" role="status">
      Opening your account…
    </div>
  ),
});

export function EmbeddedWalletProvider({ children }: { children: ReactNode }) {
  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID)
    return (
      <EmbeddedWalletContext.Provider value={unavailable}>
        {children}
      </EmbeddedWalletContext.Provider>
    );
  return <PrivyWalletProvider>{children}</PrivyWalletProvider>;
}
export function useEmbeddedWallet() {
  return useContext(EmbeddedWalletContext);
}
