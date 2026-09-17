/**
 * What this account is paid on, and where it would be paid.
 *
 * Deliberately not under /workspaces: spend is made by subagents in every
 * workspace a person owns, and it is paid to one address belonging to that
 * person. A per-workspace endpoint would make the console stitch a total out of
 * N calls and get it wrong the first time somebody makes a second workspace.
 *
 * TWO FIGURES PAY, AND THEY ARE BOTH HERE. `confirmedSpend` is the spend layer;
 * `memory` is the memory layer the owner added on 2026-09-21 — records this
 * account's agents wrote that another agent retrieved, one credit per record,
 * once ever. Each is priced against its own daily ceiling and its own rate and
 * the two are added into one accrual, one root, one claim.
 *
 * Which makes the sentence this endpoint exists to support: somebody running
 * Claude Code on a subscription confirms no spend this service can see, earns
 * NOTHING from the first layer however hard they work, and earns from the
 * second when their memory is useful to an agent that is not theirs.
 *
 * `earned` is the older name for the same credits, kept because the console
 * reads it, and kept counted in retrievals. It was a product statistic that
 * decided no money and is now the memory layer's unit; `memory` is the block to
 * read, and the two must never disagree, because they are one query apart.
 *
 * Integer millionths of a dollar all the way out, and no dollars at all. A point
 * is one millionth of a dollar of confirmed spend; the dollar figure a person
 * reads is derived at the edge, by formatSpend in the console, which is string
 * arithmetic over a BigInt. Nothing here divides by a million: a float that
 * crossed this boundary would be a rounding error in a payable amount that
 * nobody downstream could audit or even see.
 *
 * `unconfirmed` is the other half of that figure and is not optional. Confirmed
 * spend alone cannot tell "your agents spent nothing" from "everything they
 * reported was refused" - both are zero, they mean opposite things, and only
 * one of them is the reader's to act on. The console promises on the landing
 * page to name the reports that earn nothing and why, and this is the only
 * place that knows: the reason a provider gave is written to the usage row and
 * read by nothing else.
 *
 * Points and credits, never tokens. What either is worth in $OFFCUT is decided
 * by the publisher when it builds a root - each layer priced at its own rate,
 * capped at its own period ceiling and split pro rata among that layer's
 * earners - so the answer is not known until the period closes and is not this
 * process's to guess. The claimable token amount
 * lives in the published root and on the chain, and the console reads it from
 * there.
 */

import { Controller, Get } from '@nestjs/common';
import {
  accrualsFor,
  agentActivity,
  creditsInWindow,
  earnedEver,
  getLinkedWallet,
  getPrisma,
  spendByWorkspace,
  spendEver,
  unconfirmedUsage,
} from '@offcut/core';
import { CurrentUser } from '../auth/principal.guard';

@Controller('rewards')
export class RewardsController {
  /**
   * @CurrentUser rather than @CurrentPrincipal: an agent has no wallet and no
   * earnings of its own. It spends FOR the owner of the workspace it is
   * connected to, which is the person holding this session.
   */
  @Get()
  async summary(@CurrentUser() user: { userId: string }) {
    const db = getPrisma();

    // A rolling thirty days ending now, measured once so the two figures below
    // cannot be taken a millisecond apart and disagree. Not a calendar month
    // and not a reward period: the reader is asking "lately".
    const generatedAt = new Date();
    const thirtyDaysAgo = new Date(generatedAt.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Read here rather than through listWorkspaces, which cannot return the
    // usage columns and charges two count queries per workspace for figures
    // this endpoint does not show. Same ownerId filter, same ordering.
    const owned = await db.workspace.findMany({
      where: { ownerId: user.userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        usageProvider: true,
        usageKeyCipher: true,
        usageKeyHint: true,
        usageLinkedAt: true,
      },
    });

    const rows = await Promise.all(
      owned.map(async (workspace) => ({
        workspaceId: workspace.id,
        name: workspace.name,
        confirmedMicros: await spendEver(db, workspace.id),
        retrievals: await earnedEver(db, workspace.id),
        credential: {
          provider: workspace.usageProvider,
          // The ciphertext is reduced to a boolean on the line it is read, and
          // no variable that outlives this expression holds it. The same
          // reduction core makes, for the same reason: a field that never
          // exists downstream cannot be spread into a response body by a later
          // edit, logged by a later debug line, or asked for by a later caller.
          linked: workspace.usageKeyCipher !== null,
          hint: workspace.usageKeyHint,
          linkedAt: workspace.usageLinkedAt ? workspace.usageLinkedAt.toISOString() : null,
        },
      }))
    );

    // One groupBy for the account rather than one query per workspace. The
    // window is exclusive at `generatedAt`, matching every other window in this
    // codebase, so a credit written in this millisecond appears in the next
    // read rather than in two.
    const recentCredits = await creditsInWindow(
      db,
      { since: thirtyDaysAgo, until: generatedAt },
      { workspaceIds: owned.map((workspace) => workspace.id) }
    );
    const credits30dOf = new Map(recentCredits.map((row) => [row.workspaceId, row.credits]));

    return {
      wallet: await getLinkedWallet(user.userId),

      confirmedSpend: {
        micros: rows.reduce((total, row) => total + row.confirmedMicros, 0),

        // Every workspace, zeroes included - the opposite of the rule below,
        // and deliberately so. A zero beside `linked: false` is the answer to
        // "why is this account earning nothing", and dropping the row deletes
        // the answer: the reader is left to conclude they spent nothing when
        // what happened is that there is no key to ask the provider with.
        byWorkspace: rows.map((row) => ({
          workspaceId: row.workspaceId,
          name: row.name,
          micros: row.confirmedMicros,
          credential: row.credential,
        })),
      },

      // One query for the account rather than one per workspace: nothing here
      // is shown per workspace, and an account with forty of them should not
      // cost forty round trips to be told that nothing is waiting.
      unconfirmed: await unconfirmedUsage(
        db,
        owned.map((workspace) => workspace.id)
      ),

      earned: {
        points: rows.reduce((total, row) => total + row.retrievals, 0),
        // Workspaces nobody has retrieved from are left out rather than listed
        // as zeroes: a page of noughts reads as a broken feature.
        byWorkspace: rows
          .filter((row) => row.retrievals > 0)
          .map((row) => ({
            workspaceId: row.workspaceId,
            name: row.name,
            points: row.retrievals,
          })),
      },

      // THE SAME ROWS, UNDER THE NAME THAT NOW PAYS. `earned` above is the old
      // product statistic and keeps its old shape because the console reads it;
      // this is the memory REWARD LAYER, added 2026-09-21, and it is what
      // somebody running Claude Code on a subscription earns from. They confirm
      // no spend this service can see, so the block above them is zero forever
      // and this one is their whole answer.
      //
      // Every owned workspace, zeroes included - the same rule `confirmedSpend`
      // follows, and for the same reason: a nought here is the answer to "why
      // am I earning nothing", and dropping the row deletes the answer.
      memory: {
        creditsEver: rows.reduce((total, row) => total + row.retrievals, 0),
        credits30d: recentCredits.reduce((total, row) => total + row.credits, 0),
        byWorkspace: rows.map((row) => ({
          workspaceId: row.workspaceId,
          name: row.name,
          creditsEver: row.retrievals,
          credits30d: credits30dOf.get(row.workspaceId) ?? 0,
        })),
      },
    };
  }

  /**
   * WHERE THIS ACCOUNT STANDS: its agents, what they spent, what that accrued.
   *
   * `summary` answers "what is this account paid on". This answers the question
   * a person actually arrives with after connecting Claude Code to a workspace:
   * which of my agents are talking to this service, how much have they spent
   * through it, and what has that earned me. Same guard, same ownership filter,
   * same units - a second endpoint rather than a wider `summary`, because the
   * console reads `summary` on a screen that must not wait for a ledger scan.
   *
   * WHAT IT CANNOT SEE, AND SAYS SO ELSEWHERE. Not one figure here is Claude
   * Code's own Anthropic usage: this service is never told about it and has no
   * way to ask. Spend counted here is spend an agent REPORTED as OpenRouter
   * generation ids, through offcut_usage_report, and that OpenRouter then
   * confirmed against the key the workspace linked. An agent that reports
   * nothing spends nothing as far as this endpoint is concerned, however busy
   * it is. The surface that renders this owes the reader that sentence; this
   * one owes it only true numbers.
   *
   * REVOKED AGENTS ARE INCLUDED, flagged. A key somebody revoked is a key they
   * remember creating, and its records and reports did not stop existing when
   * it stopped working. Dropping the row would turn a deliberate act into a
   * missing agent and an unexplained gap in the totals.
   *
   * CLAIMED AND CLAIMABLE ARE ABSENT, deliberately. What has been claimed is on
   * the chain and what is claimable is in the published proof; both change
   * without this database hearing about it, so both are read by the browser
   * from the sources that own them. This endpoint answers for the basis only.
   */
  @Get('standing')
  async standing(@CurrentUser() user: { userId: string }) {
    const db = getPrisma();

    const owned = await db.workspace.findMany({
      where: { ownerId: user.userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true },
    });
    const workspaceIds = owned.map((workspace) => workspace.id);
    const nameOf = new Map(owned.map((workspace) => [workspace.id, workspace.name]));

    // A rolling window ending now, not a calendar month and not a reward
    // period: the reader is asking "lately", and a period is the publisher's
    // unit, not theirs. Computed once and reused so the two figures below
    // cannot be taken a millisecond apart and disagree.
    const generatedAt = new Date();
    const thirtyDaysAgo = new Date(generatedAt.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      wallet,
      agents,
      activity,
      everRows,
      recentRows,
      creditsEverRows,
      credits30dRows,
      unconfirmedReports,
    ] = await Promise.all([
        getLinkedWallet(user.userId),

        workspaceIds.length === 0
          ? []
          : db.agent.findMany({
              where: { workspaceId: { in: workspaceIds } },
              // Newest first: the key a person just made is the one they came
              // to look at.
              orderBy: { createdAt: 'desc' },
              select: {
                id: true,
                workspaceId: true,
                name: true,
                kind: true,
                keyPrefix: true,
                createdAt: true,
                lastSeenAt: true,
                revokedAt: true,
              },
            }),

        agentActivity(db, workspaceIds),
        spendByWorkspace(db, workspaceIds),
        spendByWorkspace(db, workspaceIds, { since: thirtyDaysAgo }),

        // The memory layer, read the same two ways. `since: new Date(0)` is
        // "every credit ever": one groupBy over the account's workspaces rather
        // than one aggregate per workspace, which is what earnedEver would cost
        // an account holding forty of them.
        workspaceIds.length === 0
          ? []
          : creditsInWindow(db, { since: new Date(0), until: generatedAt }, { workspaceIds }),
        workspaceIds.length === 0
          ? []
          : creditsInWindow(db, { since: thirtyDaysAgo, until: generatedAt }, { workspaceIds }),

        // Everything reported that is not paying - waiting for the provider, or
        // refused by it. One number here because the console already has
        // `summary` for the breakdown, and a person reading their standing needs
        // to know only that reports exist which are not in the total above.
        workspaceIds.length === 0
          ? 0
          : db.modelUsage.count({
              where: { workspaceId: { in: workspaceIds }, status: { not: 'verified' } },
            }),
      ]);

    const activityOf = new Map(activity.map((row) => [row.agentId, row]));
    const everOf = new Map(everRows.map((row) => [row.workspaceId, row.micros]));
    const recentOf = new Map(recentRows.map((row) => [row.workspaceId, row.micros]));
    const creditsEverOf = new Map(creditsEverRows.map((row) => [row.workspaceId, row.credits]));
    const credits30dOf = new Map(credits30dRows.map((row) => [row.workspaceId, row.credits]));

    // Empty but honest when nothing is linked. A zero under a heading is a
    // claim that a question was asked and answered; there is no address here to
    // ask about, and the console says so in words rather than drawing a nought.
    const earned = wallet.address
      ? await accrualsFor(db, wallet.address, { limit: 48 })
      : {
          address: null,
          cumulativeBaseUnits: '0',
          cumulativeSpendBaseUnits: '0',
          cumulativeMemoryBaseUnits: '0',
          periods: 0,
          recent: [],
        };

    return {
      agents: agents.map((agent) => ({
        id: agent.id,
        workspaceId: agent.workspaceId,
        workspaceName: nameOf.get(agent.workspaceId) ?? '',
        name: agent.name,
        kind: agent.kind,
        keyPrefix: agent.keyPrefix,
        createdAt: agent.createdAt.toISOString(),
        lastSeenAt: agent.lastSeenAt ? agent.lastSeenAt.toISOString() : null,
        revoked: agent.revokedAt !== null,
        records: activityOf.get(agent.id)?.records ?? 0,
        usageReports: activityOf.get(agent.id)?.usageReports ?? 0,
      })),

      spend: {
        confirmedMicros: everRows.reduce((total, row) => total + row.micros, 0),
        confirmedMicros30d: recentRows.reduce((total, row) => total + row.micros, 0),
        unconfirmedReports,

        // Every owned workspace, zeroes included - the same rule `summary`
        // follows, for the same reason: a zero is the answer to "why is this
        // account earning nothing", and dropping the row deletes the answer.
        byWorkspace: owned.map((workspace) => ({
          workspaceId: workspace.id,
          name: workspace.name,
          confirmedMicros: everOf.get(workspace.id) ?? 0,
          confirmedMicros30d: recentOf.get(workspace.id) ?? 0,
        })),
      },

      // The second reward layer: records this account's agents wrote that an
      // agent which did not write them retrieved, counted once per record ever.
      // A Claude Code subscriber earns from THIS and from nothing above it -
      // their Anthropic spend is invisible to this service - so the surface
      // rendering it owes the reader that sentence in words.
      //
      // Credits, never an amount. What a credit is worth is decided when a
      // period closes, against the memory layer's own ceiling and rate, and the
      // result is in `earned` below with the spend layer's share beside it.
      memory: {
        creditsEver: creditsEverRows.reduce((total, row) => total + row.credits, 0),
        credits30d: credits30dRows.reduce((total, row) => total + row.credits, 0),
        byWorkspace: owned.map((workspace) => ({
          workspaceId: workspace.id,
          name: workspace.name,
          creditsEver: creditsEverOf.get(workspace.id) ?? 0,
          credits30d: credits30dOf.get(workspace.id) ?? 0,
        })),
      },

      earned,

      // Stamped by the server rather than inferred from when a response landed:
      // the window above was measured from this instant, and a reader comparing
      // two loads needs to know which one is older than the other.
      generatedAt: generatedAt.toISOString(),
    };
  }
}
