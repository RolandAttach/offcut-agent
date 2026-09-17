/**
 * Rate limiter tests.
 *
 * The HTTP suite proves a limited route eventually says 429. This one proves the
 * things that are easy to get wrong and invisible from outside: the shape of the
 * window, what the limiter costs under a flood, and whether the seam it exposes
 * actually works.
 *
 * A fixed-window counter passes "eventually says 429" while still letting a
 * caller spend the whole budget just before the window rolls and the whole
 * budget again just after it — twenty sign-in attempts in two milliseconds on a
 * route advertised as ten per fifteen minutes. That is the defect the sliding
 * window replaces, and the first test here is the one that catches it.
 *
 * Three of these exist because an adversarial review of the first attempt found
 * them missing, and each corresponds to a real defect that shipped: memory that
 * grew with the limit rather than staying constant, a map that could not be
 * bounded and was rescanned on every request, and a test hook that silently
 * stopped working the moment a custom store was provided.
 *
 * Time is driven with fake timers rather than waited on, so the boundary can be
 * landed on exactly and the suite stays fast.
 */

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { OffcutError } from '@offcut/core';
import {
  RateLimitGuard,
  resetRateLimits,
  type RateLimitOptions,
  type RateLimitStore,
  type RateLimitVerdict,
} from '../common/rate-limit.guard';
import { MemoryRateLimitStore } from '../common/rate-limit.store';

/** The real sign-in budget, because that is the route the defect mattered on. */
const SIGN_IN: RateLimitOptions = { limit: 10, windowMs: 15 * 60_000, label: 'sign-in attempts' };

const START = Date.UTC(2026, 0, 1, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
  resetRateLimits();
  delete process.env.OFFCUT_TRUST_PROXY;
});

function guardFor(options: RateLimitOptions, store?: RateLimitStore): RateLimitGuard {
  const reflector = { getAllAndOverride: () => options } as unknown as Reflector;
  return new RateLimitGuard(reflector, store ?? null);
}

/** `route` is written Class.handler, matching how the guard keys its buckets. */
function contextFor(
  route: string,
  caller: { ip?: string; apiKey?: string; forwardedFor?: string } = {}
): ExecutionContext {
  const [className, handlerName] = route.split('.');

  const headers: Record<string, string> = {};
  if (caller.apiKey) headers.authorization = `Bearer ${caller.apiKey}`;
  if (caller.forwardedFor) headers['x-forwarded-for'] = caller.forwardedFor;

  const request = {
    headers,
    cookies: {},
    ip: caller.ip ?? '198.51.100.4',
    socket: { remoteAddress: caller.ip ?? '198.51.100.4' },
  };

  return {
    getClass: () => ({ name: className }),
    getHandler: () => ({ name: handlerName }),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * One attempt, awaited.
 *
 * The await is not decoration. A store may answer asynchronously — that is the
 * entire point of the seam — and a helper that did not await would receive a
 * pending promise, which is truthy, and would score every single refusal as a
 * pass. The first version of this file had exactly that bug and its nine tests
 * would all have gone green against a store that refused everything.
 */
async function attempt(guard: RateLimitGuard, context: ExecutionContext): Promise<boolean> {
  try {
    return await guard.canActivate(context);
  } catch (error) {
    if (error instanceof OffcutError && error.status === 429) return false;
    throw error;
  }
}

/** How many of `count` attempts got through. */
async function allowed(
  guard: RateLimitGuard,
  context: ExecutionContext,
  count: number
): Promise<number> {
  let through = 0;
  for (let index = 0; index < count; index += 1) {
    if (await attempt(guard, context)) through += 1;
  }
  return through;
}

/**
 * The error from one attempt, or null if it was admitted.
 *
 * Written as try/catch rather than `.catch()` because the default store answers
 * synchronously, so the guard THROWS rather than rejecting — there is no promise
 * to attach a handler to. An async store rejects instead, and awaiting inside
 * the try covers both.
 */
async function refusal(
  guard: RateLimitGuard,
  context: ExecutionContext
): Promise<OffcutError | null> {
  try {
    await guard.canActivate(context);
    return null;
  } catch (error) {
    if (error instanceof OffcutError) return error;
    throw error;
  }
}

// ---------------------------------------------------------------------------
describe('The window slides', () => {
  it('refuses the boundary burst a fixed window let through', async () => {
    const guard = guardFor(SIGN_IN);
    const context = contextFor('AuthController.signIn');

    // The window has to be ESTABLISHED before it can be straddled: a window
    // that begins at the first attempt is never crossed by a burst that starts
    // at the first attempt, and a test that skips this passes against a fixed
    // window too. This one opens the window here...
    expect(await attempt(guard, context)).toBe(true);

    // ...spends the rest of the budget at the very end of it...
    vi.setSystemTime(START + SIGN_IN.windowMs - 1);
    expect(await allowed(guard, context, SIGN_IN.limit)).toBe(SIGN_IN.limit - 1);

    // ...and then steps just past the boundary and asks for the whole budget
    // again. A fixed-window counter resets here and lets all ten through —
    // nineteen sign-in attempts inside two milliseconds on a route advertised
    // as ten per fifteen minutes. A sliding window still sees the first ten.
    vi.setSystemTime(START + SIGN_IN.windowMs + 1);
    expect(await allowed(guard, context, SIGN_IN.limit)).toBe(0);
  });

  it('returns capacity gradually rather than all at once', async () => {
    const guard = guardFor(SIGN_IN);
    const context = contextFor('AuthController.signIn');

    expect(await allowed(guard, context, SIGN_IN.limit)).toBe(SIGN_IN.limit);

    // Half a window later, roughly half the budget should be back — not none,
    // and not all of it.
    vi.setSystemTime(START + SIGN_IN.windowMs * 1.5);
    const halfway = await allowed(guard, context, SIGN_IN.limit);

    expect(halfway).toBeGreaterThan(0);
    expect(halfway).toBeLessThan(SIGN_IN.limit);
  });

  it('gives the full budget back once the history has rolled out of view', async () => {
    const guard = guardFor(SIGN_IN);
    const context = contextFor('AuthController.signIn');

    expect(await allowed(guard, context, SIGN_IN.limit)).toBe(SIGN_IN.limit);

    vi.setSystemTime(START + SIGN_IN.windowMs * 2 + 1);
    expect(await allowed(guard, context, SIGN_IN.limit)).toBe(SIGN_IN.limit);
  });

  it('admits exactly the limit and refuses the next one', async () => {
    const guard = guardFor(SIGN_IN);
    const context = contextFor('AuthController.signIn');

    expect(await allowed(guard, context, SIGN_IN.limit)).toBe(SIGN_IN.limit);
    expect(await attempt(guard, context)).toBe(false);
  });

  it('does not let a refused caller push their own release further out', async () => {
    const guard = guardFor(SIGN_IN);
    const context = contextFor('AuthController.signIn');

    await allowed(guard, context, SIGN_IN.limit);

    const first = await refusal(guard, context);

    // Hammer the door for a while, then ask again. The answer must have gone
    // DOWN with the passage of time, not up with the number of attempts.
    vi.setSystemTime(START + 60_000);
    await allowed(guard, context, 50);

    const later = await refusal(guard, context);

    expect(first).not.toBeNull();
    expect(later).not.toBeNull();
    expect(later!.details.retryAfter as number).toBeLessThan(first!.details.retryAfter as number);
  });
});

// ---------------------------------------------------------------------------
describe('What it costs to track a caller', () => {
  it('holds a constant amount per caller, whatever the limit is', () => {
    // The defect this replaces stored one timestamp per hit. The global default
    // limit is 600 requests a minute, so a single caller on a single route cost
    // 600 numbers — and the guard is registered globally. Under a flood that is
    // tens of megabytes, during exactly the event the limiter exists for.
    const store = new MemoryRateLimitStore();
    const generous = { limit: 600, windowMs: 60_000 };

    for (let index = 0; index < generous.limit; index += 1) {
      store.hit('one-caller', generous.windowMs, generous.limit, START + index);
    }

    const state = store.stateFor('one-caller');

    expect(state).toBeDefined();
    expect(Object.keys(state!).sort()).toEqual(['current', 'deadAt', 'previous', 'start']);
    expect(state!.current).toBe(generous.limit);
  });

  it('caps how many callers it tracks, however many turn up', () => {
    const store = new MemoryRateLimitStore();

    // Far past the cap, all of them live — none has had time to expire, which is
    // precisely the case the previous sweep could not handle.
    for (let index = 0; index < 60_000; index += 1) {
      store.hit(`flood-${index}`, 60_000, 10, START + index);
    }

    expect(store.size()).toBeLessThanOrEqual(20_000);
  });

  it('does not rescan the whole map on every request', () => {
    const store = new MemoryRateLimitStore();

    // The previous implementation scanned every tracked caller on every hit once
    // the map passed a size threshold — quadratic, and worst exactly when it
    // matters. Sweeping is now bounded by time instead, so ten thousand callers
    // arriving inside one interval cost one pass between them, not ten thousand.
    for (let index = 0; index < 10_000; index += 1) {
      store.hit(`flood-${index}`, 60_000, 10, START + index);
    }

    expect(store.sweepCount()).toBeLessThanOrEqual(2);
  });

  it('still sweeps eventually, so dead callers are not kept forever', () => {
    const store = new MemoryRateLimitStore();

    for (let index = 0; index < 500; index += 1) {
      store.hit(`caller-${index}`, 60_000, 10, START);
    }
    expect(store.size()).toBe(500);

    // Long past every one of those windows: one more request is enough to clear
    // them, because the interval has elapsed.
    store.hit('someone-new', 60_000, 10, START + 10 * 60_000);

    expect(store.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('Who a caller is', () => {
  it('limits per handler, not across the whole API', async () => {
    const guard = guardFor(SIGN_IN);

    expect(await allowed(guard, contextFor('AuthController.signIn'), SIGN_IN.limit)).toBe(
      SIGN_IN.limit
    );

    // A different route has its own budget, or a burst of writes would lock the
    // user out of signing in.
    expect(await attempt(guard, contextFor('AuthController.signUp'))).toBe(true);
  });

  it('separates callers by credential', async () => {
    const guard = guardFor(SIGN_IN);
    const route = 'MemoryController.add';

    await allowed(guard, contextFor(route, { apiKey: 'offcut_sk_first_agent_key' }), SIGN_IN.limit);

    expect(await attempt(guard, contextFor(route, { apiKey: 'offcut_sk_second_agent' }))).toBe(true);
  });

  it('ignores a forged X-Forwarded-For unless a proxy is declared', async () => {
    // The header is caller-supplied. Believing it unconditionally means anyone
    // can mint a fresh identity per request and the limiter stops existing on
    // every unauthenticated route — sign-in among them.
    const guard = guardFor(SIGN_IN);
    const route = 'AuthController.signIn';

    for (let index = 0; index < SIGN_IN.limit; index += 1) {
      await attempt(guard, contextFor(route, { forwardedFor: `203.0.113.${index}` }));
    }

    expect(await attempt(guard, contextFor(route, { forwardedFor: '203.0.113.250' }))).toBe(false);
  });

  it('believes the header when the operator says a proxy sets it', async () => {
    process.env.OFFCUT_TRUST_PROXY = '1';

    const guard = guardFor(SIGN_IN);
    const route = 'AuthController.signIn';

    await allowed(guard, contextFor(route, { forwardedFor: '203.0.113.1' }), SIGN_IN.limit);

    // A genuinely different client behind the same proxy must not be punished
    // for the first one's traffic.
    expect(await attempt(guard, contextFor(route, { forwardedFor: '203.0.113.2' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('The refusal itself', () => {
  it('is the 429 every surface maps, carrying retryAfter and limit', async () => {
    const guard = guardFor(SIGN_IN);
    const context = contextFor('AuthController.signIn');

    await allowed(guard, context, SIGN_IN.limit);

    const error = await refusal(guard, context);

    expect(error).not.toBeNull();
    expect(error!.status).toBe(429);
    expect(error!.message).toContain('sign-in attempts');
    expect(error!.details.retryAfter).toBeGreaterThan(0);
    expect(error!.details.limit).toBe(SIGN_IN.limit);
  });

  it('never tells a caller to come back in zero seconds', async () => {
    const guard = guardFor(SIGN_IN);
    const context = contextFor('AuthController.signIn');

    await allowed(guard, context, SIGN_IN.limit);

    // One millisecond before the history clears, the honest answer rounds to
    // zero — and a caller told to retry immediately simply comes straight back.
    vi.setSystemTime(START + SIGN_IN.windowMs * 2 - 1);

    const error = await refusal(guard, context);

    // Either it was admitted, or it was refused with a wait a human can act on.
    if (error) expect(error.details.retryAfter as number).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
describe('The pluggable store', () => {
  /** A store that answers asynchronously, as a networked one would. */
  class AsyncStore implements RateLimitStore {
    cleared = 0;
    constructor(private readonly answer: RateLimitVerdict) {}

    async hit(): Promise<RateLimitVerdict> {
      return this.answer;
    }

    clear(): void {
      this.cleared += 1;
    }
  }

  it('refuses correctly when the store answers asynchronously', async () => {
    const guard = guardFor(SIGN_IN, new AsyncStore({ allowed: false, retryAfterMs: 30_000 }));

    const error = await guard
      .canActivate(contextFor('AuthController.signIn'))
      .catch((caught: unknown) => caught);

    // The bug this guards against is subtle: an un-awaited promise is truthy, so
    // a refusal from an async store reads as a pass to anything that forgets.
    expect(error).toBeInstanceOf(OffcutError);
    expect((error as OffcutError).status).toBe(429);
    expect((error as OffcutError).details.retryAfter).toBe(30);
  });

  it('admits correctly when the store answers asynchronously', async () => {
    const guard = guardFor(SIGN_IN, new AsyncStore({ allowed: true, retryAfterMs: 0 }));

    await expect(guard.canActivate(contextFor('AuthController.signIn'))).resolves.toBe(true);
  });

  it('is what the test hook actually clears', async () => {
    // resetRateLimits() used to clear only the default store, so providing one
    // through RATE_LIMIT_STORE turned the hook into a silent no-op and let one
    // test's spent budget leak into the next.
    const injected = new AsyncStore({ allowed: true, retryAfterMs: 0 });
    guardFor(SIGN_IN, injected);

    resetRateLimits();

    expect(injected.cleared).toBeGreaterThan(0);
  });
});
