'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useFinance } from '@/contexts/FinanceContext';
import { decimalAmount } from '@/lib/money';
import type { Transfer } from '@/lib/transfers';
import { TransactionTable } from './UI';
import { TransferDetails } from './TransferDetails';
import { FamilyIllustration } from './FamilyIllustration';
export function Dashboard() {
  const { user } = useAuth();
  const { balance, balanceKnown, address, transfers, networkLabel, error, refresh } = useFinance();
  const [detail, setDetail] = useState<Transfer | null>(null);
  return (
    <>
      <section className="page-heading">
        <div>
          <span className="eyebrow">A LITTLE CLOSER TO HOME</span>
          <h1>Magandang araw, {user?.name?.split(' ')[0] || 'there'}.</h1>
          <p>Your wallet, with a clear view of every transfer.</p>
        </div>
      </section>
      {error && (
        <div className="error-banner" role="alert">
          <p>{error}</p>
          <button onClick={() => void refresh()}>Try again</button>
        </div>
      )}
      <div className="dashboard-grid">
        <section className="balance-card">
          <span>Available USDC</span>
          <div className="balance-value">{balanceKnown ? decimalAmount(balance) : '—'}</div>
          <p>
            {address
              ? 'Balance read from the supported token contract.'
              : 'Your wallet is being prepared automatically.'}
          </p>
          <div className="balance-actions">
            <Link className="button balance-send" href={address ? '/send' : '/wallet'}>
              {address ? 'Send USDC' : 'View wallet setup'}
            </Link>
            <Link className="button balance-receive" href="/receive">
              Receive
            </Link>
            <Link className="button balance-add" href="/payments">
              Add money
            </Link>
          </div>
          <div className="balance-bottom">{networkLabel}</div>
        </section>
        <section className="card quick-send">
          <h2>Padala para sa Pamilya.</h2>
          <FamilyIllustration />
          <p>
            Send USDC from a wallet you control. Review the recipient and exact amount before
            signing.
          </p>
        </section>
      </div>
      <section className="card recent-transactions">
        <div className="card-heading">
          <h2>Recent transfers</h2>
          <Link href="/transactions" className="text-link">
            View history
          </Link>
        </div>
        <TransactionTable transfers={transfers.slice(0, 5)} compact onSelect={setDetail} />
      </section>
      {detail && <TransferDetails transfer={detail} onClose={() => setDetail(null)} />}
    </>
  );
}
