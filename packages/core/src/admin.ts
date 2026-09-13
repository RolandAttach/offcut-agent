/**
 * Workspace and agent administration.
 *
 * These are owner-level operations from SS2: creating a workspace, granting
 * access, and revoking it. They sit beside the eight memory operations rather
 * than inside them, because SS4.1 defines the memory interface precisely and
 * adding management verbs to it would blur that boundary.
 *
 * Password hashing uses scrypt from node:crypto. That is a deliberate choice
 * over bcrypt or argon2: both need native compilation, and SS4's "the first
 * release is local" only holds if `pnpm setup` works on a clean machine with no
 * build toolchain. scrypt is memory-hard, in the standard library, and needs
 * nothing installed.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getPrisma } from './db';
import { errors } from './errors';
import { authorize, type AccessContext } from './access';
import { CONSOLE_KEY_PREFIX, isUniqueViolation } from './store';
import { generateApiKey, slugify } from './util';
import {
  DEFAULT_LEAD_PERMISSIONS,
  DEFAULT_SUBAGENT_PERMISSIONS,
  LIMITS,
  type AgentKind,
  type Permissions,
  type Principal,
} from './types';

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

/**
 * `stored` is nullable because an account opened with a wallet has no password
 * at all. Reading `.split` off null would throw, and a thrown TypeError is a
 * 500 that tells an attacker this address has no password - which is exactly
 * the fact the identical error message in verifyUserCredentials hides.
 */
export function verifyPassword(password: string, stored: string | null): boolean {
  const [scheme, salt, expected] = (stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;

  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function createUser(params: {
  email: string;
  password: string;
  displayName: string;
}): Promise<{ id: string; email: string; displayName: string }> {
  const email = params.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw errors.validation('A valid email address is required.');
  }
  if (params.password.length < 8) {
    throw errors.validation('Password must be at least 8 characters.');
  }

  const existing = await getPrisma().user.findUnique({ where: { email } });
  if (existing) throw errors.validation('An account with this email already exists.');

  const user = await getPrisma().user.create({
    data: {
      email,
      passwordHash: hashPassword(params.password),
      displayName: params.displayName.trim() || email.split('@')[0]!,
    },
  });

  // The local `email`, not `user.email`: the column is nullable now (a wallet
  // account has none) and this path always wrote one.
  return { id: user.id, email, displayName: user.displayName };
}

/**
 * The email door.
 *
 * Three different failures share one sentence, and that is the whole point:
 * no such account, wrong password, and an account that has no password because
 * it was opened by signing with a wallet. The third is the new one and it is
 * the one worth spelling out - answering "that address has no password" would
 * turn this endpoint into an oracle for which wallets hold an account here,
 * and whether an address has an email beside it is nobody's business.
 */
export async function verifyUserCredentials(
  email: string,
  password: string
): Promise<{ id: string; email: string; displayName: string }> {
  const normalized = email.trim().toLowerCase();
  const user = await getPrisma().user.findUnique({ where: { email: normalized } });

  // Same error either way: whether an email is registered is not public.
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw errors.unauthenticated('Incorrect email or password.');
  }

  return { id: user.id, email: user.email ?? normalized, displayName: user.displayName };
}

// ---------------------------------------------------------------------------
// Payout addresses
// ---------------------------------------------------------------------------

/** 0x followed by 40 hexadecimal characters - the only shape an EVM address has. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Tokens sent here are gone. Nobody means to be paid at the burn address. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface WalletLink {
  /** Always lowercase, so one address is one account however it was written. */
  address: string | null;
  linkedAt: string | null;
  /**
   * When a signature last proved this address, or null when none ever has.
   *
   * The whole difference between the two doors is in this field. A surface that
   * wants to say "your wallet" rather than "where to pay" must read this one,
   * not linkedAt.
   */
  provenAt: string | null;
}

/**
 * Records where this account's rewards are paid.
 *
 * WHAT THIS DOES NOT ESTABLISH: that the account holder controls the address.
 * Nothing here asks a wallet to sign and nothing verifies a signature, so this
 * is a preference on an account - a mailing address, not a proof of ownership.
 * Whoever holds the session can point it anywhere, including at someone else's
 * wallet. The console says exactly that where the field is set. Making it mean
 * more would take a sign-in-with-Ethereum flow, which is a separate piece of
 * work and worse than nothing if half built.
 *
 * The shape is checked; the EIP-55 checksum is not. That needs keccak, which is
 * not in node:crypto, and the core has no hashing dependency beyond it. A
 * checksummed address is accepted and lowercased - which is why the stored
 * value is what gets shown back, rather than what was typed.
 */
export async function linkWallet(userId: string, address: string): Promise<WalletLink> {
  const trimmed = address.trim();
  if (!EVM_ADDRESS.test(trimmed)) {
    throw errors.validation('A wallet address is 0x followed by 40 hexadecimal characters.');
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === ZERO_ADDRESS) {
    throw errors.validation('That is the zero address. Rewards paid there cannot be recovered.');
  }

  const linkedAt = new Date();

  // Typing an address changes where money goes. It changes nothing about who
  // signed in, so neither proof column is written here: not walletProvenAddress,
  // which is how the account is reached, and not walletProvenAt, which records
  // when that key last proved itself. The two came apart the first time typing
  // was allowed to clear them — a wallet-only account that repointed its payout
  // elsewhere lost the address it signs in with, and the next signature from
  // its own key opened a fresh, empty account beside the one holding its
  // workspaces.
  //
  // Whether the payout address counts as PROVEN is a comparison, made when it
  // is read (getLinkedWallet): proven while it is the address that signed in,
  // not proven while it is anything else. So an owner who signed in with A and
  // typed B sees B unproven — the exact claim this endpoint spends a sentence
  // denying — and typing A back needs no second signature, because the proof
  // was of A and A has not changed. Read here only to say so in the reply.
  const current = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { walletProvenAddress: true, walletProvenAt: true },
  });
  const provenAt = current?.walletProvenAddress === normalized ? (current.walletProvenAt ?? null) : null;

  // No existence check beyond that: the session guard resolved this user from
  // the database on this same request, so a missing row here is an internal
  // failure and should be reported as one rather than dressed up as a
  // validation error.
  await getPrisma().user.update({
    where: { id: userId },
    data: {
      walletAddress: normalized,
      walletLinkedAt: linkedAt,
    },
  });

  return {
    address: normalized,
    linkedAt: linkedAt.toISOString(),
    provenAt: provenAt?.toISOString() ?? null,
  };
}

/**
 * Forgets the payout address.
 *
 * Nothing already earned is affected: credits are rows against a workspace, not
 * a balance held on a wallet, so unlinking loses no points and clearing one
 * address to set another cannot cost anyone a reward.
 *
 * The address the account signed in with is not forgotten either — see
 * linkWallet. An account with no email has no other way back in, and "forget
 * where to pay me" must not mean "forget who I am".
 */
export async function unlinkWallet(userId: string): Promise<WalletLink> {
  await getPrisma().user.update({
    where: { id: userId },
    data: {
      walletAddress: null,
      walletLinkedAt: null,
    },
  });

  return { address: null, linkedAt: null, provenAt: null };
}

export async function getLinkedWallet(userId: string): Promise<WalletLink> {
  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    select: {
      walletAddress: true,
      walletLinkedAt: true,
      walletProvenAt: true,
      walletProvenAddress: true,
    },
  });

  // Proven means: the payout address IS the address that signed in. A
  // timestamp alone would say "some key once proved itself" about whatever
  // address is on the row today, which is the claim a typed address must never
  // inherit. See linkWallet for why the columns themselves are left alone.
  const proven =
    user?.walletAddress !== null &&
    user?.walletAddress !== undefined &&
    user.walletAddress === user.walletProvenAddress;

  return {
    address: user?.walletAddress ?? null,
    linkedAt: user?.walletLinkedAt?.toISOString() ?? null,
    provenAt: proven ? (user?.walletProvenAt?.toISOString() ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Wallet as identity
// ---------------------------------------------------------------------------

/** The 0x1234…5678 form, which is how a wallet names itself everywhere else. */
function shortAddress(normalized: string): string {
  return `${normalized.slice(0, 6)}…${normalized.slice(-4)}`;
}

/** An account reached through the wallet door. */
export interface WalletUser {
  id: string;
  /** Null for an account that has only ever been a wallet. */
  email: string | null;
  displayName: string;
  wallet: {
    address: string;
    linkedAt: string | null;
    /** When a signature last proved this address. Never null on this path. */
    provenAt: string;
  };
}

/**
 * The second door: signs in the account that owns this address, opening one if
 * there is none.
 *
 * THE ADDRESS IS THE IDENTITY HERE. If somebody had already typed this address
 * into PUT /auth/wallet on an existing account, signing with it must reach THAT
 * account rather than mint a second one beside it - otherwise a person who set
 * a payout address in the console would find their rewards on one account and
 * their session on another. That is why this looks up the address before it
 * considers creating anything, and why it then stamps walletProvenAt: the hand
 * link was a claim, this is the proof, and the column is where the difference
 * is written down.
 *
 * WHAT IT IS NOT. Nothing here spends gas, holds a balance or asks for a
 * transaction (line 19), and nothing about memory starts requiring a wallet
 * because this exists (§5, line 151). It is a way to sign in, beside email,
 * and an account created this way has no email and no password - which is why
 * both columns are nullable and why verifyUserCredentials above refuses such an
 * account with the ordinary wrong-password sentence.
 *
 * The caller has already verified the signature. Core never sees one: keccak
 * and secp256k1 are not in node:crypto, and pulling a crypto dependency into a
 * package that deliberately has two would cost more than it buys. What core
 * guarantees is the shape of the address and the identity rule above.
 *
 * TWO TABS ARE ONE WALLET. The login page asks for a signature the moment a
 * connected wallet is on the right chain, so a restored window beside a fresh
 * one sends this twice at the same instant. Reading and then creating left a
 * window in which both requests missed and both created; the second account was
 * then unreachable by the only credential its owner had, along with every
 * workspace, agent key and record made in it. The unique index on
 * walletProvenAddress closes that window - the same way invariant 4 settles two
 * corrections racing for one version - and the request that loses comes back to
 * read the row the winner wrote.
 */
export async function findOrCreateUserByWallet(address: string): Promise<WalletUser> {
  const trimmed = address.trim();
  if (!EVM_ADDRESS.test(trimmed)) {
    throw errors.validation('A wallet address is 0x followed by 40 hexadecimal characters.');
  }

  // Lowercase, so a checksummed signature and a lowercase hand link are one
  // account. Every address column in this file is stored the same way.
  const normalized = trimmed.toLowerCase();
  if (normalized === ZERO_ADDRESS) {
    throw errors.validation('Nobody holds the key to the zero address.');
  }

  // A lost race is not a failure: the winner's row is the account, so read
  // again and join it. Three passes because only a loss brings us back here and
  // a second loss needs a third wallet signing this same address in the same
  // millisecond - past that, something other than a race is wrong and the
  // database's own error is the honest thing to report.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await reachWalletAccount(normalized);
    } catch (error) {
      // Nothing else on this path is unique: the accounts it opens have a null
      // email and a fresh cuid for an id.
      if (!isUniqueViolation(error) || attempt >= 3) throw error;
    }
  }
}

/**
 * One pass at an address: the account that proved it, else the account that
 * named it by hand, else a new one.
 */
async function reachWalletAccount(normalized: string): Promise<WalletUser> {
  const provenAt = new Date();

  // findUnique, on the proof rather than on the payout column: an address that
  // has signed in belongs to exactly one account, so there is one row or none
  // and no tie for anything to break.
  const proven = await getPrisma().user.findUnique({
    where: { walletProvenAddress: normalized },
  });

  if (proven) {
    return walletUserOf(
      await getPrisma().user.update({
        where: { id: proven.id },
        data: {
          walletProvenAt: provenAt,
          // A hand-linked address keeps the day it was linked; only an address
          // this call is introducing gets today's date.
          walletLinkedAt: proven.walletLinkedAt ?? provenAt,
        },
      }),
      normalized,
      provenAt
    );
  }

  // Nothing has signed with it yet, so a hand link is the best claim on it.
  // Ordered by id as well as age because two rows written inside one
  // millisecond are a tie, and a tie is settled by the query planner - which is
  // what "oldest first" quietly meant before. Whichever row this picks, the
  // write below pins the answer for good.
  const linked = await getPrisma().user.findFirst({
    where: { walletAddress: normalized, walletProvenAddress: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const user = linked
    ? await getPrisma().user.update({
        where: { id: linked.id },
        data: {
          walletProvenAddress: normalized,
          walletProvenAt: provenAt,
          walletLinkedAt: linked.walletLinkedAt ?? provenAt,
        },
      })
    : await getPrisma().user.create({
        data: {
          email: null,
          passwordHash: null,
          displayName: shortAddress(normalized),
          walletAddress: normalized,
          walletLinkedAt: provenAt,
          walletProvenAddress: normalized,
          walletProvenAt: provenAt,
        },
      });

  return walletUserOf(user, normalized, provenAt);
}

/**
 * Assembled field by field rather than spread: passwordHash is on the row the
 * caller just read, and a spread would put it on the wire.
 */
function walletUserOf(
  user: { id: string; email: string | null; displayName: string; walletLinkedAt: Date | null },
  normalized: string,
  provenAt: Date
): WalletUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    wallet: {
      address: normalized,
      linkedAt: user.walletLinkedAt?.toISOString() ?? null,
      provenAt: provenAt.toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export async function createWorkspace(params: {
  ownerId: string;
  name: string;
  description?: string;
  contextLimit?: number;
}) {
  const name = params.name.trim();
  if (!name) throw errors.validation('Workspace name is required.');

  // Slugs are unique across the install, so a collision gets a short suffix.
  let slug = slugify(name);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const taken = await getPrisma().workspace.findUnique({ where: { slug } });
    if (!taken) break;
    slug = `${slugify(name)}-${randomBytes(2).toString('hex')}`;
  }

  return getPrisma().workspace.create({
    data: {
      ownerId: params.ownerId,
      name,
      slug,
      description: params.description?.trim() ?? '',
      contextLimit: params.contextLimit ?? 6000,
    },
  });
}

export async function listWorkspaces(ownerId: string) {
  const rows = await getPrisma().workspace.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { agents: true } },
    },
  });

  // Counts are computed per workspace with the deleted records excluded, so the
  // console never shows a total that includes tombstones (invariant 7).
  const out = [];
  for (const row of rows) {
    const records = await getPrisma().memoryRecord.count({
      where: { workspaceId: row.id, isCurrent: true, deletedAt: null },
    });
    const conflicts = await getPrisma().conflict.count({
      where: { workspaceId: row.id, status: 'open' },
    });
    out.push({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      contextLimit: row.contextLimit,
      createdAt: row.createdAt.toISOString(),
      counts: { agents: row._count.agents, records, openConflicts: conflicts },
    });
  }
  return out;
}

export async function getWorkspaceStats(principal: Principal, workspaceId: string) {
  const context = await authorize(principal, workspaceId, 'inspect');
  const db = getPrisma();

  const [records, versions, agents, openConflicts, resolvedConflicts, blocks, staleBlocks] =
    await Promise.all([
      db.memoryRecord.count({
        where: { workspaceId: context.workspaceId, isCurrent: true, deletedAt: null },
      }),
      db.memoryRecord.count({ where: { workspaceId: context.workspaceId, deletedAt: null } }),
      db.agent.count({ where: { workspaceId: context.workspaceId, revokedAt: null } }),
      db.conflict.count({ where: { workspaceId: context.workspaceId, status: 'open' } }),
      db.conflict.count({ where: { workspaceId: context.workspaceId, status: 'resolved' } }),
      db.mergedBlock.count({ where: { workspaceId: context.workspaceId } }),
      db.mergedBlock.count({ where: { workspaceId: context.workspaceId, staleAt: { not: null } } }),
    ]);

  const topics = await db.memoryRecord.groupBy({
    by: ['topic'],
    where: { workspaceId: context.workspaceId, isCurrent: true, deletedAt: null },
    _count: { topic: true },
    orderBy: { _count: { topic: 'desc' } },
    take: 12,
  });

  const byType = await db.memoryRecord.groupBy({
    by: ['type'],
    where: { workspaceId: context.workspaceId, isCurrent: true, deletedAt: null },
    _count: { type: true },
  });

  return {
    records,
    versions,
    agents,
    openConflicts,
    resolvedConflicts,
    blocks,
    staleBlocks,
    topics: topics.map((row) => ({ topic: row.topic, count: row._count.topic })),
    byType: byType.map((row) => ({ type: row.type, count: row._count.type })),
  };
}

export async function updateWorkspace(
  principal: Principal,
  workspaceId: string,
  patch: { name?: string; description?: string; contextLimit?: number }
) {
  const context = await authorize(principal, workspaceId, 'inspect');
  if (!context.isOwner) throw errors.accessDenied('update workspace settings');

  return getPrisma().workspace.update({
    where: { id: context.workspaceId },
    data: {
      ...(patch.name ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.contextLimit ? { contextLimit: Math.min(Math.max(patch.contextLimit, 500), 60000) } : {}),
    },
  });
}

export async function deleteWorkspace(principal: Principal, workspaceId: string): Promise<void> {
  const context = await authorize(principal, workspaceId, 'forget');
  if (!context.isOwner) throw errors.accessDenied('delete a workspace');
  await getPrisma().workspace.delete({ where: { id: context.workspaceId } });
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * Issues an agent credential.
 *
 * The plaintext key is returned exactly once and never stored - only its hash
 * is. This is what SS3.2 means by a verified connection: possession of the key
 * IS the identity, so there is nothing in the database that could be replayed if
 * it leaked.
 */
export async function createAgent(
  principal: Principal,
  workspaceId: string,
  params: {
    name: string;
    kind?: AgentKind;
    description?: string;
    permissions?: Partial<Permissions>;
  }
): Promise<{ agent: { id: string; name: string }; apiKey: string }> {
  const context = await authorize(principal, workspaceId, 'inspect');
  // Only an owner grants access (SS2). An agent cannot mint another agent, which
  // is what stops a subagent from granting itself new permissions.
  if (!context.isOwner) throw errors.accessDenied('create agents');

  const name = params.name.trim();
  if (!name) throw errors.validation('Agent name is required.');

  // OPEN-3's agent ceiling (LIMITS.agentsPerWorkspaceMax), refused the way every
  // other limit in LIMITS is refused: a VALIDATION error, so a caller cannot
  // tell this number arrived later than the other three.
  //
  // What is counted is keys that can still connect. Revoked rows stay forever so
  // authorship survives (invariant 9), and counting them would quietly turn a
  // cap on how big a workspace is into a lifetime quota an owner could never get
  // back under. The per-workspace "Console" writer that store.ts provisions for
  // owner writes holds no usable credential and was minted by nobody, so it does
  // not take a seat either - every real key carries the "offcut_sk_" prefix, so
  // that exclusion can never swallow one.
  //
  // It is a ceiling on growth, not a security boundary: the count and the insert
  // are not one transaction, so two owners minting in the same instant can both
  // pass and land one over. That is deliberate and harmless - a workspace over
  // the limit keeps working in full, and the next mint is simply refused.
  const liveAgents = await getPrisma().agent.count({
    where: {
      workspaceId: context.workspaceId,
      revokedAt: null,
      keyPrefix: { not: CONSOLE_KEY_PREFIX },
    },
  });
  if (liveAgents >= LIMITS.agentsPerWorkspaceMax) {
    throw errors.validation(
      `This workspace already has ${liveAgents} agents, which is the limit (${LIMITS.agentsPerWorkspaceMax}). Revoke a key that is no longer in use, or use a second workspace.`,
      { limit: LIMITS.agentsPerWorkspaceMax, current: liveAgents }
    );
  }

  const kind: AgentKind = params.kind ?? 'subagent';
  const defaults = kind === 'lead' ? DEFAULT_LEAD_PERMISSIONS : DEFAULT_SUBAGENT_PERMISSIONS;
  const permissions = { ...defaults, ...(params.permissions ?? {}) };

  const { key, hash, prefix } = generateApiKey();

  const agent = await getPrisma().agent.create({
    data: {
      workspaceId: context.workspaceId,
      name,
      kind,
      description: params.description?.trim() ?? '',
      keyHash: hash,
      keyPrefix: prefix,
      ...permissions,
    },
  });

  await getPrisma().auditEvent.create({
    data: {
      workspaceId: context.workspaceId,
      actorType: principal.kind,
      actorId: principal.kind === 'user' ? principal.userId : 'system',
      actorName: principal.kind === 'user' ? principal.displayName : 'system',
      action: 'agent.create',
      targetId: agent.id,
      detail: JSON.stringify({ name, kind, permissions }),
    },
  });

  return { agent: { id: agent.id, name: agent.name }, apiKey: key };
}

export async function listAgents(principal: Principal, workspaceId: string) {
  const context = await authorize(principal, workspaceId, 'inspect');

  const rows = await getPrisma().agent.findMany({
    where: { workspaceId: context.workspaceId },
    orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
  });

  const out = [];
  for (const row of rows) {
    const records = await getPrisma().memoryRecord.count({
      where: { agentId: row.id, isCurrent: true, deletedAt: null },
    });

    out.push({
      id: row.id,
      name: row.name,
      kind: row.kind as AgentKind,
      description: row.description,
      // Never the full key: it exists only in the creator's hands.
      keyPrefix: row.keyPrefix,
      permissions: {
        canRead: row.canRead,
        canWrite: row.canWrite,
        canImport: row.canImport,
        canMerge: row.canMerge,
        canResolve: row.canResolve,
        canForget: row.canForget,
        canExport: row.canExport,
      },
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
      recordCount: records,
    });
  }
  return out;
}

export async function updateAgentPermissions(
  principal: Principal,
  workspaceId: string,
  agentId: string,
  permissions: Partial<Permissions>
) {
  const context = await authorize(principal, workspaceId, 'inspect');
  if (!context.isOwner) throw errors.accessDenied('change agent permissions');

  const agent = await getPrisma().agent.findFirst({
    where: { id: agentId, workspaceId: context.workspaceId },
  });
  if (!agent) throw errors.notFound('Agent');

  await getPrisma().auditEvent.create({
    data: {
      workspaceId: context.workspaceId,
      actorType: principal.kind,
      actorId: principal.kind === 'user' ? principal.userId : 'system',
      actorName: principal.kind === 'user' ? principal.displayName : 'system',
      action: 'agent.permissions',
      targetId: agentId,
      detail: JSON.stringify(permissions),
    },
  });

  return getPrisma().agent.update({ where: { id: agentId }, data: permissions });
}

/**
 * Revokes an agent's access (SS3.4, invariant 9).
 *
 * The row stays. Deleting it would erase the authorship of everything the agent
 * ever wrote, and invariant 1 requires every record to keep its author. What
 * revocation guarantees is forward-looking only: no further operation succeeds.
 * Context already handed to another application cannot be recalled, which SS3.4
 * states outright.
 */
export async function revokeAgent(principal: Principal, workspaceId: string, agentId: string) {
  const context = await authorize(principal, workspaceId, 'inspect');
  if (!context.isOwner) throw errors.accessDenied('revoke agents');

  const agent = await getPrisma().agent.findFirst({
    where: { id: agentId, workspaceId: context.workspaceId },
  });
  if (!agent) throw errors.notFound('Agent');

  const updated = await getPrisma().agent.update({
    where: { id: agentId },
    data: { revokedAt: new Date() },
  });

  await getPrisma().auditEvent.create({
    data: {
      workspaceId: context.workspaceId,
      actorType: principal.kind,
      actorId: principal.kind === 'user' ? principal.userId : 'system',
      actorName: principal.kind === 'user' ? principal.displayName : 'system',
      action: 'agent.revoke',
      targetId: agentId,
      detail: JSON.stringify({ name: agent.name }),
    },
  });

  return updated;
}

/** Issues a fresh key, invalidating the previous one. */
export async function rotateAgentKey(
  principal: Principal,
  workspaceId: string,
  agentId: string
): Promise<{ apiKey: string }> {
  const context = await authorize(principal, workspaceId, 'inspect');
  if (!context.isOwner) throw errors.accessDenied('rotate agent keys');

  const agent = await getPrisma().agent.findFirst({
    where: { id: agentId, workspaceId: context.workspaceId },
  });
  if (!agent) throw errors.notFound('Agent');

  const { key, hash, prefix } = generateApiKey();
  await getPrisma().agent.update({
    where: { id: agentId },
    data: { keyHash: hash, keyPrefix: prefix, revokedAt: null },
  });

  return { apiKey: key };
}

export type { AccessContext };
