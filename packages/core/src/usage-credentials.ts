/**
 * The workspace's provider credential: linking it, clearing it, saying whether
 * it is there.
 *
 * Kept apart from secrets.ts so that file stays a reviewable crypto primitive
 * that knows nothing about workspaces, owners or OpenRouter — and apart from
 * providers/openrouter.ts so an adapter stays an adapter and does not also own
 * an owner-only mutation. What lives here is the policy: who may link a key,
 * what is checked before it is stored, and what may be read back afterwards.
 *
 * Three rules, and the file is mostly them:
 *
 *   OWNER ONLY. §2 puts granting access in the owner's hands, and this is a
 *   credential that can be spent. An agent cannot link one even for its own
 *   workspace — the thing being measured does not get to choose the instrument.
 *
 *   CHECKED BEFORE STORED. A key is presented to OpenRouter once before it is
 *   written. A typo stored silently does not fail at link time, it fails months
 *   later as a workspace that mysteriously earns nothing.
 *
 *   NEVER READ BACK. Nothing here returns the key, and nothing else in the
 *   package exposes it. What comes back is whether one is linked, when, and its
 *   last four characters — enough for an owner to recognise which key they
 *   linked, useless to anyone who obtains it.
 *
 * And the sentence the brief insists on wherever rewards are described, because
 * this is the screen where someone hands over a key expecting money: rewards
 * follow confirmed spend out of a fixed, pre-funded pool. Linking a key does not
 * promise the spend comes back, and spending more does not add anything to the
 * pool.
 */

import { authorize } from './access';
import { getPrisma } from './db';
import { errors } from './errors';
import { probeOpenRouterKey } from './providers/openrouter';
import { encryptSecret, secretHint, secretsConfigured } from './secrets';
import type { Principal } from './types';
import type { UsageProvider } from './usage';

/** What the console may know. Note what is absent. */
export interface UsageCredentialStatus {
  provider: UsageProvider;
  linked: boolean;
  /** Last four characters, or empty. Identifies a key; is not one. */
  hint: string;
  linkedAt: string | null;
}

/**
 * The shortest string that could plausibly be a key.
 *
 * The prefix is NOT checked. OpenRouter keys look like `sk-or-v1-…` today, and a
 * client that hard-codes today's prefix rejects tomorrow's valid key for a
 * cosmetic reason. The real check is the one below: ask OpenRouter.
 */
const MIN_KEY_LENGTH = 16;

async function ownerContext(principal: Principal, workspaceId: string, operation: string) {
  const context = await authorize(principal, workspaceId, 'inspect');
  if (!context.isOwner) throw errors.accessDenied(operation);
  return context;
}

function statusOf(workspace: {
  usageProvider: string;
  usageKeyCipher: string | null;
  usageKeyHint: string;
  usageLinkedAt: Date | null;
}): UsageCredentialStatus {
  return {
    provider: workspace.usageProvider as UsageProvider,
    linked: Boolean(workspace.usageKeyCipher),
    hint: workspace.usageKeyHint,
    linkedAt: workspace.usageLinkedAt ? workspace.usageLinkedAt.toISOString() : null,
  };
}

/** Whether a credential is linked, and which one. Never what it is. */
export async function getUsageCredential(
  principal: Principal,
  workspaceId: string
): Promise<UsageCredentialStatus> {
  const context = await ownerContext(principal, workspaceId, 'read the usage provider credential');

  const workspace = await getPrisma().workspace.findUnique({
    where: { id: context.workspaceId },
    select: {
      usageProvider: true,
      usageKeyCipher: true,
      usageKeyHint: true,
      usageLinkedAt: true,
    },
  });

  if (!workspace) throw errors.notFound('Workspace');
  return statusOf(workspace);
}

/**
 * Links the workspace's OpenRouter key.
 *
 * Order matters and is the point of the function: configuration is checked, then
 * the key is checked against OpenRouter, and only then is anything written. A
 * key that was never going to work is never stored, and a key that would have to
 * be stored in plaintext is never stored either.
 */
export async function setUsageCredential(
  principal: Principal,
  workspaceId: string,
  apiKey: string
): Promise<UsageCredentialStatus> {
  const context = await ownerContext(principal, workspaceId, 'link a usage provider credential');

  const key = (apiKey ?? '').trim();
  if (key.length < MIN_KEY_LENGTH) {
    throw errors.validation('That does not look like an OpenRouter key.');
  }

  // Checked before the network call, so a server missing its encryption key
  // says so immediately instead of after a round trip that cannot be used.
  if (!secretsConfigured()) {
    throw errors.validation(
      'This server cannot store credentials: OFFCUT_SECRET_KEY is not configured. ' +
        'Nothing was stored. An administrator has to set it before a key can be linked.'
    );
  }

  const probe = await probeOpenRouterKey(key);

  if (!probe.ok && probe.reason === 'rejected') {
    throw errors.validation(
      'OpenRouter did not accept this key. Check it was copied whole and has not been revoked.'
    );
  }

  if (!probe.ok && probe.reason === 'malformed') {
    // Deliberately not folded into either sentence around it. It is not the
    // refusal above, because OpenRouter was never asked and saying it refused
    // would blame a service that did nothing. It is not the outage below,
    // because there is no outage and "try again in a moment" is advice that can
    // never come good — the exact way a workspace ends up confirming nothing
    // while its owner retries, which the CHECKED BEFORE STORED rule exists to
    // prevent. The cause is named instead, since it is one a person can fix.
    throw errors.validation(
      'This key cannot be sent in a request header, so it never left this server and nothing ' +
        'was stored. A key copied out of a rendered page, a PDF or a word processor picks up ' +
        'invisible spaces and curly dashes that look right and are not. Copy it again from ' +
        'OpenRouter as plain text.'
    );
  }

  if (!probe.ok) {
    // A 400 is not quite what this is — the request was fine and the key may be
    // perfect; OpenRouter was unreachable. A dedicated upstream code would map
    // to 502, but adding one to OffcutErrorCode changes how every surface maps
    // errors (§4, invariant 8), which is a wider change than this one. The
    // message carries the meaning that matters: nothing was stored, try again.
    throw errors.validation(
      'OpenRouter could not be reached, so this key was not checked and nothing was stored. ' +
        'Try again in a moment.'
    );
  }

  // Bound to the workspace id: a ciphertext lifted out of one workspace's row
  // and pasted into another's fails to decrypt rather than quietly making a
  // second workspace verify its spend against somebody else's account.
  const updated = await getPrisma().workspace.update({
    where: { id: context.workspaceId },
    data: {
      usageProvider: 'openrouter',
      usageKeyCipher: encryptSecret(key, context.workspaceId),
      usageKeyHint: secretHint(key),
      usageLinkedAt: new Date(),
    },
    select: {
      usageProvider: true,
      usageKeyCipher: true,
      usageKeyHint: true,
      usageLinkedAt: true,
    },
  });

  // A new key gets to answer again for everything the old one could not.
  //
  // The failure this exists for: an owner links the wrong OpenRouter key — a
  // second account, a revoked one, a personal key where the team's belonged —
  // and a day of real spend settles as `rejected`, because that key genuinely
  // does not know those requests. Linking the right key afterwards fixed
  // nothing: a settled row is never re-asked, so the money stayed gone with no
  // error anywhere to explain it.
  //
  // Only this workspace's rejections, and only rejections: `verified` rows are
  // untouched, so re-linking can never re-pay something already paid. What it
  // can do is cost a second provider call per row, which is the right price for
  // not silently discarding somebody's spend.
  await getPrisma().modelUsage.updateMany({
    where: { workspaceId: context.workspaceId, status: 'rejected' },
    data: { status: 'pending', rejectedReason: '', verifiedAt: null },
  });

  return statusOf(updated);
}

/**
 * Unlinks the credential.
 *
 * Reports already verified keep their money: what was confirmed was confirmed,
 * and a closed period is not reopened. Reports still pending simply stop being
 * asked about until a key is linked again — deferred, not rejected, for the same
 * reason an outage defers.
 */
export async function clearUsageCredential(
  principal: Principal,
  workspaceId: string
): Promise<UsageCredentialStatus> {
  const context = await ownerContext(principal, workspaceId, 'clear a usage provider credential');

  const updated = await getPrisma().workspace.update({
    where: { id: context.workspaceId },
    data: { usageKeyCipher: null, usageKeyHint: '', usageLinkedAt: null },
    select: {
      usageProvider: true,
      usageKeyCipher: true,
      usageKeyHint: true,
      usageLinkedAt: true,
    },
  });

  return statusOf(updated);
}
