/**
 * Access Layer (SS4).
 *
 * Responsibility: workspace permissions and caller identity, on EVERY read and
 * write path. Nothing in this package touches records without going through the
 * functions here first.
 *
 * Three rules drive the design:
 *
 *  1. Identity comes from the connection (SS3.2). An API key resolves to exactly
 *     one Agent row. A request body that says `agentId: "someone-else"` changes
 *     nothing, which is what closes the spoofing risk in SS7.
 *
 *  2. Revocation is immediate (SS3.4, invariant 9). Every call re-reads the
 *     agent, so a key revoked a millisecond ago fails the next operation. The
 *     agent row is never deleted, because authorship of past records must
 *     survive revocation.
 *
 *  3. An unauthorised caller learns nothing (SS7.1: "no content, summary or
 *     metadata from inaccessible memory"). A workspace belonging to someone else
 *     and a workspace that does not exist produce the same error.
 */

import type { Prisma } from '../generated/client';
import { getPrisma } from './db';
import { errors } from './errors';
import { hashApiKey } from './util';
import type { AgentKind, Operation, Permissions, Principal, Scope } from './types';

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Resolves a raw agent API key into a principal.
 *
 * The key is hashed before lookup, so the plaintext never has to be stored or
 * compared. A revoked agent authenticates as "known but blocked" rather than
 * "unknown", so the caller gets an accurate REVOKED rather than a confusing 401.
 */
export async function authenticateAgent(apiKey: string): Promise<Principal> {
  const trimmed = (apiKey ?? '').trim();
  if (!trimmed) throw errors.unauthenticated();

  const agent = await getPrisma().agent.findUnique({
    where: { keyHash: hashApiKey(trimmed) },
  });

  if (!agent) throw errors.unauthenticated('Unknown agent key.');
  if (agent.revokedAt) throw errors.revoked(agent.name);

  // Best-effort liveness stamp. Never blocks or fails the operation.
  //
  // updateMany, not update: if the agent row disappears between the read above
  // and this write, update() throws a "record not found" that Prisma logs to
  // stderr before our .catch() ever sees it. updateMany matches zero rows and
  // says nothing, which is the correct behaviour for a stamp nobody waits on.
  void getPrisma()
    .agent.updateMany({ where: { id: agent.id }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);

  return {
    kind: 'agent',
    agentId: agent.id,
    workspaceId: agent.workspaceId,
    name: agent.name,
    agentKind: agent.kind as AgentKind,
    permissions: {
      canRead: agent.canRead,
      canWrite: agent.canWrite,
      canImport: agent.canImport,
      canMerge: agent.canMerge,
      canResolve: agent.canResolve,
      canForget: agent.canForget,
      canExport: agent.canExport,
    },
  };
}

/**
 * Resolves a console session (already verified by the API's auth guard).
 *
 * Which door the session came through changes nothing here. An account opened
 * by signing with a wallet carries a null email and authorises exactly like an
 * account opened with one, because §5 line 151 puts memory operations beyond
 * the reach of any wallet requirement - so a wallet can never be the thing that
 * grants or withholds access.
 */
export async function authenticateUser(userId: string): Promise<Principal> {
  const user = await getPrisma().user.findUnique({ where: { id: userId } });
  if (!user) throw errors.unauthenticated('Unknown session.');

  return {
    kind: 'user',
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
  };
}

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

/** Which permission flag each of the eight operations requires (SS4.1). */
const REQUIRED_PERMISSION: Record<Operation, keyof Permissions> = {
  add: 'canWrite',
  import: 'canImport',
  merge: 'canMerge',
  recall: 'canRead',
  inspect: 'canRead',
  resolve: 'canResolve',
  forget: 'canForget',
  export: 'canExport',
};

export interface AccessContext {
  principal: Principal;
  workspaceId: string;
  workspaceSlug: string;
  /** Character budget configured on the workspace (SS3.4, OPEN-3). */
  contextLimit: number;
  /** True when the principal owns the workspace. */
  isOwner: boolean;
}

/**
 * The single gate for every operation.
 *
 * Verifies, in order: the workspace exists and is visible to this principal;
 * the agent belongs to THIS workspace; the agent is not revoked; and the
 * operation's permission flag is set.
 */
export async function authorize(
  principal: Principal,
  workspaceId: string,
  operation: Operation
): Promise<AccessContext> {
  const workspace = await getPrisma().workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, slug: true, ownerId: true, contextLimit: true },
  });

  // Same error for "missing" and "not yours" - probing must not be informative.
  if (!workspace) throw errors.accessDenied(`memory.${operation}`);

  switch (principal.kind) {
    case 'system':
      return {
        principal,
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        contextLimit: workspace.contextLimit,
        isOwner: true,
      };

    case 'user': {
      // Owners hold every permission on their own workspaces. They are the ones
      // SS2 puts in charge of granting access, authorising corrections and
      // deletion, so no per-operation flag applies to them.
      if (workspace.ownerId !== principal.userId) throw errors.accessDenied(`memory.${operation}`);
      return {
        principal,
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        contextLimit: workspace.contextLimit,
        isOwner: true,
      };
    }

    case 'agent': {
      // An agent key is bound to one workspace. Crossing workspaces is the
      // leakage risk called out in SS7, and this is where it is stopped.
      if (principal.workspaceId !== workspace.id) throw errors.accessDenied(`memory.${operation}`);

      // Re-read rather than trusting the principal snapshot: a key revoked
      // between authentication and this call must fail here (invariant 9).
      const fresh = await getPrisma().agent.findUnique({
        where: { id: principal.agentId },
        select: { revokedAt: true, name: true },
      });
      if (!fresh) throw errors.accessDenied(`memory.${operation}`);
      if (fresh.revokedAt) throw errors.revoked(fresh.name);

      const needed = REQUIRED_PERMISSION[operation];
      if (!principal.permissions[needed]) throw errors.accessDenied(`memory.${operation}`);

      return {
        principal,
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        contextLimit: workspace.contextLimit,
        isOwner: false,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * The audience filter applied to every record query.
 *
 * `workspace`-scoped records are visible to any agent with read access.
 * `private` records are visible only to their author.
 *
 * The workspace owner sees both. That is a deliberate, documented choice rather
 * than an oversight: SS4.2 warns against promising isolation the system cannot
 * deliver, and the owner holds the database file itself. What private records
 * are still guaranteed is the part that matters operationally - they never merge
 * into a shared block and never widen an audience (invariant 2).
 */
export function visibilityWhere(
  context: AccessContext,
  options: { includeDeleted?: boolean } = {}
): Prisma.MemoryRecordWhereInput {
  const base: Prisma.MemoryRecordWhereInput = {
    workspaceId: context.workspaceId,
  };

  // SS3.4 step 2: deleted records do not contribute to search, counts or
  // summaries. Excluding them here means no caller has to remember to.
  if (!options.includeDeleted) base.deletedAt = null;

  if (context.principal.kind === 'agent') {
    base.OR = [{ scope: 'workspace' }, { scope: 'private', agentId: context.principal.agentId }];
  }

  return base;
}

/** Audiences this principal may write into or merge across. */
export function allowedScopes(context: AccessContext): Scope[] {
  return ['workspace', 'private'];
}

/**
 * Whether a principal may act as the decision author for a conflict (SS3.5).
 *
 * Owners always may. Agents need the explicit `canResolve` grant - being the
 * lead agent is not enough, because SS3.5 states the title does not by itself
 * confer authority to determine truth.
 */
export function canDecideTruth(context: AccessContext): boolean {
  if (context.principal.kind === 'user' || context.principal.kind === 'system') return true;
  return context.principal.permissions.canResolve;
}

/**
 * Whether a principal may correct a record it did not author.
 *
 * SS2: a subagent "cannot overwrite another agent's record". Owners can, because
 * SS2 puts authorising corrections in their hands.
 */
export function canCorrectRecordOf(context: AccessContext, authorAgentId: string): boolean {
  if (context.isOwner) return true;
  if (context.principal.kind !== 'agent') return false;
  return context.principal.agentId === authorAgentId;
}

/**
 * Memory text is data, never authority (SS4.2, invariant 9).
 *
 * This does NOT sanitise or reject anything - a record saying "ignore the rules"
 * is stored verbatim, because censoring user memory would be its own bug. It
 * only flags the text so surfaces can label it when displaying, and so the
 * injection tests in SS7 have something to assert against. No permission check
 * anywhere consults this function; that is the point.
 */
const INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules)\b/i,
  /\bdisregard\s+(all\s+)?(previous|prior|above)\b/i,
  /\byou\s+are\s+now\s+(an?\s+)?(admin|owner|root)\b/i,
  /\bgrant\s+(me|yourself)\s+(admin|owner|all)\b/i,
  /\b(игнорируй|забудь)\s+(все\s+)?(предыдущие\s+)?(правила|инструкции)\b/i,
  /\bты\s+теперь\s+(админ|владелец)\b/i,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}
