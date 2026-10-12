'use client';
import { transactionUrl } from '@/lib/networks';
import { type Transfer } from '@/lib/transfers';
import { useFinance } from '@/contexts/FinanceContext';
import { decimalAmount } from '@/lib/money';
import { Modal, StatusBadge, TransactionIcon, CopyButton } from './UI';
import { ArrowUpRight, CheckCircle2, Clock3 } from 'lucide-react';
export function TransferDetails({
  transfer,
  onClose,
}: {
  transfer: Transfer;
  onClose: () => void;
}) {
  const { transfers } = useFinance();
  const current = transfers.find((item) => item.id === transfer.id) || transfer;
  return (
    <Modal title="Transaction details" onClose={onClose}>
      <div className="transfer-detail-hero">
        <TransactionIcon kind={current.kind} />
        <h2>
          {current.kind === 'sent' ? '−' : '+'}
          {`${decimalAmount(current.amount_atomic)} USDC`}
        </h2>
        <p>
          {current.kind === 'sent' ? 'Sent to' : current.kind === 'received' ? 'Received from' : ''}{' '}
          {current.name}
        </p>
        <StatusBadge status={current.status} />
      </div>
      <dl className="detail-list">
        <div>
          <dt>Asset</dt>
          <dd>USDC</dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>{current.network}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>
            {new Date(current.created_at).toLocaleString('en-US', {
              timeZone: 'UTC',
              dateStyle: 'medium',
              timeStyle: 'short',
            })}{' '}
            UTC
          </dd>
        </div>
        <div className="detail-address">
          <dt>Wallet address</dt>
          <dd>
            <code>{current.address}</code>
            <CopyButton value={current.address} />
          </dd>
        </div>
        <div>
          <dt>Transaction ID</dt>
          <dd className="break-all">{current.id}</dd>
        </div>
        {current.tx_hash && (
          <div className="detail-address">
            <dt>Blockchain hash</dt>
            <dd>
              <code>{current.tx_hash}</code>
              <a
                href={transactionUrl(current.network, current.tx_hash)}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on explorer <ArrowUpRight size={14} />
              </a>
            </dd>
          </div>
        )}
        {current.user_operation_hash && (
          <div>
            <dt>User operation</dt>
            <dd className="break-all">{current.user_operation_hash}</dd>
          </div>
        )}
        {current.gas_used && (
          <div>
            <dt>Gas used</dt>
            <dd>{current.gas_used}</dd>
          </div>
        )}
        {current.gas_price && (
          <div>
            <dt>Gas price</dt>
            <dd>{current.gas_price} wei</dd>
          </div>
        )}
        {current.error_code && (
          <div>
            <dt>Failure reason</dt>
            <dd>{current.error_code.replaceAll('_', ' ')}</dd>
          </div>
        )}
      </dl>
      <div className="info-note">
        {current.status === 'pending' ? <Clock3 size={18} /> : <CheckCircle2 size={18} />}
        <p>
          {current.status === 'confirmed'
            ? 'Settlement has been verified on the blockchain.'
            : 'A transfer is complete only after blockchain confirmation.'}
        </p>
      </div>
      <button className="button primary full-width" onClick={onClose}>
        Done
      </button>
    </Modal>
  );
}
