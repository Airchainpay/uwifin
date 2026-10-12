import { PublicKey } from '@solana/web3.js';

/** USDC amounts are represented as strings of atomic units (six decimals). */
export function parseAmount(value: string): bigint {
  if (!/^\d{1,18}(\.\d{1,6})?$/.test(value))
    throw new Error('Enter a valid amount with up to 6 decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount <= 0n || amount > 9_223_372_036_854_775_807n)
    throw new Error('Enter an amount greater than zero and within the supported limit.');
  return amount;
}

export function decimalAmount(atomic: string | bigint): string {
  const amount = BigInt(atomic);
  return `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, '0')}`;
}

export function money(atomic: string | bigint, symbol = '$'): string {
  const amount = BigInt(atomic);
  const whole = (amount / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${symbol}${whole}.${((amount % 1_000_000n) / 10_000n).toString().padStart(2, '0')}`;
}

export function validateAddress(address: string, network?: string): boolean {
  if (network === 'solana-mainnet') {
    try {
      const key = new PublicKey(address);
      return (
        key.toBase58() === address &&
        !key.equals(PublicKey.default) &&
        PublicKey.isOnCurve(key.toBytes())
      );
    } catch {
      return false;
    }
  }
  return /^0x[0-9a-fA-F]{40}$/.test(address) && !/^0x0{40}$/.test(address);
}

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
