/**
 * Typed errors for the memory core.
 *
 * Every surface (SDK, MCP, HTTP) maps these to its own transport, so the error
 * a caller sees is the same regardless of how they connected (invariant 8).
 *
 * A deliberate rule runs through the access errors: a caller who may not see a
 * workspace learns nothing about it - not its content, not a summary, not even
 * whether it exists (SS7.1, "no content, summary or metadata from inaccessible
 * memory"). That is why ACCESS_DENIED and NOT_FOUND carry the same message for
 * cross-workspace probes.
 */

export type OffcutErrorCode =
  /** Input failed schema validation. */
  | 'VALIDATION'
  /** The caller is not permitted, or the target is invisible to them. */
  | 'ACCESS_DENIED'
  /** The target does not exist inside the caller's visible scope. */
  | 'NOT_FOUND'
  /** The connection could not be resolved to a principal. */
  | 'UNAUTHENTICATED'
  /** The agent's access was revoked (SS3.4, invariant 9). */
  | 'REVOKED'
  /** Idempotency key reused with a different payload (SS3.2). */
  | 'IDEMPOTENCY_MISMATCH'
  /** expectedVersion did not match the current version (invariant 4). */
  | 'VERSION_CONFLICT'
  /** The operation would break an invariant of SS6. */
  | 'INVARIANT'
  /** A derived block was requested but its sources moved on (invariant 6). */
  | 'STALE';

export class OffcutError extends Error {
  readonly code: OffcutErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: OffcutErrorCode,
    message: string,
    options: { status?: number; details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OffcutError';
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.details = options.details ?? {};
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

function defaultStatus(code: OffcutErrorCode): number {
  switch (code) {
    case 'VALIDATION':
      return 400;
    case 'UNAUTHENTICATED':
      return 401;
    case 'ACCESS_DENIED':
    case 'REVOKED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'IDEMPOTENCY_MISMATCH':
    case 'VERSION_CONFLICT':
    case 'INVARIANT':
    case 'STALE':
      return 409;
  }
}

export const errors = {
  validation(message: string, details?: Record<string, unknown>) {
    return new OffcutError('VALIDATION', message, { details });
  },

  unauthenticated(message = 'No verified connection. Identity comes from the connection, not the request body.') {
    return new OffcutError('UNAUTHENTICATED', message);
  },

  revoked(agentName: string) {
    return new OffcutError('REVOKED', `Access for "${agentName}" has been revoked.`, {
      details: { agentName },
    });
  },

  /**
   * Used for both "you may not" and "it is not yours". The message is identical
   * on purpose so probing cannot distinguish the two (SS7.1).
   */
  accessDenied(operation: string) {
    return new OffcutError('ACCESS_DENIED', `Not permitted: ${operation}.`, {
      details: { operation },
    });
  },

  notFound(what: string) {
    return new OffcutError('NOT_FOUND', `${what} not found.`, { details: { what } });
  },

  idempotencyMismatch(key: string) {
    return new OffcutError(
      'IDEMPOTENCY_MISMATCH',
      'This idempotency key was already used with different content.',
      { details: { idempotencyKey: key } }
    );
  },

  versionConflict(recordId: string, expected: number, actual: number) {
    return new OffcutError(
      'VERSION_CONFLICT',
      `Record ${recordId} has moved on: expected version ${expected}, current is ${actual}. Re-read before correcting.`,
      { details: { recordId, expected, actual } }
    );
  },

  invariant(message: string, details?: Record<string, unknown>) {
    return new OffcutError('INVARIANT', message, { details });
  },

  stale(blockId: string, reason: string) {
    return new OffcutError('STALE', `Derived block ${blockId} is stale: ${reason}`, {
      details: { blockId, reason },
    });
  },
};

/**
 * Structural, not `instanceof`.
 *
 * Under pnpm each package can resolve its own copy of a dependency, and two
 * copies of a class are two different classes: `instanceof` returns false for an
 * error thrown by the other one. That already bit this project once — the HTTP
 * layer's `instanceof ZodError` check silently failed and every rejected input
 * came back as a 500 instead of a 400. The same trap applies to OffcutError as
 * soon as anything resolves a second copy of @offcut/core, so the check does not
 * rely on class identity at all.
 */
export function isOffcutError(value: unknown): value is OffcutError {
  if (value instanceof OffcutError) return true;

  if (typeof value !== 'object' || value === null) return false;

  const candidate = value as { name?: unknown; code?: unknown; status?: unknown };
  return (
    candidate.name === 'OffcutError' &&
    typeof candidate.code === 'string' &&
    typeof candidate.status === 'number'
  );
}

interface ZodLikeIssue {
  path: (string | number)[];
  message: string;
}

/**
 * Recognises a zod rejection without importing zod's class, for the reason
 * above: the schema may have been compiled against a different copy.
 */
export function asZodError(value: unknown): { issues: ZodLikeIssue[] } | null {
  if (typeof value !== 'object' || value === null) return null;

  const candidate = value as { name?: unknown; issues?: unknown };
  if (candidate.name !== 'ZodError' || !Array.isArray(candidate.issues)) return null;

  return { issues: candidate.issues as ZodLikeIssue[] };
}

/**
 * Turns a schema rejection into the VALIDATION error every surface knows how to
 * report.
 *
 * This belongs in the core rather than in each surface. A raw zod error escaping
 * to MCP was reported to the calling model as `code: "UNKNOWN"` with a JSON dump
 * of zod issues as the message — which reads as "something broke, give up"
 * rather than "your arguments were wrong, fix them and retry". SS4 is explicit
 * that a surface adds no logic of its own, so if MCP had translated this itself
 * the three surfaces would have drifted apart (invariant 8).
 *
 * The message names the offending fields, because a model can act on
 * "idempotencyKey: Required" and cannot act on "invalid input".
 */
export function validationErrorFrom(issues: ZodLikeIssue[]): OffcutError {
  const message = issues
    .map((issue) => {
      const field = issue.path.join('.');
      return field ? `${field}: ${issue.message}` : issue.message;
    })
    .join('; ');

  return new OffcutError('VALIDATION', message || 'Input failed validation.', {
    details: { issues },
  });
}

/**
 * Parses input against a schema, raising an OffcutError instead of a zod one.
 *
 * Every operation in memory.ts starts with this, so no surface ever has to deal
 * with a zod error at all.
 */
export function parseInput<T>(schema: { parse: (value: unknown) => T }, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    const zod = asZodError(error);
    if (zod) throw validationErrorFrom(zod.issues);
    throw error;
  }
}
