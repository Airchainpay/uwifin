import { NextRequest, NextResponse } from 'next/server';

const COOKIE = 'uwifin_session';
const allowedPaths =
  /^(?:networks\/(?:base|eth-mainnet|solana-mainnet|base-sepolia)\/)?(admin\/(users|transactions|payments|events|errors|assets|networks)(?:\/[a-zA-Z0-9-]+)?|capabilities|auth\/(register|login|logout|me|password|revoke-sessions)|users\/me|wallets(?:\/[a-zA-Z0-9-]+(?:\/balances)?)?|transactions(?:\/[a-zA-Z0-9-]+(?:\/rpc)?)?|payments(?:\/[a-zA-Z0-9-]+)?)$/;

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const requestId = crypto.randomUUID();
  const fail = (code: string, message: string, status: number, id = requestId) =>
    NextResponse.json(
      { error: { code, message, request_id: id } },
      { status, headers: { 'X-Request-Id': id, 'Cache-Control': 'no-store' } },
    );
  const { path } = await context.params;
  const endpoint = path.join('/');
  const logicalEndpoint = endpoint.replace(/^networks\/[^/]+\//, '');
  if (!allowedPaths.test(endpoint)) return fail('NOT_FOUND', 'Endpoint not found.', 404);
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin');
    if (!origin || origin !== (process.env.APP_BASE_URL || request.nextUrl.origin))
      return fail('FORBIDDEN', 'Request origin could not be verified.', 403);
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return fail('INVALID_REQUEST', 'Use JSON for this request.', 415);
  }
  const base = process.env.API_URL;
  if (!base)
    return fail('SERVICE_UNAVAILABLE', 'Account services are temporarily unavailable.', 503);
  const token = request.cookies.get(COOKIE)?.value;
  const publicPath =
    logicalEndpoint === 'auth/login' ||
    logicalEndpoint === 'auth/register' ||
    logicalEndpoint === 'capabilities';
  if (!publicPath && !token) return fail('UNAUTHORIZED', 'Please sign in to continue.', 401);
  try {
    const body = request.method === 'GET' ? undefined : await request.text();
    if (body && new TextEncoder().encode(body).length > 65_536)
      return fail('INVALID_REQUEST', 'Request is too large.', 413);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const key = request.headers.get('idempotency-key');
    if (key) headers['Idempotency-Key'] = key;
    const response = await fetch(
      `${base.replace(/\/$/, '')}/api/v1/${endpoint}${request.nextUrl.search}`,
      {
        method: request.method,
        headers,
        body,
        cache: 'no-store',
        signal: AbortSignal.timeout(25_000),
        redirect: 'error',
      },
    );
    const data = await response.json();
    const session = data.session_id;
    delete data.session_id;
    // Provider or infrastructure messages never cross the browser boundary.
    if (response.status >= 500)
      return fail(
        'SERVICE_UNAVAILABLE',
        'This service is temporarily unavailable. Please try again.',
        response.status,
        response.headers.get('x-request-id') || requestId,
      );
    const result = NextResponse.json(data, {
      status: response.status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Request-Id': response.headers.get('x-request-id') || requestId,
      },
    });
    if (publicPath && response.ok && typeof session === 'string') {
      result.cookies.set(COOKIE, session, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24,
      });
    }
    if ((logicalEndpoint === 'auth/logout' && response.ok) || response.status === 401)
      result.cookies.delete(COOKIE);
    return result;
  } catch {
    return fail(
      'SERVICE_UNAVAILABLE',
      'This service is temporarily unavailable. Please try again.',
      503,
    );
  }
}
export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
