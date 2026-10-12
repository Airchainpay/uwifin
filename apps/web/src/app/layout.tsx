import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/contexts/AuthContext';
import { FinanceProvider } from '@/contexts/FinanceContext';
import { EmbeddedWalletProvider } from '@/contexts/EmbeddedWalletContext';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  title: { default: 'UwiFin — A little closer to home', template: '%s | UwiFin' },
  description:
    'Padala para sa Pamilya. Manage your wallet, send with confidence, and stay connected to the people you love.',
  icons: { icon: '/icon.svg' },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <EmbeddedWalletProvider>
            <FinanceProvider>{children}</FinanceProvider>
          </EmbeddedWalletProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
