import 'server-only';
import { NextRequest } from 'next/server';
import { walletTokenResponse } from '@/lib/server/privy-token';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return walletTokenResponse(request, request.cookies.get('uwifin_session')?.value);
}
