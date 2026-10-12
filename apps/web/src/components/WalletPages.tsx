'use client';
import { EmailWallet } from './EmailWallet';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ArrowDownLeft, ArrowUpRight, Download, Link2, ShieldCheck } from 'lucide-react';
import { useFinance } from '@/contexts/FinanceContext';
import { decimalAmount, shortAddress } from '@/lib/money';
import { selectNetwork } from '@/lib/api';
import { CopyButton, UsdcIcon } from './UI';
export function WalletPage() {
  const {
    wallet,
    wallets,
    selectWallet,
    balance,
    balanceKnown,
    loading,
    error,
    refresh,
    connect,
    capabilities,
    networkLabel,
  } = useFinance();
  const [busy, setBusy] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  return (
    <>
      <section className="page-heading">
        <div>
          <span className="eyebrow">A HOME FOR YOUR MONEY</span>
          <h1>My wallet.</h1>
          <p>Hold and transfer USDC on your selected network.</p>
        </div>
        <button
          className="button primary"
          disabled={busy || !capabilities?.wallet_enabled}
          onClick={async () => {
            setBusy(true);
            setConnectionError('');
            try {
              await connect();
            } catch (err) {
              setConnectionError(err instanceof Error ? err.message : 'Wallet connection failed.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <Link2 size={16} />
          {busy ? 'Approve in your wallet…' : 'Connect wallet'}
        </button>
      </section>
      <label>
        Network
        <select
          className="input"
          value={capabilities?.network || ''}
          disabled={!capabilities || busy}
          onChange={(event) => selectNetwork(event.target.value)}
        >
          {!capabilities && <option value="">Loading networks…</option>}
          {capabilities?.networks.map((network) => (
            <option key={network.id} value={network.id}>
              {network.label}
            </option>
          ))}
        </select>
      </label>
      {capabilities?.family === 'evm' && <EmailWallet />}
      {(error || connectionError) && (
        <p className="error-banner" role="alert">
          {connectionError || error}
        </p>
      )}
      {capabilities && !capabilities.wallet_enabled && (
        <p className="info-note">
          Wallet services are not configured yet. No wallet or balance has been created.
        </p>
      )}
      <div className="wallet-layout">
        <section className="wallet-main-card">
          <div className="card-heading">
            <h2>USDC wallet</h2>
            <span className="network-pill">{networkLabel}</span>
          </div>
          {wallets.length > 1 && (
            <label>
              Select wallet
              <select
                className="input"
                value={wallet?.id}
                onChange={(event) => selectWallet(event.target.value)}
              >
                {wallets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {shortAddress(item.address)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="wallet-label">Available USDC</span>
          <h2>{balanceKnown ? decimalAmount(balance) : loading ? 'Loading…' : 'Unavailable'}</h2>
          <div className="wallet-address-line">
            <code>{wallet?.address || 'Connect a wallet to get started'}</code>
            {wallet && <CopyButton value={wallet.address} />}
          </div>
          {wallet && (
            <>
              <p>
                Signing account: <code>{wallet.signer_address}</code>
              </p>
              <div className="wallet-main-actions">
                <Link className="button primary" href="/send">
                  <ArrowUpRight size={16} />
                  Send
                </Link>
                <Link className="button secondary" href="/receive">
                  <ArrowDownLeft size={16} />
                  Receive
                </Link>
                <Link className="button secondary" href="/payments">
                  Add money
                </Link>
              </div>
            </>
          )}
        </section>
        <section className="card wallet-security">
          <ShieldCheck size={30} />
          <h2>Your wallet. Your control.</h2>
          <p>
            {capabilities?.family === 'solana'
              ? 'Connect a Solana wallet such as Phantom and sign a message to verify ownership. Your connected account is your receive address.'
              : 'Connect an Ethereum wallet and verify ownership to create an Alchemy smart wallet on the selected network.'}
          </p>
          <p>
            Keep access to your signing wallet. UwiFin never asks for your private key or seed
            phrase and cannot recover them.
          </p>
          <p>
            {capabilities?.family === 'solana'
              ? 'Alchemy sponsors eligible network fees and token account rent. You only need USDC; sending requires approved sponsorship.'
              : 'Your smart wallet address differs from your signing account. Use the receive address shown here.'}
          </p>
        </section>
      </div>
      <section className="card wallet-assets">
        <div className="card-heading">
          <h2>Your assets</h2>
          <button className="text-link" disabled={loading} onClick={() => void refresh()}>
            Refresh balances
          </button>
        </div>
        <div className="wallet-asset-row">
          <div>
            <UsdcIcon />
            <strong>USDC</strong>
          </div>
          <span>{networkLabel}</span>
          <strong>{balanceKnown ? `${decimalAmount(balance)} USDC` : 'Balance unavailable'}</strong>
        </div>
      </section>
    </>
  );
}
export function ReceivePage() {
  const { address, networkLabel } = useFinance();
  const [qr, setQr] = useState<{ address: string; url: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (address)
      QRCode.toDataURL(address, { width: 280, margin: 1, errorCorrectionLevel: 'M' })
        .then((url) => {
          if (active) setQr({ address, url });
        })
        .catch(() => {
          if (active) setError('QR code unavailable. Copy the address instead.');
        });
    return () => {
      active = false;
    };
  }, [address]);
  const image = qr?.address === address ? qr.url : '';
  return (
    <>
      <section className="page-heading">
        <div>
          <h1>Receive USDC.</h1>
          <p>Use the same network on both sides.</p>
        </div>
      </section>
      <section className="card receive-card">
        <h2>{networkLabel}</h2>
        {address ? (
          <>
            <div className="qr-frame">
              {image ? (
                <img
                  src={image}
                  alt={`Wallet address QR code: ${address}`}
                  width={240}
                  height={240}
                />
              ) : (
                <p>{error || 'Generating QR code…'}</p>
              )}
            </div>
            <code className="receive-address">{address}</code>
            <div className="receive-actions">
              <CopyButton value={address} />
              {image && (
                <a href={image} download="uwifin-wallet-qr.png" className="button secondary">
                  <Download size={16} />
                  Save QR
                </a>
              )}
            </div>
            <p className="info-note">
              Only send native USDC on {networkLabel} to this address. Match the network exactly;
              switching networks does not bridge funds.
            </p>
          </>
        ) : (
          <>
            <p>Connect a wallet before receiving funds.</p>
            <Link href="/wallet" className="button primary">
              Connect wallet
            </Link>
          </>
        )}
      </section>
    </>
  );
}
