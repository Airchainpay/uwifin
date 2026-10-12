'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  PrivyProvider,
  toViemAccount,
  usePrivy,
  useSubscribeToJwtAuthWithFlag,
  useWallets,
} from '@privy-io/react-auth';
import { useWallets as useSolanaWallets } from '@privy-io/react-auth/solana';
import { base, baseSepolia, mainnet } from 'viem/chains';
import type { LocalAccount } from 'viem';
import { useAuth } from './AuthContext';
import { EmbeddedWalletContext, type EmbeddedWalletState } from './EmbeddedWalletContext';
import { matchesWalletIdentity, type SolanaSigner } from '@/lib/embedded-wallet';

export default function PrivyWalletProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      config={{
        supportedChains: [base, mainnet, baseSepolia],
        defaultChain: base,
        embeddedWallets: {
          ethereum: { createOnLogin: 'all-users' },
          solana: { createOnLogin: 'all-users' },
          showWalletUIs: false,
        },
      }}
    >
      <WalletSession key={user?.id || 'signed-out'}>{children}</WalletSession>
    </PrivyProvider>
  );
}

function WalletSession({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const { user: privyUser, ready, authenticated, logout } = usePrivy();
  const { wallets: evmWallets } = useWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const [evm, setEvm] = useState<LocalAccount | null>(null);
  const [solana, setSolana] = useState<SolanaSigner | null>(null);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const getExternalJwt = useCallback(async () => {
    if (!user) return undefined;
    const response = await fetch('/api/privy/token', {
      method: 'POST',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json();
    if (!response.ok || typeof result.token !== 'string')
      throw new Error('Automatic wallet setup is temporarily unavailable.');
    if (!active.current || result.user_id !== user.id)
      throw new Error('Your session changed. Please sign in again.');
    return result.token as string;
  }, [user]);
  const { state } = useSubscribeToJwtAuthWithFlag({
    isAuthenticated: !!user && !retrying,
    isLoading: loading,
    getExternalJwt,
    onError: () => {
      if (active.current) setError('Automatic wallet setup could not finish. Please retry.');
    },
  });
  const identityMatches =
    !!user &&
    authenticated &&
    !!privyUser &&
    matchesWalletIdentity(privyUser.linkedAccounts, user.id);
  const evmAddress = identityMatches
    ? privyUser.linkedAccounts
        .filter((account) => account.type === 'wallet')
        .find(
          (account) =>
            account.chainType === 'ethereum' &&
            ['privy', 'privy-v2'].includes(account.walletClientType || ''),
        )?.address
    : undefined;
  const solanaAddress = identityMatches
    ? privyUser.linkedAccounts
        .filter((account) => account.type === 'wallet')
        .find(
          (account) =>
            account.chainType === 'solana' &&
            ['privy', 'privy-v2'].includes(account.walletClientType || ''),
        )?.address
    : undefined;
  const evmWallet = evmWallets.find(
    (wallet) => wallet.address.toLowerCase() === evmAddress?.toLowerCase(),
  );
  const solanaWallet = solanaWallets.find((wallet) => wallet.address === solanaAddress);
  const evmWalletRef = useRef(evmWallet);
  const solanaWalletRef = useRef(solanaWallet);
  useEffect(() => {
    evmWalletRef.current = evmWallet;
    solanaWalletRef.current = solanaWallet;
  }, [evmWallet, solanaWallet]);
  const connectedEvmAddress = evmWallet?.address;
  const connectedSolanaAddress = solanaWallet?.address;
  useEffect(() => {
    let current = true;
    setEvm(null);
    const wallet = evmWalletRef.current;
    if (wallet)
      void toViemAccount({ wallet })
        .then((account) => {
          if (current) setEvm(account);
        })
        .catch(() => {
          if (current) setError('Your wallet could not be prepared. Please retry.');
        });
    return () => {
      current = false;
    };
  }, [connectedEvmAddress]);
  useEffect(() => {
    if (!connectedSolanaAddress) {
      setSolana(null);
      return;
    }
    setSolana({
      address: connectedSolanaAddress,
      signMessage: async (message) => {
        const wallet = solanaWalletRef.current;
        if (!active.current || wallet?.address !== connectedSolanaAddress)
          throw new Error('Your wallet session changed.');
        return (await wallet.signMessage({ message })).signature;
      },
      signTransaction: async (transaction) => {
        const wallet = solanaWalletRef.current;
        if (!active.current || wallet?.address !== connectedSolanaAddress)
          throw new Error('Your wallet session changed.');
        return (await wallet.signTransaction({ transaction, chain: 'solana:mainnet' }))
          .signedTransaction;
      },
    });
  }, [connectedSolanaAddress]);
  const verifiedSolana = identityMatches && solana?.address === solanaAddress ? solana : null;
  const verifiedEvm =
    identityMatches && evm?.address.toLowerCase() === evmAddress?.toLowerCase() ? evm : null;
  const available = identityMatches && !!verifiedEvm && !!verifiedSolana;
  useEffect(() => {
    if (!user || available) return;
    const timer = setTimeout(
      () => setError('Wallet setup is taking longer than expected. Please retry.'),
      45_000,
    );
    return () => clearTimeout(timer);
  }, [user, available]);
  const retry = useCallback(async () => {
    setRetrying(true);
    setError('');
    try {
      await logout();
    } catch {
      setError('Wallet setup could not restart. Please retry.');
    } finally {
      if (active.current) setRetrying(false);
    }
  }, [logout]);
  const value = useMemo<EmbeddedWalletState>(
    () => ({
      evm: verifiedEvm,
      solana: verifiedSolana,
      status: available
        ? 'ready'
        : error || state.status === 'error' || state.status === 'not-enabled'
          ? 'error'
          : 'loading',
      error: available
        ? ''
        : error ||
          (ready && state.status === 'not-enabled'
            ? 'Automatic wallet setup is not enabled yet.'
            : ''),
      retry,
    }),
    [verifiedEvm, verifiedSolana, available, error, state.status, ready, retry],
  );
  return <EmbeddedWalletContext.Provider value={value}>{children}</EmbeddedWalletContext.Provider>;
}
