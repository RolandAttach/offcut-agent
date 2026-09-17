/**
 * Runtime configuration.
 *
 * Everything has a working default so `pnpm setup && pnpm dev` runs on a clean
 * machine with no .env file - SS4's "the first release is local" is only true if
 * local actually means zero configuration.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

/**
 * The authority of an origin - "localhost:3000", "console.example.com".
 *
 * A Sign-In-With-Ethereum message names a domain in exactly this form, and a
 * wallet shows it to the person signing. Deriving it from WEB_ORIGIN rather
 * than reading the request's Host header is the point: Host is whatever the
 * caller sent, so trusting it would let a phishing site collect a signature for
 * its own domain and spend it here. This is the same value the CORS allow-list
 * is built from, so one variable configures both doors.
 */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    // A malformed WEB_ORIGIN must not take the server down at import time: CORS
    // already falls back to refusing everything, and so does this.
    return '';
  }
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  /**
   * The interface to bind. Default 0.0.0.0, because a container gets its own
   * network namespace and binding anything narrower makes it unreachable from
   * the compose network.
   *
   * On the bare-metal deploy it is set to 127.0.0.1: there the API shares a
   * public box with other people's sites, and a default bind would hand the
   * whole memory store to anyone who scanned port 4000. nginx reaches it over
   * loopback, which is the only path that should exist.
   */
  host: process.env.OFFCUT_API_HOST ?? '0.0.0.0',
  webOrigin: WEB_ORIGIN,
  webHost: hostOf(WEB_ORIGIN),
  sessionCookie: 'offcut_session',
  sessionMaxAgeMs: 1000 * 60 * 60 * 24 * 30,
  /**
   * Carries one Sign-In-With-Ethereum nonce between the two halves of a
   * sign-in. Short-lived, and signed so no nonce has to be stored before it is
   * presented - but the single use is a row written when it IS presented, not
   * this cookie. Clearing a cookie asks a browser to forget; it does not stop
   * anyone else from sending the same value again. See auth/auth.controller.ts.
   */
  siweCookie: 'offcut_siwe',
  siweNonceMaxAgeMs: 5 * 60_000,
  isProduction: process.env.NODE_ENV === 'production',
};

/**
 * The session-signing secret.
 *
 * Read from the environment in production. In development it is generated once
 * and written beside the database, so restarting the API does not silently log
 * everyone out - a papercut that makes local work feel broken when it is not.
 */
export function sessionSecret(): string {
  if (process.env.OFFCUT_JWT_SECRET) return process.env.OFFCUT_JWT_SECRET;

  if (config.isProduction) {
    throw new Error('OFFCUT_JWT_SECRET must be set in production.');
  }

  const dir = path.resolve(__dirname, '..', '..', '.data');
  const file = path.join(dir, 'session-secret');

  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();

  fs.mkdirSync(dir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, 'utf8');
  return secret;
}
