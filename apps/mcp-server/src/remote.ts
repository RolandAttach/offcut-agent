/**
 * The same eight operations, against a server instead of a file.
 *
 * Why this exists at all: a key minted on https://offcut.tech lives in that
 * server's database, and the local store is a SQLite file on the machine
 * running this process. Handing the site's key to the local server produced
 * "could not authenticate" and never made a single request - the two stores
 * had never met. The console printed a command that could not work.
 *
 * There is no new surface here. apps/api already exposes every memory
 * operation at POST /api/workspaces/:id/memory/<op>, parsed by the same zod
 * schemas in @offcut/core, and its principal guard accepts the agent key as a
 * Bearer token (apps/api/src/auth/principal.guard.ts). So this file is a
 * transport and nothing else: it moves the argument object the local method
 * would have taken, and hands back whatever the server answered. No merge
 * rule, no permission check, no retry that could turn one write into two -
 * invariant 8 says the rules live in the core, and the core is at the other
 * end of this socket.
 *
 * Two things it deliberately does NOT do:
 *
 *   - fall back to the local store when the server is unreachable. A silent
 *     fallback would write a record into a file nobody is looking at and
 *     report success. An unreachable server is said out loud instead.
 *   - import @offcut/core. Not even for the error class - importing the
 *     package loads the generated Prisma client, which is the database this
 *     mode exists to avoid. OffcutError is matched and reproduced by shape,
 *     the way apps/api's filter matches zod errors across two copies of zod.
 */

import type { MemorySurface } from './memory-surface';

/** Just enough of `fetch` to be swapped for a fake in the tests. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * An error shaped like the core's OffcutError: `code`, `message`, `details`.
 * index.ts formats a tool error from those three fields, so a failure that
 * happened on the wire reads to a model exactly like one that happened in the
 * store - which is the whole promise of invariant 8.
 *
 * The codes are the core's own wherever the server supplied one. UNREACHABLE
 * is the one addition, because "I never got an answer" is not a state a local
 * store can be in, and a model should not be told it was denied when nobody
 * refused it.
 */
export class RemoteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { status?: number; details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RemoteError';
    this.code = code;
    this.status = options.status ?? 500;
    this.details = options.details ?? {};
  }
}

export interface RemoteMemoryOptions {
  /** Where the OFFCUT server lives, e.g. https://offcut.tech */
  baseUrl: string;
  /** An agent key minted BY THAT SERVER. */
  apiKey: string;
  /** Swapped in the tests; the platform `fetch` otherwise. */
  fetchImpl?: FetchLike;
  /** How long one request may take before it is called unreachable. */
  timeoutMs?: number;
}

/**
 * Accepts what people actually paste.
 *
 * A trailing slash is harmless everywhere else, and `https://offcut.tech/api`
 * is what someone copies out of a browser after poking at the API - so both
 * are normalised rather than turned into a 404 with `/api/api/` in it, which
 * explains nothing to the person reading it.
 */
export function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/api$/i, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The core's error shape, recognised structurally.
 *
 * apps/api answers { error: { code, message, details } } for everything it
 * refuses (OffcutExceptionFilter). Anything else on a failure status is a
 * proxy, a login page or another product entirely, and gets said so.
 */
function offcutErrorBody(
  body: unknown
): { code: string; message: string; details: Record<string, unknown> } | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const { code, message, details } = body.error;
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return { code, message, details: isRecord(details) ? details : {} };
}

/** Enough of a foreign body to quote, never enough to fill a terminal. */
function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}...` : oneLine;
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}

export function createRemoteMemory(options: RemoteMemoryOptions): MemorySurface {
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  const candidate = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  const timeoutMs = options.timeoutMs ?? 30_000;

  if (typeof candidate !== 'function') {
    throw new RemoteError(
      'INVARIANT',
      'This Node build has no global fetch, so OFFCUT_API_URL cannot be used. Node 20.11 or newer is required.'
    );
  }

  // Bound to its own const after the check: a narrowing does not survive into
  // the closures below, and `doFetch!` would be a claim rather than a proof.
  const doFetch: FetchLike = candidate;

  /**
   * The workspace is addressed in the path, exactly as the console addresses
   * it, so it has to be in the arguments. The local store reads it out of the
   * same field; this is the same requirement, failing earlier and by name.
   */
  function workspaceIdOf(input: unknown): string {
    const id = isRecord(input) ? input.workspaceId : undefined;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new RemoteError(
        'VALIDATION',
        'workspaceId is required: on a remote store the workspace is part of the address.',
        { status: 400 }
      );
    }
    return id;
  }

  async function post(path: string, body: unknown): Promise<unknown> {
    const url = `${baseUrl}${path}`;

    let response: Awaited<ReturnType<FetchLike>>;
    let text: string;

    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          // Identity in the connection, §3.2 - the same rule as the local
          // mode, one hop further out.
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body ?? {}),
        // A hung server would otherwise hang the client's tool call forever,
        // and the client would show a spinner with no reason attached.
        signal: timeoutSignal(timeoutMs),
      });
      text = await response.text();
    } catch (cause) {
      throw new RemoteError(
        'UNREACHABLE',
        `Could not reach ${baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}. ` +
          'OFFCUT_API_URL is set, so nothing was read or written locally - the remote store is the only store.',
        { status: 503, details: { url }, cause }
      );
    }

    let parsed: unknown;
    let parseFailed = false;
    if (text.trim() !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parseFailed = true;
      }
    }

    if (response.ok) {
      if (parseFailed) {
        throw new RemoteError(
          'UNREACHABLE',
          `${baseUrl} answered ${response.status} with a body that is not JSON: "${snippet(text)}". ` +
            'That is not an OFFCUT API answer - check OFFCUT_API_URL, and whether something sits in front of it.',
          { status: 502, details: { url } }
        );
      }
      return parsed;
    }

    const refused = offcutErrorBody(parsed);

    if (response.status === 401 || response.status === 403) {
      // Said in full rather than passed through, because the core's own
      // wording ("No verified connection") is correct and useless here: the
      // key is almost always a real key, minted on a DIFFERENT OFFCUT.
      const explained =
        refused && response.status === 403 ? ` The server said: ${refused.message}` : '';
      throw new RemoteError(
        refused?.code ?? (response.status === 401 ? 'UNAUTHENTICATED' : 'ACCESS_DENIED'),
        `That key was not accepted by ${baseUrl}. Keys are minted per server: a key from one OFFCUT does not work on another.${explained}`,
        { status: response.status, details: { url, ...(refused?.details ?? {}) } }
      );
    }

    if (response.status === 404) {
      if (!refused) {
        throw new RemoteError(
          'UNREACHABLE',
          `${baseUrl} has no route at ${path}, and answered "${snippet(text)}" rather than an OFFCUT error. ` +
            'Is OFFCUT_API_URL pointing at an OFFCUT server?',
          { status: 404, details: { url } }
        );
      }
      throw new RemoteError(
        refused.code,
        `That workspace is not on ${baseUrl}, or this key cannot see it. The server said: ${refused.message}`,
        { status: 404, details: { url, ...refused.details } }
      );
    }

    if (refused) {
      // A version conflict, an idempotency mismatch, a validation failure: the
      // core's own answer, carried across unchanged. Rewording it here would
      // make the remote mode disagree with the local one about what happened.
      throw new RemoteError(refused.code, refused.message, {
        status: response.status,
        details: refused.details,
      });
    }

    throw new RemoteError(
      'UNREACHABLE',
      `${baseUrl} answered ${response.status} with "${snippet(text)}", which is not an OFFCUT error.`,
      { status: response.status, details: { url } }
    );
  }

  function operation(name: string) {
    return async (input: unknown): Promise<unknown> =>
      post(`/api/workspaces/${encodeURIComponent(workspaceIdOf(input))}/memory/${name}`, input);
  }

  return {
    add: operation('add'),
    import: operation('import'),
    merge: operation('merge'),
    recall: operation('recall'),
    inspect: operation('inspect'),
    resolve: operation('resolve'),
    forget: operation('forget'),
    export: operation('export'),

    // Not a memory operation and not pretending to be one: a different
    // controller, a different body shape. The workspace is in the path, the
    // reports are the body - apps/api/src/usage/usage.controller.ts.
    async reportUsage(workspaceId: string, reports: unknown[]): Promise<unknown> {
      if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
        throw new RemoteError(
          'VALIDATION',
          'workspaceId is required: on a remote store the workspace is part of the address.',
          { status: 400 }
        );
      }
      return post(`/api/workspaces/${encodeURIComponent(workspaceId)}/usage`, { reports });
    },
  };
}

/**
 * A reachability check for startup, not an authentication.
 *
 * The local mode authenticates before it says "ready", and a remote mode that
 * said nothing until the first tool call would leave a mistyped URL looking
 * exactly like a working one. /api/health is public, so this proves a server
 * is there and that it is an OFFCUT; the key is checked by that server on
 * every request after this, which is the only place it can honestly be checked
 * - there is no endpoint that tells an agent key who it is.
 */
export async function pingServer(
  baseUrl: string,
  fetchImpl?: FetchLike,
  timeoutMs = 10_000
): Promise<{ service: string; version?: string }> {
  const base = normaliseBaseUrl(baseUrl);
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${base}/api/health`;

  let text: string;
  try {
    const response = await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: timeoutSignal(timeoutMs),
    });
    text = await response.text();
    if (!response.ok) {
      throw new RemoteError(
        'UNREACHABLE',
        `${base} answered ${response.status} at /api/health: "${snippet(text)}".`,
        { status: response.status, details: { url } }
      );
    }
  } catch (cause) {
    if (cause instanceof RemoteError) throw cause;
    throw new RemoteError(
      'UNREACHABLE',
      `Could not reach ${base}: ${cause instanceof Error ? cause.message : String(cause)}.`,
      { status: 503, details: { url }, cause }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RemoteError(
      'UNREACHABLE',
      `${base} answered at /api/health with something that is not JSON: "${snippet(text)}". Is that an OFFCUT server?`,
      { status: 502, details: { url } }
    );
  }

  if (!isRecord(parsed) || typeof parsed.service !== 'string') {
    throw new RemoteError(
      'UNREACHABLE',
      `${base} answered at /api/health, but not as an OFFCUT server would: "${snippet(text)}".`,
      { status: 502, details: { url } }
    );
  }

  return {
    service: parsed.service,
    version: typeof parsed.version === 'string' ? parsed.version : undefined,
  };
}
