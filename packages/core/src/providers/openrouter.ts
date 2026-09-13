/**
 * The OpenRouter integration — the "supported integration" the brief requires.
 *
 * The brief pays for CONFIRMED spend, and this file is what confirming means:
 * one read-only question to OpenRouter about one generation, answered against
 * the key that paid for it. An agent's own report is never money; this answer
 * is. Everything here exists to make that answer either trustworthy or absent,
 * and never approximately right.
 *
 * ---------------------------------------------------------------------------
 * The distinction this file exists to get right
 * ---------------------------------------------------------------------------
 *
 * There are exactly two outcomes, and confusing them is the worst bug this
 * package can have:
 *
 *   null   OpenRouter says it has no such generation. The report is REJECTED:
 *          somebody reported an id that was never charged.
 *
 *   throw  We could not get an answer — network, 5xx, rate limit, a revoked
 *          key, a body we do not recognise. The report stays PENDING and is
 *          asked about again later.
 *
 * Only 404 returns null. Everything else throws, including the cases that look
 * like a client error, because the cost of waiting is a delay and the cost of
 * being wrong is deleting spend somebody actually paid for. A 401 is the
 * sharpest example: an owner who rotates their OpenRouter key would otherwise
 * have every pending report destroyed by their own key rotation.
 *
 * ---------------------------------------------------------------------------
 * The response shape
 * ---------------------------------------------------------------------------
 *
 * GET /api/v1/generation?id=... answers { data: { ... } }, where the fields
 * this file reads are:
 *
 *   total_cost                 number, USD — what OpenRouter charged
 *   usage                      number, USD — documented as the same amount
 *   native_tokens_prompt       integer, the provider's own count
 *   native_tokens_completion   integer
 *   tokens_prompt              integer, OpenRouter's normalised count
 *   tokens_completion          integer
 *
 * Cost is read strictly: no number, no payment, and no payment means the row
 * stays pending rather than being settled at zero. Tokens are read leniently —
 * see readTokens.
 */

import type { Db } from '../db';
import { decryptSecret } from '../secrets';
import type { UsageVerifier, UsageVerifierSource, VerifiedUsage } from '../usage';

const GENERATION_URL = 'https://openrouter.ai/api/v1/generation';
const KEY_URL = 'https://openrouter.ai/api/v1/key';

/**
 * Short, because verification is sequential and the publisher runs on a
 * ten-minute cycle: a batch that spends a minute per row never finishes. A
 * request that times out throws, so nothing is lost by cutting it short.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Micros that still fit `ModelUsage.verifiedCostMicros`, a Prisma Int.
 *
 * About $2,147 for ONE generation — orders of magnitude above the most
 * expensive request anyone can make. A number past this is not an expensive
 * generation, it is a misread field or a changed unit, and it is treated as
 * unverifiable so a person notices rather than as money so a column overflows.
 */
const MAX_COST_MICROS = 2_147_483_647;

/** Guards `10n ** huge` against a crafted exponent in a response body. */
const MAX_EXPONENT = 1000;

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * USD to integer millionths of a dollar, without arithmetic on a float.
 *
 * `0.0015 * 1_000_000` is 1500.0000000000002 in IEEE 754, and the same class of
 * error at other magnitudes rounds the wrong way. Money here is integers all
 * the way down (house rule), so the value is shifted as a decimal STRING using
 * BigInt: the digits move, nothing is multiplied, and the result is exact.
 *
 * Rounding happens only below a millionth of a dollar, where the unit itself
 * ends, and it is half-up — the same direction for everyone, which is the only
 * property that matters when a fixed pool is divided by ratio.
 *
 * Returns null for anything that is not a usable non-negative amount. The
 * caller turns that into a throw, because a cost we cannot read is a cost we
 * have not confirmed.
 */
export function usdToMicros(raw: unknown): number | null {
  const text =
    typeof raw === 'number'
      ? Number.isFinite(raw)
        ? String(raw)
        : ''
      : typeof raw === 'string'
        ? raw.trim()
        : '';

  const match = DECIMAL.exec(text);
  if (!match) return null;

  const [, sign, whole, fraction = '', exponent = '0'] = match;

  const power = Number(exponent);
  if (!Number.isFinite(power) || Math.abs(power) > MAX_EXPONENT) return null;

  // value = digits * 10^scale, so micros = digits * 10^(scale + 6).
  const digits = BigInt(whole + fraction);
  const shift = power - fraction.length + 6;

  // A negative charge is not something OpenRouter reports. Reading one means
  // the field is not what we think it is, so nothing is paid on it. A signed
  // zero is let through: it is zero, and zero is a real cost for a free model.
  if (sign === '-' && digits !== 0n) return null;

  let micros: bigint;
  if (shift >= 0) {
    micros = digits * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    const quotient = digits / divisor;
    const remainder = digits % divisor;
    micros = remainder * 2n >= divisor ? quotient + 1n : quotient;
  }

  if (micros > BigInt(MAX_COST_MICROS)) return null;
  return Number(micros);
}

interface GenerationData {
  total_cost?: unknown;
  usage?: unknown;
  native_tokens_prompt?: unknown;
  native_tokens_completion?: unknown;
  tokens_prompt?: unknown;
  tokens_completion?: unknown;
}

/**
 * Tokens, best effort — and deliberately not held to the same bar as cost.
 *
 * Nothing is paid on this number: `spendInWindow` sums cost, and the token
 * count is stored so the console can show what the money bought and so an
 * inflated self-report is visible beside the truth. A missing token field is
 * therefore recorded as zero, while a missing COST field refuses to settle the
 * row at all. The two are treated differently because only one of them decides
 * money, and that is the whole of the reason.
 *
 * Native counts are preferred: they are what the upstream provider actually
 * billed, where `tokens_prompt` is OpenRouter's normalised estimate.
 */
function readTokens(data: GenerationData): number {
  const integer = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

  const native = integer(data.native_tokens_prompt) + integer(data.native_tokens_completion);
  if (native > 0) return native;

  return integer(data.tokens_prompt) + integer(data.tokens_completion);
}

export interface OpenRouterVerifierOptions {
  /** Overridden only by tests that need to prove the timeout path. */
  timeoutMs?: number;
}

/**
 * A verifier bound to one OpenRouter key.
 *
 * The key is held in this closure and nowhere else: it is not a property of the
 * returned object and never appears in a thrown message — so a verifier that
 * ends up in a log line or a serialised error carries nothing.
 */
export function openRouterVerifier(
  apiKey: string,
  options: OpenRouterVerifierOptions = {}
): UsageVerifier {
  const key = (apiKey ?? '').trim();
  if (!key) throw new Error('An OpenRouter key is required to verify usage.');

  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  return {
    provider: 'openrouter',

    async verify(generationId: string): Promise<VerifiedUsage | null> {
      const response = await ask(
        `${GENERATION_URL}?id=${encodeURIComponent(generationId)}`,
        key,
        timeoutMs
      );

      // The only rejection. OpenRouter knows every generation it charged for,
      // so "no such id" means this one was never spent.
      if (response.status === 404) return null;

      if (!response.ok) {
        // The status, and nothing from the body. A body is text we did not
        // write on its way to a log, and this request carried a credential.
        throw new Error(`OpenRouter answered ${response.status}; leaving this report pending.`);
      }

      let body: { data?: GenerationData } | null;
      try {
        body = (await response.json()) as { data?: GenerationData } | null;
      } catch {
        throw new Error('OpenRouter returned a body that is not JSON; leaving this report pending.');
      }

      const data = body?.data;
      if (!data || typeof data !== 'object') {
        throw new Error('OpenRouter returned no generation data; leaving this report pending.');
      }

      // total_cost is what OpenRouter charged. `usage` is documented as the
      // same USD amount and is read only when total_cost is absent — a fallback
      // between two names for one number, not a guess at a missing one.
      const cost = usdToMicros(data.total_cost) ?? usdToMicros(data.usage);
      if (cost === null) {
        // NOT zero. Settling this row at zero would pay nothing for a request
        // that was really paid for, silently and permanently. Pending is
        // recoverable; a wrong zero is not.
        throw new Error(
          'OpenRouter reported no usable cost for this generation; leaving this report pending.'
        );
      }

      return { generationId, totalTokens: readTokens(data), costMicros: cost };
    },
  };
}

/**
 * The key cannot go in a header, so no request was made.
 *
 * Kept apart from every other failure in this file because it is the only one
 * whose answer is "the key is wrong" rather than "ask again later". A caller
 * that collapses the two tells an owner to retry a key that can never be sent,
 * forever.
 */
class UnsendableKeyError extends Error {
  constructor() {
    super(
      'This OpenRouter key contains a character that cannot be sent in a request header, ' +
        'so nothing was asked of OpenRouter.'
    );
    this.name = 'UnsendableKeyError';
  }
}

/** One request, with a timeout, and never a credential in the failure. */
async function ask(url: string, key: string, timeoutMs: number): Promise<Response> {
  const headers = {
    Authorization: `Bearer ${key}`,
    // OpenRouter attributes calls by these on its dashboard; summaries.ts
    // sends the same pair.
    'HTTP-Referer': 'https://offcut.agent',
    'X-Title': 'OFFCUT AGENT',
  };

  // Asked of the runtime rather than decided by a character class written here,
  // because the rule that matters is whatever `fetch` itself will refuse, and a
  // hand-written copy of it drifts. What this catches is the ordinary
  // copy-paste artefact: a zero-width space or an en-dash-for-hyphen picked up
  // from a rendered page, a PDF or a word processor — and OpenRouter keys are
  // full of hyphens. Below, `fetch` would throw for these too, landing in the
  // catch that means "could not be reached" and sending the owner away to wait
  // out an outage that is not happening.
  try {
    new Headers(headers);
  } catch {
    // Never the runtime's own message. It quotes the header value it rejected,
    // and the header value is the key.
    throw new UnsendableKeyError();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { method: 'GET', signal: controller.signal, headers });
  } catch (error) {
    // Rethrown as our own message so nothing from the underlying failure — some
    // runtimes attach the request, headers included — reaches a caller or a log.
    const timedOut = error instanceof Error && error.name === 'AbortError';
    throw new Error(
      timedOut
        ? `OpenRouter did not answer within ${Math.round(timeoutMs / 1000)}s; leaving this report pending.`
        : 'OpenRouter could not be reached; leaving this report pending.'
    );
  } finally {
    clearTimeout(timer);
  }
}

export type KeyProbe =
  /** The key works. Nothing about it is returned beyond that. */
  | { ok: true }
  /** OpenRouter refused the key. Storing it would be storing a dud. */
  | { ok: false; reason: 'rejected' }
  /**
   * The key could not be put in a header, so it was never sent. The owner
   * should fix the key: unlike an outage, retrying this one cannot ever work.
   */
  | { ok: false; reason: 'malformed' }
  /** We could not ask. The owner should try again, not change their key. */
  | { ok: false; reason: 'unreachable'; status?: number };

/**
 * Asks OpenRouter whether a key is real, before it is stored.
 *
 * GET /api/v1/key is the cheapest question that requires the key and charges
 * nothing. It is used rather than a generation lookup because there is no
 * generation to look up yet, and rather than a completion because validating a
 * credential must not spend the owner's money.
 *
 * "Rejected" and "unreachable" are separated for the same reason verify()
 * separates 404 from 5xx: telling an owner their working key is invalid because
 * OpenRouter had a bad minute is how someone deletes a good credential.
 *
 * "Malformed" is the third, and it is the mirror of that mistake: a key the
 * runtime will not put in a header never reaches OpenRouter at all, so calling
 * it an outage tells the owner to wait for a service that is working fine while
 * the one thing that is broken — the string they pasted — goes unmentioned.
 */
export async function probeOpenRouterKey(
  apiKey: string,
  options: OpenRouterVerifierOptions = {}
): Promise<KeyProbe> {
  const key = (apiKey ?? '').trim();
  if (!key) return { ok: false, reason: 'rejected' };

  let response: Response;
  try {
    response = await ask(KEY_URL, key, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof UnsendableKeyError) return { ok: false, reason: 'malformed' };
    return { ok: false, reason: 'unreachable' };
  }

  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'rejected' };
  return { ok: false, reason: 'unreachable', status: response.status };
}

/**
 * Resolves each workspace's own key, for verifying a mixed batch.
 *
 * Why this is per workspace rather than one key for the server: OpenRouter only
 * answers about a generation to the key that paid for it. A server-wide key can
 * confirm its own spend and nobody else's, so under one shared verifier every
 * workspace but one would have its reports rejected as unknown — which is the
 * failure this whole file is arranged to prevent.
 *
 * The key is decrypted once per workspace per run, not once per row: a batch of
 * two hundred rows from one workspace should touch the ciphertext once, and the
 * plaintext should exist for no longer than the run.
 *
 * A workspace whose credential cannot be decrypted throws, and its rows stay
 * pending. That is right: the usual cause is a changed OFFCUT_SECRET_KEY, and
 * rejecting real spend over a server misconfiguration is exactly the mistake
 * the null/throw split exists to avoid.
 */
export function openRouterUsageSource(db: Db): UsageVerifierSource {
  const resolved = new Map<string, UsageVerifier | null>();

  return {
    provider: 'openrouter',

    async forWorkspace(workspaceId: string): Promise<UsageVerifier | null> {
      const cached = resolved.get(workspaceId);
      if (cached !== undefined) return cached;

      const workspace = await db.workspace.findUnique({
        where: { id: workspaceId },
        select: { usageProvider: true, usageKeyCipher: true },
      });

      let verifier: UsageVerifier | null = null;
      if (workspace?.usageKeyCipher && workspace.usageProvider === 'openrouter') {
        // Nothing is cached if this throws: a run that failed to decrypt should
        // fail again next time rather than remember a workspace as keyless.
        verifier = openRouterVerifier(decryptSecret(workspace.usageKeyCipher, workspaceId));
      }

      resolved.set(workspaceId, verifier);
      return verifier;
    },
  };
}
