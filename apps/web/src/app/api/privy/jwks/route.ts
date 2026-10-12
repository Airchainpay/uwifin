import 'server-only';
import { NextResponse } from 'next/server';
import { walletAuthJwks } from '@/lib/server/privy-auth';

export const runtime = 'nodejs';

export async function GET() {
  try {
    return NextResponse.json(walletAuthJwks(), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json(
      { error: { message: 'Wallet setup is temporarily unavailable.' } },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}
