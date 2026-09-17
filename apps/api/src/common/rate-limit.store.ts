/**
 * Storage and algorithm behind the rate limiter.
 *
 * It lives apart from the guard so the in-process Map can be swapped for a
 * shared store — Redis, most likely — the day OFFCUT runs on more than one API
 * instance, without the guard changing. §4 says the first release is local and
 * single-process, so shipping a Redis dependency now would add an operational
 * requirement to a product whose selling point is that it needs none. Keeping
 * the seam is the cheap half of that trade; taking the dependency is not.
 *
 * `hit` may answer with a promise so a networked store fits the same shape.
 *
 * ---------------------------------------------------------------------------
 * Why two counters and not a log of timestamps
 * ---------------------------------------------------------------------------
 *
 * The obvious sliding window keeps every hit's timestamp and drops the ones that
 * have aged out. It is exact, and it costs one number per hit: bounded by the
 * limit, which sounds small until you read what the limit actually is. The
 * default for an unannotated route is 600 requests per minute, and the guard is
 * registered globally — so the bound is 600 numbers per caller per route, not a
 * handful. Five thousand callers at that depth measured at roughly 35 MB of heap
 * against effectively zero for a counter. A rate limiter that a flood can push
 * into tens of megabytes is a liability during exactly the event it exists for.
 *
 * So this keeps two counters and a window start — three numbers per caller,
 * whatever the limit — and estimates the sliding count by weighting the previous
 * window by how much of it is still in view:
 *
 *   estimate = previous × (fraction of the previous window still inside) + current
 *
 * It is an approximation, and the error is worth stating plainly rather than
 * hiding: it assumes the previous window's hits were spread evenly across it. A
 * caller who front-loaded them is charged slightly too much, one who back-loaded
 * slightly too little. The error is bounded by the previous window's count and
 * disappears entirely once that window rolls out of view. What it does NOT do is
 * the thing a fixed window does, which is let a caller spend the whole limit at
 * the end of one window and the whole limit again at the start of the next —
 * twenty sign-in attempts in a moment on a route advertised as ten per fifteen
 * minutes. That burst is the defect this replaces, and the approximation refuses
 * it correctly.
 */

export interface RateLimitVerdict {
  /** Whether this attempt is admitted. A refused attempt is not recorded. */
  allowed: boolean;
  /**
   * Milliseconds until an attempt would be admitted. Zero when allowed.
   *
   * The store computes this rather than the guard, because only the store knows
   * the shape of its own accounting.
   */
  retryAfterMs: number;
}

export interface RateLimitStore {
  /**
   * Records an attempt against `key` and says whether it is admitted.
   *
   * `now` is supplied rather than read from the clock so the algorithm is
   * testable without mocking time, and so a shared store can settle on one.
   */
  hit(
    key: string,
    windowMs: number,
    limit: number,
    now: number
  ): RateLimitVerdict | Promise<RateLimitVerdict>;

  /** Forgets every caller. Test hook; on a shared store, wipe with care. */
  clear(): void;
}

/**
 * One entry per caller-and-route: three numbers, regardless of the limit.
 *
 * `deadAt` exists only so the sweep can drop entries without knowing which
 * window each route asked for. Once both windows have rolled past, the entry
 * contributes nothing and may be forgotten.
 */
interface WindowState {
  /** Start of the current window. */
  start: number;
  /** Hits recorded inside the current window. */
  current: number;
  /** Hits recorded in the window immediately before it. */
  previous: number;
  /** After this instant the entry is provably empty. */
  deadAt: number;
}

/**
 * How often a full sweep may run, and how many callers may be tracked at once.
 *
 * The previous implementation swept on every request once the map passed a
 * threshold, and only removed entries that had already expired. Under a flood of
 * distinct callers — trivially produced, since an unauthenticated caller is
 * keyed by address — nothing was expired yet, so every single request paid a
 * full scan of a map that kept growing: quadratic, and unbounded in memory. Both
 * halves are fixed here, by rate-limiting the sweep itself and by capping the
 * map.
 */
const SWEEP_INTERVAL_MS = 10_000;
const MAX_TRACKED_CALLERS = 20_000;

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, WindowState>();
  private lastSweep = 0;
  private sweeps = 0;

  hit(key: string, windowMs: number, limit: number, now: number): RateLimitVerdict {
    this.maintain(now);

    const state = this.roll(this.windows.get(key), windowMs, now);

    const elapsed = now - state.start;
    // How much of the previous window is still inside the sliding view.
    const overlap = (windowMs - elapsed) / windowMs;
    const estimate = state.previous * overlap + state.current;

    if (estimate + 1 > limit) {
      // Refused, and deliberately not recorded: a caller who keeps hammering
      // must not push their own release further out with every rejected try.
      this.windows.set(key, state);
      return { allowed: false, retryAfterMs: releaseIn(state, windowMs, limit, now) };
    }

    state.current += 1;
    state.deadAt = state.start + 2 * windowMs;
    this.windows.set(key, state);

    return { allowed: true, retryAfterMs: 0 };
  }

  clear(): void {
    this.windows.clear();
    this.lastSweep = 0;
    this.sweeps = 0;
  }

  /**
   * Advances a caller's windows to the present.
   *
   * Two steps back is as far as history reaches: anything older contributes
   * nothing to the estimate, so it is thrown away rather than carried.
   */
  private roll(state: WindowState | undefined, windowMs: number, now: number): WindowState {
    if (!state) {
      return { start: now, current: 0, previous: 0, deadAt: now + 2 * windowMs };
    }

    const elapsed = now - state.start;

    if (elapsed >= 2 * windowMs) {
      state.start = now;
      state.current = 0;
      state.previous = 0;
    } else if (elapsed >= windowMs) {
      state.start += windowMs;
      state.previous = state.current;
      state.current = 0;
    }

    return state;
  }

  /**
   * Keeps the map bounded in both size and cost.
   *
   * Sweeping is time-limited rather than size-limited so no single request can
   * be made to pay for a full scan. When the cap is still exceeded afterwards,
   * the callers closest to being forgotten are evicted first — which under a
   * flood means the idle ones, since an active caller's `deadAt` keeps moving
   * forward.
   *
   * An evicted caller gets a fresh budget. That is the deliberate trade and it
   * is worth being honest about: bounded memory during a flood is worth more
   * than exact accounting during a flood, and the alternative is a limiter that
   * exhausts the process it was protecting.
   */
  private maintain(now: number): void {
    // `<` and not `<=`: at exactly the cap the incoming caller would push it
    // over, so that is already the moment to act rather than one hit too late.
    if (now - this.lastSweep < SWEEP_INTERVAL_MS && this.windows.size < MAX_TRACKED_CALLERS) {
      return;
    }
    this.lastSweep = now;
    this.sweeps += 1;

    for (const [key, state] of this.windows) {
      if (state.deadAt <= now) this.windows.delete(key);
    }

    // Down to one BELOW the cap, not to the cap. Maintenance runs before the
    // caller that triggered it is recorded, and that caller is about to take a
    // slot — trimming to exactly the cap leaves the map one over it on every
    // hit, which is a cap that never actually holds.
    if (this.windows.size < MAX_TRACKED_CALLERS) return;

    const byDeadline = [...this.windows.entries()].sort((a, b) => a[1].deadAt - b[1].deadAt);
    const excess = this.windows.size - (MAX_TRACKED_CALLERS - 1);
    for (let index = 0; index < excess; index += 1) {
      this.windows.delete(byDeadline[index]![0]);
    }
  }

  /** Diagnostic: how many callers are tracked. */
  size(): number {
    return this.windows.size;
  }

  /**
   * Diagnostic: how many full passes over the map have happened.
   *
   * Exposed because the cost of the sweep is not otherwise observable, and it
   * was the previous implementation's real defect — a scan on every request,
   * over a map that only grew. Counting the passes is how a test can say so.
   */
  sweepCount(): number {
    return this.sweeps;
  }

  /** Diagnostic: the numbers held for one caller. Always three, whatever the limit. */
  stateFor(key: string): WindowState | undefined {
    return this.windows.get(key);
  }
}

/**
 * When the estimate next falls far enough for an attempt to be admitted.
 *
 * Solved rather than guessed, because this number is shown to the caller. The
 * estimate decreases linearly until the window rolls, then linearly again from a
 * new starting point, so there are exactly two cases.
 */
function releaseIn(state: WindowState, windowMs: number, limit: number, now: number): number {
  const elapsed = now - state.start;
  const untilRoll = windowMs - elapsed;
  const room = limit - 1;

  // Case 1: the current window alone is already at the limit. Nothing helps
  // until it becomes the previous window and starts decaying in its turn.
  if (state.current > room) {
    const decay = state.current > 0 ? windowMs * (1 - room / state.current) : 0;
    return Math.max(0, untilRoll + Math.min(windowMs, decay));
  }

  // Case 2: the refusal comes from what is left of the previous window, so the
  // wait is however long that takes to decay out of view.
  if (state.previous > 0) {
    const wait = untilRoll - (windowMs * (room - state.current)) / state.previous;
    return Math.max(0, Math.min(untilRoll, wait));
  }

  return 0;
}
