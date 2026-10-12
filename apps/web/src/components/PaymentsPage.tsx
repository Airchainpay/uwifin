'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useFinance } from '@/contexts/FinanceContext';
import { request } from '@/lib/api';
import { decimalAmount } from '@/lib/money';
import type { OnrampSession, OnrampUIEventListener } from '@stripe/crypto';
type Payment = {
  id: string;
  status: string;
  fiat_currency: string;
  fiat_amount_minor: string;
  crypto_amount_atomic: string;
};
type Session = { id: string; client_secret: string; publishable_key: string };
function StripePurchase({ session, onUpdate }: { session: Session; onUpdate: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    const target = container.current;
    let checkout: OnrampSession | undefined;
    const updated: OnrampUIEventListener<'onramp_session_updated'> = () => {
      // UI events are only refresh hints. The API verifies settlement with Stripe.
      if (!disposed) onUpdate();
    };
    setError('');
    void (async () => {
      try {
        const { loadStripeOnramp } = await import('@stripe/crypto/pure');
        const stripe = await loadStripeOnramp(session.publishable_key);
        if (!disposed && target) {
          if (!stripe) throw new Error('Stripe could not be loaded.');
          checkout = stripe
            .createSession({ clientSecret: session.client_secret, appearance: { theme: 'light' } })
            .addEventListener('onramp_session_updated', updated)
            .mount(target);
        }
      } catch {
        if (!disposed)
          setError('Stripe could not be loaded. Check your connection and retry this purchase.');
      }
    })();
    return () => {
      disposed = true;
      checkout?.removeEventListener('onramp_session_updated', updated);
      target?.replaceChildren();
    };
  }, [session, attempt, onUpdate]);
  return (
    <>
      {error && (
        <p role="alert" className="field-error">
          {error}
          <button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>
            Reload this checkout
          </button>
        </p>
      )}
      <div ref={container} />
    </>
  );
}
export function PaymentsPage() {
  const { wallet } = useFinance();
  // Discard client secrets and in-flight UI state when the selected destination changes.
  return <WalletPayments key={wallet?.id || 'no-wallet'} />;
}
function WalletPayments() {
  const { wallet, capabilities, networkLabel, refresh: refreshWallet } = useFinance();
  const [amount, setAmount] = useState('100');
  const [currency, setCurrency] = useState('USD');
  const [session, setSession] = useState<Session | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef<{ fingerprint: string; value: string } | null>(null);
  const active = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const refreshPayments = useCallback(async () => {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    try {
      const result = await request<{ payments: Payment[] }>('/payments', {
        signal: current.signal,
      });
      if (active.current && !current.signal.aborted) setPayments(result.payments);
    } catch {
      if (active.current && !current.signal.aborted)
        setError('Payment history is temporarily unavailable.');
    } finally {
      if (controller.current === current) controller.current = null;
    }
  }, []);
  const onCheckoutUpdate = useCallback(() => {
    void refreshPayments();
    void refreshWallet();
  }, [refreshPayments, refreshWallet]);
  useEffect(() => {
    active.current = true;
    void refreshPayments();
    const timer = setInterval(() => {
      if (!document.hidden) void refreshPayments();
    }, 5_000);
    return () => {
      active.current = false;
      controller.current?.abort();
      controller.current = null;
      clearInterval(timer);
    };
  }, [refreshPayments]);
  const payment = payments.find((item) => item.id === session?.id);
  const finished = payment && ['confirmed', 'failed'].includes(payment.status);
  useEffect(() => {
    if (payment?.status === 'confirmed') void refreshWallet();
  }, [payment?.status, refreshWallet]);
  const buy = async (event: FormEvent) => {
    event.preventDefault();
    if (!wallet || busy) return;
    setBusy(true);
    setError('');
    try {
      if (!/^\d{1,5}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 10000)
        throw new Error('Enter an amount from 0.01 to 10,000 with at most two decimal places.');
      const fingerprint = `${wallet.id}:${currency}:${amount}`;
      if (key.current?.fingerprint !== fingerprint)
        key.current = { fingerprint, value: crypto.randomUUID() };
      const created = await request<Session>('/payments', {
        method: 'POST',
        headers: { 'Idempotency-Key': key.current.value },
        body: JSON.stringify({ wallet_id: wallet.id, amount, currency }),
      });
      if (active.current) {
        setSession(created);
        void refreshPayments();
      }
    } catch (err) {
      if (active.current)
        setError(err instanceof Error ? err.message : 'Unable to start purchase.');
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return (
    <>
      <section className="page-heading">
        <div>
          <h1>Add money.</h1>
          <p>Buy USDC through Stripe where supported.</p>
        </div>
      </section>
      <div className="flow-layout">
        <section className="card flow-card">
          <h2>Stripe on-ramp</h2>
          <p>
            Destination: {wallet?.address || 'Finish wallet setup first'} · {networkLabel}
          </p>
          <p>Mode: {capabilities?.stripe_mode || 'Unavailable'}</p>
          {!capabilities?.onramp_enabled && (
            <p className="info-note">
              Card purchases are not available for this wallet. Stripe approval and a supported
              mainnet destination are required.
            </p>
          )}
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          {session ? (
            <>
              <p role="status">
                {payment?.status === 'confirmed'
                  ? 'Purchase complete. Stripe has sent your USDC to this wallet.'
                  : payment?.status === 'failed'
                    ? 'This purchase was rejected. You can start a new purchase.'
                    : 'Complete checkout below. Payment status updates automatically after Stripe verifies it.'}
              </p>
              {!finished && <StripePurchase session={session} onUpdate={onCheckoutUpdate} />}
              {finished && (
                <button
                  className="button primary"
                  onClick={() => {
                    key.current = null;
                    setSession(null);
                    setError('');
                  }}
                >
                  Start a new purchase
                </button>
              )}
            </>
          ) : (
            <form className="stacked-form" onSubmit={buy}>
              <label htmlFor="buy-amount">Purchase amount</label>
              <input
                id="buy-amount"
                className="input"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                required
              />
              <label htmlFor="currency">Currency</label>
              <select
                id="currency"
                className="input"
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
              >
                <option>USD</option>
                <option>EUR</option>
              </select>
              <p>
                Stripe displays the final quote, fees, eligibility checks, and amount before you
                pay. No card details are collected by UwiFin.
              </p>
              <button
                className="button primary"
                disabled={busy || !wallet || !capabilities?.onramp_enabled}
              >
                {busy ? 'Opening Stripe…' : 'Continue to Stripe'}
              </button>
            </form>
          )}
        </section>
        <aside className="flow-side">
          <h2>Cash out</h2>
          <p>
            Fiat cash-out is not available. Stripe stablecoin payouts send stablecoins to wallets
            and do not provide a generic wallet-to-PHP bank or GCash off-ramp.
          </p>
          <p>
            A supported payout provider and destination corridor must be configured before cash-out
            can be offered.
          </p>
        </aside>
      </div>
      <section className="card wallet-assets">
        <h2>Payment history</h2>
        <p>
          Status is verified by the backend with Stripe. Browser redirects do not confirm payment.
        </p>
        {payments.length ? (
          payments.map((payment) => (
            <div className="wallet-asset-row" key={payment.id}>
              <span>
                {payment.fiat_currency} {(BigInt(payment.fiat_amount_minor) / 100n).toString()}.
                {(BigInt(payment.fiat_amount_minor) % 100n).toString().padStart(2, '0')}
              </span>
              <span>{decimalAmount(payment.crypto_amount_atomic)} USDC</span>
              <strong>{payment.status}</strong>
            </div>
          ))
        ) : (
          <p>No payments yet.</p>
        )}
      </section>
    </>
  );
}
