'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from './AuthContext';
import { request, type Wallet, type Balance, type Capabilities } from '@/lib/api';
import type { Transfer } from '@/lib/transfers';
import { parseAmount, validateAddress } from '@/lib/money';
import { provisionWallet, signTransfer } from '@/lib/wallet';
import { canSignWallet, prepareEmbeddedWallet } from '@/lib/embedded-wallet';
import { useEmbeddedWallet } from './EmbeddedWalletContext';

type FinanceState = {
  balance: string;
  balanceKnown: boolean;
  address: string;
  wallets: Wallet[];
  wallet: Wallet | null;
  capabilities: Capabilities | null;
  networkLabel: string;
  transfers: Transfer[];
  loading: boolean;
  error: string;
  selectWallet: (id: string) => void;
  walletReady: boolean;
  settingUp: boolean;
  setupError: string;
  retryWalletSetup: () => void;
  send: (recipient: string, amount: string, key: string) => Promise<Transfer>;
  refresh: () => Promise<void>;
};
const FinanceContext = createContext<FinanceState | null>(null);
export function FinanceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  // Remount per identity so a previous user's state and async results cannot enter a new session.
  return (
    <AccountFinance key={user?.id || 'signed-out'} signedIn={!!user}>
      {children}
    </AccountFinance>
  );
}
function AccountFinance({ signedIn, children }: { signedIn: boolean; children: ReactNode }) {
  const embedded = useEmbeddedWallet();
  const [settingUp, setSettingUp] = useState(false);
  const [setupError, setSetupError] = useState('');
  const setupAttempt = useRef('');
  const [balance, setBalance] = useState('0');
  const [balanceKnown, setBalanceKnown] = useState(false);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [selected, setSelected] = useState('');
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(signedIn);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const active = useRef(true);
  const fetchController = useRef<AbortController | null>(null);
  const wallet =
    wallets.find((item) => item.id === selected) ||
    wallets.find((item) => canSignWallet(item, embedded)) ||
    wallets[0] ||
    null;
  const walletReady = !!wallet && canSignWallet(wallet, embedded);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      fetchController.current?.abort();
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!signedIn) return;
    if (fetchController.current) return;
    const controller = new AbortController();
    fetchController.current = controller;
    const options = { signal: controller.signal };
    setLoading(true);
    setError('');
    setSettingUp(false);
    try {
      const [config, initialRecords, history] = await Promise.all([
        request<Capabilities>('/capabilities', options),
        request<Wallet[]>('/wallets', options),
        request<{ transactions: Transfer[] }>('/transactions?limit=100', options),
      ]);
      if (controller.signal.aborted) return;
      setCapabilities(config);
      let records = initialRecords;
      const signerAddress =
        config.family === 'solana' ? embedded.solana?.address : embedded.evm?.address;
      const attempt = `${config.network}:${signerAddress}`;
      if (
        signerAddress &&
        config.wallet_enabled &&
        !records.some((item) => canSignWallet(item, embedded)) &&
        setupAttempt.current !== attempt
      ) {
        setupAttempt.current = attempt;
        setSettingUp(true);
        setSetupError('');
        try {
          const created = await prepareEmbeddedWallet(config, records, embedded, () =>
            provisionWallet(config, embedded, controller.signal),
          );
          if (created) records = [created, ...records];
        } catch (err) {
          if (controller.signal.aborted) setupAttempt.current = '';
          else
            setSetupError(
              err instanceof Error ? err.message : 'Automatic wallet setup could not finish.',
            );
        }
      }
      if (controller.signal.aborted) return;
      setWallets(records);
      setTransfers(history.transactions);
      const current =
        records.find((item) => item.id === selected) ||
        records.find((item) => canSignWallet(item, embedded)) ||
        records[0];
      if (!current) {
        setBalance('0');
        setBalanceKnown(false);
        return;
      }
      const balances = await request<Balance[]>(`/wallets/${current.id}/balances`, options);
      const usdc = balances.find((item) => item.asset === 'USDC');
      if (!usdc || !/^\d+(\.\d{1,6})?$/.test(usdc.balance))
        throw new Error('USDC balance is unavailable.');
      const [whole, fraction = ''] = usdc.balance.split('.');
      if (!controller.signal.aborted) {
        setBalance((BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString());
        setBalanceKnown(true);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setBalanceKnown(false);
        setError(err instanceof Error ? err.message : 'Unable to load your wallet.');
      }
    } finally {
      if (fetchController.current === controller) {
        fetchController.current = null;
        if (!controller.signal.aborted) {
          setLoading(false);
          setSettingUp(false);
        }
      }
    }
  }, [selected, signedIn, embedded]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden && !lock.current) void refresh();
    }, 15_000);
    return () => {
      clearInterval(timer);
      fetchController.current?.abort();
      fetchController.current = null;
    };
  }, [refresh]);
  const retryWalletSetup = () => {
    setupAttempt.current = '';
    setSetupError('');
    if (embedded.status === 'error') embedded.retry();
    else void refresh();
  };
  const send = async (recipient: string, amount: string, key: string): Promise<Transfer> => {
    if (!wallet || !walletReady || !capabilities || !balanceKnown)
      throw new Error('Wait for your wallet setup and balance to finish before sending.');
    if (!capabilities.transfers_enabled)
      throw new Error('Transfers are temporarily unavailable on this network.');
    if (
      !validateAddress(recipient, wallet.network) ||
      (wallet.network === 'solana-mainnet'
        ? recipient === wallet.address
        : recipient.toLowerCase() === wallet.address.toLowerCase())
    )
      throw new Error('Enter a valid recipient other than your own wallet.');
    if (parseAmount(amount) > BigInt(balance)) throw new Error('Insufficient USDC balance.');
    if (lock.current) throw new Error('A wallet action is already in progress.');
    lock.current = true;
    try {
      const intent = await request<Transfer>('/transactions', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({
          wallet_id: wallet.id,
          network: wallet.network,
          asset: 'USDC',
          recipient,
          amount,
        }),
      });
      if (!active.current)
        throw new Error('Your session changed. Check transaction history before retrying.');
      await signTransfer(wallet, capabilities, intent, embedded);
      const result = await request<Transfer>(`/transactions/${intent.id}`);
      if (active.current) await refresh();
      return result;
    } finally {
      lock.current = false;
    }
  };
  return (
    <FinanceContext.Provider
      value={{
        balance,
        balanceKnown,
        address: wallet?.address || '',
        wallets,
        wallet,
        capabilities,
        networkLabel: capabilities?.network_label || 'Network unavailable',
        transfers,
        loading,
        error,
        selectWallet: (id) => {
          setBalanceKnown(false);
          setSelected(id);
        },
        walletReady,
        settingUp: settingUp || (!walletReady && embedded.status === 'loading'),
        setupError: setupError || (!walletReady ? embedded.error : ''),
        retryWalletSetup,
        send,
        refresh,
      }}
    >
      {children}
    </FinanceContext.Provider>
  );
}
export function useFinance() {
  const value = useContext(FinanceContext);
  if (!value) throw new Error('FinanceProvider is required.');
  return value;
}
