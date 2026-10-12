const explorers: Record<string, string> = {
  base: 'https://basescan.org/tx/',
  'eth-mainnet': 'https://etherscan.io/tx/',
  'solana-mainnet': 'https://solscan.io/tx/',
  'base-sepolia': 'https://sepolia.basescan.org/tx/',
};
export function transactionUrl(network: string, hash: string): string | undefined {
  const explorer = explorers[network];
  return explorer ? `${explorer}${encodeURIComponent(hash)}` : undefined;
}
