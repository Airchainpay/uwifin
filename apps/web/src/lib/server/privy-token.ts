import { issueWalletToken } from './privy-auth.ts';

export async function walletTokenResponse(request: Request, session: string | undefined) {
  const fail = (message: string, status: number) =>
    Response.json({ error: { message } }, { status, headers: { 'Cache-Control': 'no-store' } });
  const origin = process.env.APP_BASE_URL;
  try {
    if (!origin || request.headers.get('origin') !== new URL(origin).origin)
      return fail('Request origin could not be verified.', 403);
  } catch {
    return fail('Wallet setup is temporarily unavailable.', 503);
  }
  if (!session) return fail('Please sign in to continue.', 401);
  const api = process.env.API_URL;
  if (!api) return fail('Wallet setup is temporarily unavailable.', 503);
  try {
    // Revalidate the HttpOnly session for every token. Never accept a user ID from the caller.
    const response = await fetch(`${api.replace(/\/$/, '')}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${session}` },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) return fail('Please sign in again.', 401);
    if (!response.ok) return fail('Wallet setup is temporarily unavailable.', 503);
    const user = await response.json();
    if (typeof user.id !== 'string') return fail('Wallet setup is temporarily unavailable.', 503);
    return Response.json(await issueWalletToken(user.id), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return fail('Wallet setup is temporarily unavailable.', 503);
  }
}
