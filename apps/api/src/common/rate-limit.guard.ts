/**
 * Request rate limiting.
 *
 * A sliding window held in process memory, behind the store seam in
 * ./rate-limit.store so a shared backend can replace the Map without this file
 * changing. §4 says the first release is local and single-process, so a Redis
 * dependency would add an operational requirement to a product whose selling
 * point is that it needs none.
 *
 * The limitation is real and stated rather than glossed over: run more than one
 * API instance and each keeps its own counters, so the effective limit
 * multiplies by the instance count. A multi-instance deployment needs a shared
 * store here — which is what the store interface is for.
 *
 * Buckets are keyed by credential where one exists and by address otherwise, so
 * a shared office IP cannot lock out everyone behind it once they are signed in.
 */

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { OffcutError } from '@offcut/core';
import { hashApiKey } from '@offcut/core';
import { MemoryRateLimitStore } from './rate-limit.store';
import type { RateLimitStore, RateLimitVerdict } from './rate-limit.store';

export type { RateLimitStore, RateLimitVerdict } from './rate-limit.store';
export { MemoryRateLimitStore } from './rate-limit.store';

export interface RateLimitOptions {
  /** Requests permitted inside one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Shown to the caller when the limit is hit. */
  label?: string;
}

export const RATE_LIMIT_KEY = 'offcut:rate-limit';

export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);

/**
 * Provide this token to swap the store — a Redis-backed one, say. Left
 * unprovided the guard uses the process-local default below, which is what a
 * single-instance install wants and what the suites exercise.
 */
export const RATE_LIMIT_STORE = 'offcut:rate-limit-store';

/**
 * Defaults when a route says nothing. Generous: reads dominate console traffic
 * and throttling them would only make the UI feel broken.
 */
const DEFAULT_LIMIT: RateLimitOptions = { limit: 600, windowMs: 60_000, label: 'requests' };

const defaultStore = new MemoryRateLimitStore();

/**
 * Every store a guard has actually used.
 *
 * `resetRateLimits()` used to clear only `defaultStore`, which was fine until
 * the moment anyone exercised the seam this file exists to provide: with a store
 * injected through RATE_LIMIT_STORE the test hook became a silent no-op, and a
 * budget spent by one test leaked into the next as an unexplained flake. A hook
 * that quietly stops working is worse than no hook, so it now clears whatever is
 * really in use.
 */
const activeStores = new Set<RateLimitStore>([defaultStore]);

/**
 * Whether to believe `X-Forwarded-For`.
 *
 * Off by default, and that default is the security-relevant half. The header is
 * caller-supplied: trusting it unconditionally lets anyone mint a fresh identity
 * per request simply by varying it, which defeats the limiter entirely on every
 * unauthenticated route — sign-in among them. It is only meaningful when a proxy
 * the operator controls is known to overwrite it, so it takes an explicit
 * OFFCUT_TRUST_PROXY=1 to say that is the case.
 */
function trustsProxyHeader(): boolean {
  return process.env.OFFCUT_TRUST_PROXY === '1';
}

function callerKey(request: Request): string {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    // Hashed, so a raw key never sits in the rate-limit map.
    return `key:${hashApiKey(header.slice('Bearer '.length)).slice(0, 32)}`;
  }

  const cookie = (request.cookies as Record<string, string> | undefined)?.offcut_session;
  if (cookie) return `session:${cookie.slice(-32)}`;

  if (trustsProxyHeader()) {
    const forwarded = request.headers['x-forwarded-for'];
    const claimed = Array.isArray(forwarded) ? forwarded[0] : (forwarded ?? '').split(',')[0]?.trim();
    if (claimed) return `ip:${claimed}`;
  }

  // The socket address cannot be forged by the request body or its headers.
  return `ip:${request.ip ?? request.socket?.remoteAddress ?? 'unknown'}`;
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === 'function';
}

/** Turns the store's verdict into a pass, or into the 429 every surface maps. */
function decide(verdict: RateLimitVerdict, options: RateLimitOptions): boolean {
  if (verdict.allowed) return true;

  // At least a second: a caller told to retry in 0s would come straight back.
  const retryAfter = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
  throw new OffcutError(
    'VALIDATION',
    `Too many ${options.label ?? 'requests'}. Try again in ${retryAfter}s.`,
    { status: 429, details: { retryAfter, limit: options.limit } }
  );
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly store: RateLimitStore;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Optional() @Inject(RATE_LIMIT_STORE) store: RateLimitStore | null = null
  ) {
    this.store = store ?? defaultStore;
    activeStores.add(this.store);
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const options =
      this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_LIMIT;

    const request = context.switchToHttp().getRequest<Request>();
    const now = Date.now();

    // Scoped per handler: a burst of writes must not exhaust the login budget.
    const key = `${context.getClass().name}.${context.getHandler().name}:${callerKey(request)}`;
    const verdict = this.store.hit(key, options.windowMs, options.limit, now);

    // A networked store answers asynchronously; Nest awaits either shape, and so
    // must anything testing this. A caller that forgets to await sees a pending
    // promise, which is truthy — so a refusal would look like a pass.
    return isPromise(verdict)
      ? verdict.then((settled) => decide(settled, options))
      : decide(verdict, options);
  }
}

/** Test hook: clears every counter so suites do not leak limits into each other. */
export function resetRateLimits(): void {
  for (const store of activeStores) store.clear();
}
