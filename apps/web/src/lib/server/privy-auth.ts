import { createPrivateKey, createPublicKey } from 'node:crypto';
import { SignJWT } from 'jose';

export const WALLET_TOKEN_SECONDS = 300;

// This module is used only by server routes. The signing key never reaches Privy or the browser.
export function walletAuthConfig() {
  const pem = process.env.PRIVY_JWT_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const issuer = process.env.APP_BASE_URL;
  if (!pem || !appId || !issuer) throw new Error('Wallet authentication is not configured.');
  const url = new URL(issuer);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(
        process.env.APP_ENV === 'development' &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(url.hostname)
      ))
  )
    throw new Error('Wallet authentication requires a trusted application origin.');
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new Error('Wallet authentication requires a P-256 signing key.');
  return { key, appId, issuer: url.origin, kid: process.env.PRIVY_JWT_KEY_ID || 'uwifin-1' };
}

export function walletAuthJwks() {
  const { key, kid } = walletAuthConfig();
  const publicKey = createPublicKey(key).export({ format: 'jwk' });
  return { keys: [{ ...publicKey, kid, alg: 'ES256', use: 'sig' }] };
}

export async function issueWalletToken(userId: string) {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(userId)) throw new Error('Invalid account identity.');
  const { key, appId, issuer, kid } = walletAuthConfig();
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid })
    .setSubject(userId)
    .setIssuer(issuer)
    .setAudience(appId)
    .setIssuedAt(now)
    .setExpirationTime(now + WALLET_TOKEN_SECONDS)
    .setJti(crypto.randomUUID())
    .sign(key);
  return { token, user_id: userId, expires_at: now + WALLET_TOKEN_SECONDS };
}
