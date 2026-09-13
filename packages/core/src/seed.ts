/**
 * Demo data, with a clock.
 *
 * Builds the §3.6 scenario for real — three agents writing in three separate
 * sessions — plus an open conflict and a resolved one, so the console shows the
 * behaviour that matters on first load rather than an empty state.
 *
 * WHAT CHANGED, AND WHY IT HAD TO. This story used to be written in one burst:
 * twelve records 159 milliseconds apart, five keys minted in the same tenth of
 * a second, a conflict detected and resolved before the first record was a
 * second old. Every surface that reads time then had to lie or give up. The
 * bench drew twelve slices in one column. The feed said "just now" thirty
 * times. "Three subagents worked in separate sessions" was the one sentence the
 * data itself contradicted. So the story is now told against a believable
 * clock: the researcher's morning, the developer's afternoon, the tester's next
 * day, the architect's review and the owner's decision after that — nearly
 * three days end to end, which is what the drawing was built to show.
 *
 * BACKDATING LIVES HERE AND NOWHERE ELSE. A caller must never be able to say
 * when a record was written: provenance is the product, and a memory whose
 * timestamps can be dictated by whoever is writing is a memory that cannot be
 * used as evidence of anything (§3.2, invariant 1). So there is no option on
 * Memory.add, nothing on the HTTP body, nothing in the SDK or the MCP tool
 * schema. The clock is applied from OUTSIDE the API, by this file, straight
 * against the database, AFTER each operation has run through the ordinary path
 * with its ordinary checks. That the mechanism is unreachable is structural
 * rather than promised: this module is not exported from index.ts, the package
 * exports map offers no subpath, and package.json omits dist/seed.js from the
 * tarball, so there is no import that reaches it from the SDK, the MCP server
 * or the API.
 *
 * Re-runnable, but no longer destructive by default. `pnpm seed` on a machine
 * that already has the demo workspace leaves it alone and says so; deleting
 * somebody's workspace because they ran setup twice is not a thing a seed gets
 * to do quietly. `pnpm seed --reset` deletes the demo workspace — that one,
 * named by slug and by owner — and builds it again. It touches nothing
 * belonging to any other account, and nothing else belonging to this one.
 */

import { authenticateAgent } from './access';
import { createAgent, createUser, createWorkspace, verifyUserCredentials } from './admin';
import { getPrisma, disconnectPrisma, type Db } from './db';
import { Memory } from './memory';
import type { Principal } from './types';

export const DEMO_EMAIL = 'demo@offcut.dev';
export const DEMO_PASSWORD = 'offcut-demo';
export const WORKSPACE_NAME = 'Atlas Release';

/**
 * The demo workspace's slug, and half of what --reset is allowed to match on.
 *
 * Slugs are unique across the install, so if some other account already holds
 * `atlas-release` the demo one is created as `atlas-release-a1b2` instead —
 * which is exactly why the reset matches on the OWNER as well, and why it will
 * not delete a workspace called Atlas Release that belongs to anybody else.
 */
export const WORKSPACE_SLUG = 'atlas-release';

const uid = (label: string) => `seed-${label}-${Math.random().toString(36).slice(2, 10)}`;

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * Moves every row this workspace gained since `since` to the instant `when`.
 *
 * A sweep by time rather than a list of ids on purpose. One `add` writes a
 * record, its links, a conflict when it contradicts something, a stale mark on
 * every block that cited it and an audit entry — and the day one of those gains
 * a sibling, a seed that named its tables by hand would go on backdating five
 * rows out of six and leave the sixth stamped with the moment the seed ran.
 * Sweeping catches whatever the operation actually wrote.
 *
 * Bounded twice over: `workspaceId` on every clause means no row outside the
 * demo workspace is reachable from here at all, and `since` is captured
 * immediately before the operation, so rows from earlier chapters — already
 * moved days into the past — cannot match.
 */
async function backdate(db: Db, workspaceId: string, since: Date, when: Date): Promise<void> {
  const fresh = { gte: since };

  await db.agent.updateMany({ where: { workspaceId, createdAt: fresh }, data: { createdAt: when } });
  await db.agent.updateMany({
    where: { workspaceId, lastSeenAt: fresh },
    data: { lastSeenAt: when },
  });

  await db.memoryRecord.updateMany({
    where: { workspaceId, createdAt: fresh },
    data: { createdAt: when },
  });
  await db.memoryRecord.updateMany({
    where: { workspaceId, deletedAt: fresh },
    data: { deletedAt: when },
  });

  await db.recordLink.updateMany({
    where: { workspaceId, createdAt: fresh },
    data: { createdAt: when },
  });

  await db.conflict.updateMany({
    where: { workspaceId, detectedAt: fresh },
    data: { detectedAt: when },
  });
  await db.conflict.updateMany({
    where: { workspaceId, resolvedAt: fresh },
    data: { resolvedAt: when },
  });

  await db.mergedBlock.updateMany({
    where: { workspaceId, createdAt: fresh },
    data: { createdAt: when },
  });
  await db.mergedBlock.updateMany({
    where: { workspaceId, rebuiltAt: fresh },
    data: { rebuiltAt: when },
  });
  await db.mergedBlock.updateMany({
    where: { workspaceId, staleAt: fresh },
    data: { staleAt: when },
  });

  await db.auditEvent.updateMany({
    where: { workspaceId, createdAt: fresh },
    data: { createdAt: when },
  });

  await db.idempotencyEntry.updateMany({
    where: { workspaceId, createdAt: fresh },
    data: { createdAt: when },
  });

  await db.deletionLedgerEntry.updateMany({
    where: { workspaceId, deletedAt: fresh },
    data: { deletedAt: when },
  });

  // The recall cache is not swept. Nothing in this story recalls, so there is
  // never a row; and a cache entry's time is about expiry, not about the story.
}

/**
 * Tells the story one chapter at a time, stamping each with the hour it happened.
 *
 * The operation runs FIRST and in full, through the same Memory API any agent
 * uses — the access checks, the conflict detection, the idempotency, all of it.
 * Only then is the wall clock swapped for the story's. Backdating before the
 * write would mean building the demo through some second, weaker path, and a
 * demo that does not come out of the real code is worth nothing.
 */
function chapters(db: Db, workspaceId: string) {
  let since = new Date();

  return async function at<T>(when: Date, write: () => Promise<T>): Promise<T> {
    const result = await write();
    await backdate(db, workspaceId, since, when);
    since = new Date();
    return result;
  };
}

/**
 * Three days of a small team, counted back from whenever the seed is run.
 *
 * Relative rather than fixed dates, because the console says "2 days ago" and a
 * demo that was seeded in March should not open on a feed full of entries from
 * March. Built with setDate/setHours rather than by adding milliseconds so that
 * a story spanning a daylight-saving change still starts at nine in the morning.
 */
function storyClock(now: Date) {
  return (daysAgo: number, hour: number, minute: number): Date => {
    const moment = new Date(now.getTime());
    moment.setDate(moment.getDate() - daysAgo);
    moment.setHours(hour, minute, 0, 0);
    return moment;
  };
}

// ---------------------------------------------------------------------------
// The reset
// ---------------------------------------------------------------------------

export interface DeletedWorkspace {
  id: string;
  slug: string;
  name: string;
}

/**
 * Deletes the demo workspace, and only ever the demo workspace.
 *
 * Two conditions, both required: the owner is the account this file created,
 * looked up by its literal email, and the workspace is the one this file
 * creates — by slug, or by the name the slug came from in case the slug was
 * taken and got a suffix. A workspace of another owner's cannot match the first
 * condition, and another workspace of the demo owner's cannot match the second,
 * which is the whole safety argument and the thing the suite pins.
 *
 * Returns what it removed rather than logging it, so a caller — the test above
 * all — can assert on exactly what went.
 */
export async function resetDemoWorkspace(): Promise<DeletedWorkspace[]> {
  const db = getPrisma();

  const owner = await db.user.findUnique({ where: { email: DEMO_EMAIL }, select: { id: true } });
  if (!owner) return [];

  const doomed = await db.workspace.findMany({
    where: {
      ownerId: owner.id,
      OR: [{ slug: WORKSPACE_SLUG }, { name: WORKSPACE_NAME }],
    },
    select: { id: true, slug: true, name: true },
  });

  // One at a time, by id. deleteMany with the same filter would be fewer round
  // trips and a worse thing to get wrong: this way the rows that go are exactly
  // the rows that were read and returned.
  for (const workspace of doomed) {
    await db.workspace.delete({ where: { id: workspace.id } });
  }

  return doomed;
}

// ---------------------------------------------------------------------------
// The story
// ---------------------------------------------------------------------------

export interface SeedOptions {
  /** Delete the demo workspace first. Without it, an existing one is left alone. */
  reset?: boolean;
  /** The day the story is counted back from. Defaults to the wall clock. */
  now?: Date;
  /** Where the report goes. Silence it in a test. */
  log?: (line: string) => void;
}

export interface SeedResult {
  workspaceId: string;
  slug: string;
  /** False when the demo workspace was already there and --reset was not asked for. */
  created: boolean;
  /** Agent name to plaintext key. Empty when nothing was created. */
  keys: Record<string, string>;
  records: number;
  openConflicts: number;
  /** The first and last instants the story claims. */
  from: Date | null;
  to: Date | null;
}

export async function seedDemo(options: SeedOptions = {}): Promise<SeedResult> {
  const db = getPrisma();
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? new Date();
  const on = storyClock(now);

  // --- Account ------------------------------------------------------------
  let userId: string;
  try {
    const created = await createUser({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      displayName: 'Demo Owner',
    });
    userId = created.id;
    log(`Created account ${DEMO_EMAIL}`);
  } catch {
    const existing = await verifyUserCredentials(DEMO_EMAIL, DEMO_PASSWORD);
    userId = existing.id;
    log(`Reusing account ${DEMO_EMAIL}`);
  }

  if (options.reset) {
    for (const gone of await resetDemoWorkspace()) {
      log(`Removed the previous demo workspace ${gone.name} (${gone.slug})`);
    }
  } else {
    const standing = await db.workspace.findFirst({
      where: { ownerId: userId, OR: [{ slug: WORKSPACE_SLUG }, { name: WORKSPACE_NAME }] },
      select: { id: true, slug: true },
    });
    if (standing) {
      log(`The demo workspace ${standing.slug} is already here. Run "pnpm seed --reset" to rebuild it.`);
      return {
        workspaceId: standing.id,
        slug: standing.slug,
        created: false,
        keys: {},
        records: 0,
        openConflicts: 0,
        from: null,
        to: null,
      };
    }
  }

  const owner: Principal = {
    kind: 'user',
    userId,
    email: DEMO_EMAIL,
    displayName: 'Demo Owner',
  };

  const opened = on(3, 8, 40);

  const workspace = await createWorkspace({
    ownerId: userId,
    name: WORKSPACE_NAME,
    description:
      'Offline-first release. Three subagents worked in separate sessions; the lead agent inherits their merged memory.',
    contextLimit: 6000,
  });

  // The demo workspace names a model that exists on OpenRouter, so turning
  // the section 9 module on in the console works without editing anything.
  // It stays DISABLED by default - only the slug is pre-filled.
  //
  // createdAt is set here rather than by the sweep below because a workspace
  // row has no workspaceId to sweep by. updatedAt is Prisma's own @updatedAt
  // and cannot be dictated; nothing reads it, and it is honest as the moment
  // the seed ran.
  await db.workspace.update({
    where: { id: workspace.id },
    data: { modelName: 'anthropic/claude-haiku-4.5', createdAt: opened },
  });

  const ws = workspace.id;
  const at = chapters(db, ws);

  // --- Agents -------------------------------------------------------------
  // Minted one after another over five minutes, the way an owner actually sets
  // a swarm up: paste a key into one config, come back, mint the next.
  const keys: Record<string, string> = {};

  async function agent(
    name: string,
    kind: 'lead' | 'subagent',
    permissions: Record<string, boolean> = {}
  ): Promise<Memory> {
    const created = await createAgent(owner, ws, { name, kind, permissions });
    keys[name] = created.apiKey;
    return new Memory(await authenticateAgent(created.apiKey));
  }

  const researcher = await at(on(3, 8, 41), () => agent('Researcher', 'subagent'));
  const developer = await at(on(3, 8, 42), () => agent('Developer', 'subagent'));
  const tester = await at(on(3, 8, 43), () => agent('Tester', 'subagent'));
  const architect = await at(on(3, 8, 44), () => agent('Architect', 'subagent'));
  await at(on(3, 8, 45), () => agent('Lead', 'lead', { canExport: true, canImport: true }));

  // --- Session 1: the researcher, that morning ----------------------------
  const r1 = await at(on(3, 9, 12), () =>
    researcher.add({
      workspaceId: ws,
      type: 'fact',
      text: 'The application must work offline. Field staff lose connectivity for hours at a time.',
      topic: 'release-1',
      source: 'product brief, section 2',
      idempotencyKey: uid('r1'),
    })
  );

  await at(on(3, 9, 41), () =>
    researcher.add({
      workspaceId: ws,
      type: 'fact',
      text: 'Competitor apps sync every 30 seconds and are unusable on rural sites.',
      topic: 'research',
      source: 'field interviews, 9 respondents',
      idempotencyKey: uid('r2'),
    })
  );

  await at(on(3, 10, 27), () =>
    researcher.add({
      workspaceId: ws,
      type: 'hypothesis',
      text: 'Users will accept a longer first-run setup if it removes the need for a connection later.',
      topic: 'research',
      source: 'interview synthesis',
      idempotencyKey: uid('r3'),
    })
  );

  // --- Session 2: the developer, that afternoon ---------------------------
  const d1 = await at(on(3, 14, 5), () =>
    developer.add({
      workspaceId: ws,
      type: 'decision',
      text: 'Project data is stored locally in SQLite and synchronised when a connection returns.',
      topic: 'release-1',
      source: 'architecture call',
      factKey: 'storage.location',
      factValue: 'local',
      factContext: 'release-1',
      idempotencyKey: uid('d1'),
    })
  );

  await at(on(3, 14, 38), () =>
    developer.add({
      workspaceId: ws,
      type: 'decision',
      text: 'Conflict resolution on sync is last-writer-wins per field, with a visible history.',
      topic: 'sync',
      source: 'architecture call',
      factKey: 'sync.strategy',
      factValue: 'last-writer-wins',
      factContext: 'release-1',
      idempotencyKey: uid('d2'),
    })
  );

  await at(on(3, 16, 12), () =>
    developer.add({
      workspaceId: ws,
      type: 'result',
      text: 'Local write throughput measured at 4,200 records per second on the reference device.',
      topic: 'performance',
      source: 'benchmark run',
      idempotencyKey: uid('d3'),
    })
  );

  // --- Session 3: the tester, the next day --------------------------------
  const t1 = await at(on(2, 10, 3), () =>
    tester.add({
      workspaceId: ws,
      type: 'result',
      text: 'One saved record disappears after a restart. Reproducible on 3 of 10 runs.',
      topic: 'release-1',
      source: 'regression run #148',
      idempotencyKey: uid('t1'),
    })
  );

  await at(on(2, 11, 20), () =>
    tester.add({
      workspaceId: ws,
      type: 'result',
      text: 'Sync recovers correctly after a 6-hour offline window.',
      topic: 'sync',
      source: 'regression run #148',
      idempotencyKey: uid('t2'),
    })
  );

  // The same finding, independently observed. Retrieval collapses it to one
  // item; both authors survive (§3.3 row 1, invariant 3).
  await at(on(2, 11, 47), () =>
    tester.add({
      workspaceId: ws,
      type: 'result',
      text: 'Local write throughput measured at 4,200 records per second on the reference device.',
      topic: 'performance',
      source: 'independent verification',
      idempotencyKey: uid('t3'),
    })
  );

  // --- An open conflict, at the platform review the day after -------------
  // The architect disagrees about storage. Two values of ONE named fact in one
  // context: code detects this without any model (§3.3 row 3).
  await at(on(1, 9, 30), () =>
    architect.add({
      workspaceId: ws,
      type: 'decision',
      text: 'Project data is stored in the cloud with an offline read cache.',
      topic: 'release-1',
      source: 'platform review',
      factKey: 'storage.location',
      factValue: 'cloud',
      factContext: 'release-1',
      idempotencyKey: uid('a1'),
    })
  );

  // --- A conflict that gets resolved -------------------------------------
  await at(on(1, 9, 52), () =>
    architect.add({
      workspaceId: ws,
      type: 'decision',
      text: 'Sync conflicts should be resolved by explicit user choice, not automatically.',
      topic: 'sync',
      source: 'platform review',
      factKey: 'sync.strategy',
      factValue: 'user-choice',
      factContext: 'release-1',
      idempotencyKey: uid('a2'),
    })
  );

  const ownerMemory = new Memory(owner);
  const conflicts = await ownerMemory.conflicts(ws);
  const syncConflict = conflicts.find((conflict) => conflict.factKey === 'sync.strategy');

  if (syncConflict) {
    await at(on(1, 15, 40), () =>
      ownerMemory.resolve({
        workspaceId: ws,
        conflictId: syncConflict.id,
        chosenRecordId: syncConflict.sides.find((side) => side.value === 'last-writer-wins')!
          .recordId,
        rationale:
          'Field staff cannot be asked to arbitrate merges offline. Revisit once the history view ships.',
        idempotencyKey: uid('resolve'),
      })
    );
  }

  // --- An explicit update link (§3.6: the fix does not erase T1) ----------
  await at(on(1, 17, 5), () =>
    developer.add({
      workspaceId: ws,
      type: 'result',
      text: 'Restart data loss traced to an unflushed write-ahead log. Fix in commit a91f2c.',
      topic: 'release-1',
      source: 'commit a91f2c',
      links: [{ kind: 'updates', recordId: t1.recordId, note: 'fix for the restart bug' }],
      idempotencyKey: uid('fix'),
    })
  );

  // --- Build the derived blocks ------------------------------------------
  const closed = on(1, 17, 30);
  await at(closed, () => ownerMemory.merge({ workspaceId: ws, idempotencyKey: uid('merge') }));

  // An agent was last seen when it last wrote, not when its key was minted.
  // The roster prints that column, and "last seen 08:41" beside three records
  // written all afternoon is the seed contradicting itself in two places at once.
  await touchLastSeen(db, ws);

  // --- Report -------------------------------------------------------------
  const stats = await ownerMemory.inspect({ workspaceId: ws });
  const open = await ownerMemory.conflicts(ws);

  log('');
  log('  OFFCUT AGENT - demo workspace ready');
  log('  ------------------------------------------------------------');
  log(`  Workspace      ${workspace.name}  (${workspace.slug})`);
  log(`  Records        ${stats.records.length} current`);
  log(`  Open conflicts ${open.length}`);
  log(`  Written        ${opened.toLocaleString()} -> ${closed.toLocaleString()}`);
  log(`  Scenario       R1=${r1.recordId}  D1=${d1.recordId}  T1=${t1.recordId}`);
  log('');
  log('  Sign in to the console with');
  log(`    email     ${DEMO_EMAIL}`);
  log(`    password  ${DEMO_PASSWORD}`);
  log('');
  log('  Agent keys (shown once - these are demo keys, regenerate for real use):');
  for (const [name, apiKey] of Object.entries(keys)) {
    log(`    ${name.padEnd(12)} ${apiKey}`);
  }
  log('');

  return {
    workspaceId: ws,
    slug: workspace.slug,
    created: true,
    keys,
    records: stats.records.length,
    openConflicts: open.length,
    from: opened,
    to: closed,
  };
}

/** Moves each agent's lastSeenAt to its own last write, leaving silent agents alone. */
async function touchLastSeen(db: Db, workspaceId: string): Promise<void> {
  const agents = await db.agent.findMany({ where: { workspaceId }, select: { id: true } });
  for (const agent of agents) {
    const latest = await db.memoryRecord.findFirst({
      where: { workspaceId, agentId: agent.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (!latest) continue;
    await db.agent.update({ where: { id: agent.id }, data: { lastSeenAt: latest.createdAt } });
  }
}

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await seedDemo({ reset: process.argv.includes('--reset') });
}

// Only when run as a script. Imported — by the suite, and by nothing else that
// ships — this module defines functions and writes nothing.
if (require.main === module) {
  main()
    .catch((error) => {
      console.error('Seed failed:', error);
      process.exitCode = 1;
    })
    .finally(() => disconnectPrisma());
}
