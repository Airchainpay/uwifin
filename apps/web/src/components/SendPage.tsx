'use client';
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { useFinance } from '@/contexts/FinanceContext';
import { useAuth } from '@/contexts/AuthContext';
import type { Transfer } from '@/lib/transfers';
import { decimalAmount, parseAmount, validateAddress } from '@/lib/money';
import { StatusBadge } from './UI';
export function SendPage({
  initialRecipient = '',
  initialAmount = '',
}: {
  initialRecipient?: string;
  initialAmount?: string;
}) {
  const { user } = useAuth();
  const {
    wallet,
    walletReady,
    balance,
    balanceKnown,
    capabilities,
    networkLabel,
    send,
    transfers,
  } = useFinance();
  const [recipient, setRecipient] = useState(initialRecipient === 'new' ? '' : initialRecipient);
  const [amount, setAmount] = useState(initialAmount);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Transfer | null>(null);
  const key = useRef('');
  const reviewedWallet = useRef('');
  const intentStorageKey = useRef('');
  const reviewTransfer = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      if (!wallet || !walletReady || !balanceKnown)
        throw new Error('Wait for your wallet setup and balance to finish first.');
      if (
        !validateAddress(recipient, wallet.network) ||
        (wallet.network === 'solana-mainnet'
          ? recipient === wallet.address
          : recipient.toLowerCase() === wallet.address.toLowerCase())
      )
        throw new Error('Enter a valid recipient other than your own wallet.');
      const atomic = parseAmount(amount);
      if (atomic > BigInt(balance)) throw new Error('Insufficient USDC balance.');
      const storageKey = `uwifin-intent:${user?.id}:${wallet.id}:${wallet.network === 'solana-mainnet' ? recipient : recipient.toLowerCase()}:${atomic}`;
      intentStorageKey.current = storageKey;
      key.current = sessionStorage.getItem(storageKey) || crypto.randomUUID();
      sessionStorage.setItem(storageKey, key.current);
      reviewedWallet.current = wallet.id;
      setReview(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check transfer details.');
    }
  };
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (reviewedWallet.current !== wallet?.id)
        throw new Error('The selected wallet changed. Review the transfer again.');
      setResult(await send(recipient, amount, key.current));
    } catch (err) {
      setError(
        `${err instanceof Error ? err.message : 'Submission is unavailable.'} Check your history before starting another transfer. Retrying here reuses this transfer.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const current = transfers.find((item) => item.id === result?.id) || result;
  const startAnother = () => {
    if (!current || !['confirmed', 'failed'].includes(current.status)) return;
    try {
      // Only an explicit new transfer after settlement releases the retry key.
      if (sessionStorage.getItem(intentStorageKey.current) === key.current)
        sessionStorage.removeItem(intentStorageKey.current);
      key.current = '';
      setResult(null);
      setReview(false);
      setError('');
    } catch {
      setError('Unable to start another transfer. Check your browser storage settings.');
    }
  };
  return (
    <>
      <section className="page-heading">
        <div>
          <h1>Send USDC.</h1>
          <p>Review the exact amount and recipient before signing.</p>
        </div>
      </section>
      <div className="flow-layout">
        <section className="card flow-card">
          {!wallet && (
            <p className="info-note">
              <Link href="/wallet">Check your wallet setup</Link> before sending.
            </p>
          )}
          {current ? (
            <div className="success-panel">
              <h2>
                {current.status === 'confirmed'
                  ? 'Transfer confirmed'
                  : current.status === 'failed'
                    ? 'Transfer failed'
                    : 'Transfer in progress'}
              </h2>
              <StatusBadge status={current.status} />
              <p>{decimalAmount(current.amount_atomic)} USDC</p>
              <code className="receive-address">{current.address}</code>
              <p>
                Confirmation is checked against the blockchain. A submitted transfer can take time
                to settle.
              </p>
              <Link href="/transactions" className="button primary">
                View transaction history
              </Link>
              {['confirmed', 'failed'].includes(current.status) && (
                <button className="button secondary" onClick={startAnother}>
                  Start another transfer
                </button>
              )}
              {error && (
                <p role="alert" className="field-error">
                  {error}
                </p>
              )}
            </div>
          ) : review ? (
            <div className="review-transfer">
              <h2>Review your transfer</h2>
              <div className="review-amount">
                {decimalAmount(parseAmount(amount))}
                <span>USDC</span>
              </div>
              <dl className="detail-list">
                <div>
                  <dt>Network</dt>
                  <dd>{networkLabel}</dd>
                </div>
                <div className="detail-address">
                  <dt>From</dt>
                  <dd>
                    <code>{wallet?.address}</code>
                  </dd>
                </div>
                <div className="detail-address">
                  <dt>Recipient</dt>
                  <dd>
                    <code>{recipient}</code>
                  </dd>
                </div>
                <div>
                  <dt>Network fee</dt>
                  <dd>
                    {capabilities?.family === 'solana'
                      ? 'Network fee and account rent sponsored'
                      : 'Sponsored if eligible'}
                  </dd>
                </div>
              </dl>
              <p className="info-note">
                {capabilities?.family === 'solana'
                  ? 'Alchemy sponsorship covers the network fee and recipient token account rent. You do not need SOL.'
                  : 'The transfer proceeds only if gas sponsorship is approved.'}{' '}
                Your wallet will ask you to sign. Blockchain transfers cannot be reversed.
              </p>
              {error && (
                <p role="alert" className="field-error">
                  {error}
                </p>
              )}
              <button
                className="button primary full-width"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {busy ? 'Approve in your wallet…' : 'Sign and send'}
              </button>
              <button
                className="button text-button full-width"
                disabled={busy}
                onClick={() => setReview(false)}
              >
                Edit details
              </button>
            </div>
          ) : (
            <form className="stacked-form" onSubmit={reviewTransfer}>
              <h2>Transfer details</h2>
              <label htmlFor="recipient">Recipient wallet address</label>
              <input
                id="recipient"
                className="input"
                value={recipient}
                onChange={(event) => setRecipient(event.target.value.trim())}
                placeholder={capabilities?.family === 'solana' ? 'Solana wallet address' : '0x…'}
                required
              />
              <label htmlFor="amount">Amount in USDC</label>
              <input
                id="amount"
                className="input"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                required
              />
              <p>Available: {balanceKnown ? `${decimalAmount(balance)} USDC` : 'Unavailable'}</p>
              <p>Network: {networkLabel}</p>
              {error && (
                <p role="alert" className="field-error">
                  {error}
                </p>
              )}
              <button
                className="button primary"
                disabled={
                  !wallet || !walletReady || !balanceKnown || !capabilities?.transfers_enabled
                }
              >
                Review transfer
              </button>
              {!capabilities?.transfers_enabled && (
                <p>Transfers are currently unavailable on this network.</p>
              )}
            </form>
          )}
        </section>
        <aside className="flow-side">
          <h2>Before you send</h2>
          <p>Verify the full recipient address and network with the person receiving your funds.</p>
          <p>Use native USDC on {networkLabel}. The recipient must use the same network.</p>
          <p>UwiFin never asks for your seed phrase.</p>
        </aside>
      </div>
    </>
  );
}
