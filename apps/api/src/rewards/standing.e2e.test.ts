/**
 * GET /rewards/standing over HTTP.
 *
 * The endpoint exists because a person who has just connected Claude Code to a
 * workspace asks one question - "is it working, and what has it earned me" -
 * and until now the console could only answer half of it from three different
 * calls. So the things that can go wrong here are the things a wrong answer
 * would cost somebody:
 *
 *   ISOLATION   another account's agents, spend and accruals never appear. The
 *               ledger is keyed by ADDRESS, not by user, and an address is the
 *               only thing between two people's earnings.
 *   HONESTY     no wallet linked is answered as no wallet linked, not as zero
 *               earned; a revoked key is listed and flagged rather than dropped;
 *               reports that are not paying are counted separately from spend
 *               that is.
 *   UNITS       spend in whole millionths of a dollar, accruals as decimal
 *               strings of token base units. A float in either is money lost
 *               where nobody can see it.
 *
 * Driven over fetch against a real server, like the rest of the HTTP suite:
 * mounting the controller directly would skip the guard, which is half of what
 * isolation means here.
 */

import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { getPrisma } from '@offcut/core';
import { AppModule } from '../app.module';

let app: INestApplication;
let base: string;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  // Accruals hang off no workspace and no user, so nothing cascades them away
  // and the shared reset does not clear them. A row left behind by an earlier
  // test is indistinguishable from this account's own earnings.
  await getPrisma().rewardAccrual.deleteMany();
});

// ---------------------------------------------------------------------------
// A cookie-jar client, the same one the main HTTP suite uses.
// ---------------------------------------------------------------------------

function client(auth?: { apiKey?: string }) {
  let cookie = '';

  async function call<T>(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth?.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
    if (cookie) headers.Cookie = cookie;

    const response = await fetch(`${base}/api${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0]!;

    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  return {
    get: <T>(path: string) => call<T>('GET', path),
    post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
    put: <T>(path: string, body: unknown) => call<T>('PUT', path, body),
  };
}

const uid = () => Math.random().toString(36).slice(2, 10);

async function signedInOwner() {
  const owner = client();
  const registered = await owner.post<{ user: { id: string } }>('/auth/register', {
    email: `standing-${uid()}@offcut.test`,
    password: 'correct-horse-battery',
    displayName: 'Standing Owner',
  });
  expect(registered.status).toBe(201);
  return { owner, userId: registered.body.user.id };
}

async function makeWorkspace(owner: ReturnType<typeof client>, name: string) {
  const created = await owner.post<{ workspace: { id: string } }>('/workspaces', { name });
  expect(created.status).toBe(201);
  return created.body.workspace.id;
}

async function mintKey(owner: ReturnType<typeof client>, workspaceId: string, name: string) {
  const created = await owner.post<{ apiKey: string; agent: { id: string } }>(
    `/workspaces/${workspaceId}/agents`,
    { name, kind: 'subagent' }
  );
  expect(created.status).toBe(201);
  return created.body;
}

/**
 * Usage written straight to the store.
 *
 * Nothing reports usage over HTTP in this suite, and settling a report means a
 * live call to OpenRouter. What is under test is what the endpoint does with
 * rows that have already settled, not how they settle - that is core's suite.
 */
async function usage(
  workspaceId: string,
  agentId: string,
  status: 'pending' | 'verified' | 'rejected',
  micros: number,
  verifiedAt = new Date()
): Promise<void> {
  await getPrisma().modelUsage.create({
    data: {
      workspaceId,
      provider: 'openrouter',
      generationId: `gen-${uid()}${uid()}`,
      reportedByAgentId: agentId,
      reportedCostMicros: micros,
      status,
      verifiedCostMicros: status === 'verified' ? micros : 0,
      verifiedAt: status === 'pending' ? null : verifiedAt,
    },
  });
}

/** Ten-minute periods, the width the publisher accrues in. */
async function accrue(address: string, index: number, amount: string): Promise<void> {
  const base = Date.UTC(2026, 8, 20, 12, 0, 0);
  await getPrisma().rewardAccrual.create({
    data: {
      address,
      periodStart: new Date(base + index * 600_000),
      periodEnd: new Date(base + (index + 1) * 600_000),
      amount,
    },
  });
}

/**
 * A period settled since rewards had two layers: a total and the two parts it
 * was made of.
 *
 * Written straight to the store for the same reason `usage` is - what is under
 * test is what the endpoint does with rows that have already settled, not how
 * they settle, which is @offcut/rewards' suite.
 */
async function accrueSplit(
  address: string,
  index: number,
  spend: string,
  memory: string
): Promise<void> {
  const base = Date.UTC(2026, 8, 20, 12, 0, 0);
  await getPrisma().rewardAccrual.create({
    data: {
      address,
      periodStart: new Date(base + index * 600_000),
      periodEnd: new Date(base + (index + 1) * 600_000),
      amount: (BigInt(spend) + BigInt(memory)).toString(),
      spendAmount: spend,
      memoryAmount: memory,
    },
  });
}

/**
 * One credit: a record this workspace owns, used once by an agent that did not
 * write it.
 *
 * The agent ids are strings rather than rows because RewardCredit holds no
 * foreign key to them - the row is the fact that it happened, and it outlives
 * the key that caused it.
 */
async function credit(workspaceId: string, at = new Date()): Promise<void> {
  await getPrisma().rewardCredit.create({
    data: {
      workspaceId,
      recordId: `rec-${uid()}${uid()}`,
      authorAgentId: `author-${uid()}`,
      usedByAgentId: `reader-${uid()}`,
      points: 1,
      createdAt: at,
    },
  });
}

interface Standing {
  agents: {
    id: string;
    workspaceId: string;
    workspaceName: string;
    name: string;
    kind: string;
    keyPrefix: string;
    createdAt: string;
    lastSeenAt: string | null;
    revoked: boolean;
    records: number;
    usageReports: number;
  }[];
  spend: {
    confirmedMicros: number;
    confirmedMicros30d: number;
    unconfirmedReports: number;
    byWorkspace: {
      workspaceId: string;
      name: string;
      confirmedMicros: number;
      confirmedMicros30d: number;
    }[];
  };
  memory: {
    creditsEver: number;
    credits30d: number;
    byWorkspace: {
      workspaceId: string;
      name: string;
      creditsEver: number;
      credits30d: number;
    }[];
  };
  earned: {
    address: string | null;
    cumulativeBaseUnits: string;
    cumulativeSpendBaseUnits: string;
    cumulativeMemoryBaseUnits: string;
    periods: number;
    recent: {
      periodStart: string;
      periodEnd: string;
      amountBaseUnits: string;
      spendBaseUnits: string;
      memoryBaseUnits: string;
    }[];
  };
  generatedAt: string;
}

const MINE = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x2222222222222222222222222222222222222222';

/**
 * The fixture the whole file reads: one account, two workspaces, three agents
 * (one revoked), settled and unsettled usage, and three accrued periods beside
 * a stranger's period that must not be visible.
 */
async function seed() {
  const { owner } = await signedInOwner();

  const research = await makeWorkspace(owner, 'Research');
  const release = await makeWorkspace(owner, 'Release');

  const planner = await mintKey(owner, research, 'Planner');
  const reader = await mintKey(owner, research, 'Reader');
  const retired = await mintKey(owner, release, 'Retired');

  // One record, written by a connected agent exactly as one would be in life.
  const wrote = await client({ apiKey: planner.apiKey }).post(
    `/workspaces/${research}/memory/add`,
    {
      type: 'decision',
      text: 'The migration runs before the deploy, not after it.',
      topic: 'release-2',
      idempotencyKey: `standing-${uid()}`,
    }
  );
  expect(wrote.status).toBe(201);

  await client({ apiKey: retired.apiKey }).post(`/workspaces/${release}/memory/add`, {
    type: 'fact',
    text: 'The staging database is reset nightly.',
    topic: 'release-2',
    idempotencyKey: `standing-${uid()}`,
  });

  const revoked = await owner.post(`/workspaces/${release}/agents/${retired.agent.id}/revoke`, {});
  expect(revoked.status).toBe(201);

  // Confirmed inside the window, confirmed outside it, and one still waiting.
  await usage(research, reader.agent.id, 'verified', 1_200_000);
  await usage(
    research,
    reader.agent.id,
    'verified',
    800_000,
    new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)
  );
  await usage(release, retired.agent.id, 'verified', 42_000);
  await usage(research, reader.agent.id, 'pending', 999_000);

  const linked = await owner.put('/auth/wallet', { address: MINE });
  expect(linked.status).toBe(200);

  // Memory used by other agents: two credits inside the rolling window, one
  // outside it. A credit belongs to the workspace that OWNS the record.
  await credit(research);
  await credit(research);
  await credit(release, new Date(Date.now() - 45 * 24 * 60 * 60 * 1000));

  // Three settled periods: one from before the memory layer existed, which
  // carries a total and no parts; one paid by both layers; and one paid
  // entirely by memory - the Claude Code subscriber's period, which confirms no
  // spend this service can see and earns anyway.
  await accrue(MINE, 0, '1000000000000000001');
  await accrueSplit(MINE, 1, '2000000000000000000', '2');
  await accrueSplit(MINE, 2, '0', '3000000000000000003');
  // Another person's period, in the same table, one row away.
  await accrue(STRANGER, 0, '999000000000000000000');

  return { owner, research, release, planner, reader, retired };
}

// ---------------------------------------------------------------------------
describe('GET /rewards/standing', () => {
  it('answers with this account, its agents, its spend and its accruals', async () => {
    const { owner, research, release, planner, reader, retired } = await seed();

    const response = await owner.get<Standing>('/rewards/standing');
    expect(response.status).toBe(200);
    const standing = response.body;

    // Newest key first: the one a person has just made is the one they came to
    // look at.
    expect(standing.agents.map((agent) => agent.name)).toEqual([
      'Retired',
      'Reader',
      'Planner',
    ]);

    const byId = new Map(standing.agents.map((agent) => [agent.id, agent]));

    expect(byId.get(planner.agent.id)).toMatchObject({
      workspaceId: research,
      workspaceName: 'Research',
      kind: 'subagent',
      revoked: false,
      records: 1,
      usageReports: 0,
    });
    expect(byId.get(reader.agent.id)).toMatchObject({
      workspaceName: 'Research',
      revoked: false,
      records: 0,
      // Three rows: two confirmed and one still waiting. Every report counts
      // here, because a report that earns nothing is still proof the agent is
      // wired up.
      usageReports: 3,
    });
    // A key somebody revoked is listed, flagged, with its work intact.
    expect(byId.get(retired.agent.id)).toMatchObject({
      workspaceId: release,
      workspaceName: 'Release',
      revoked: true,
      records: 1,
      usageReports: 1,
    });

    // The prefix is the display-only head of the key that was handed over once:
    // enough for a person to tell two keys apart, never enough to authenticate.
    const prefix = byId.get(planner.agent.id)!.keyPrefix;
    expect(prefix).toMatch(/^offcut_sk_/);
    expect(planner.apiKey.startsWith(prefix)).toBe(true);

    // A connected agent leaves a timestamp; one that only ever existed does not.
    expect(byId.get(planner.agent.id)!.lastSeenAt).not.toBeNull();
    expect(byId.get(reader.agent.id)!.lastSeenAt).toBeNull();

    expect(standing.spend.confirmedMicros).toBe(2_042_000);
    // The 45-day-old confirmation is outside the rolling window and inside the
    // total. If these two were ever equal the window would be decorative.
    expect(standing.spend.confirmedMicros30d).toBe(1_242_000);
    expect(standing.spend.unconfirmedReports).toBe(1);

    expect(standing.spend.byWorkspace).toEqual([
      { workspaceId: release, name: 'Release', confirmedMicros: 42_000, confirmedMicros30d: 42_000 },
      {
        workspaceId: research,
        name: 'Research',
        confirmedMicros: 2_000_000,
        confirmedMicros30d: 1_200_000,
      },
    ]);

    // Records another agent used - the second reward layer. Counted in credits,
    // never in an amount: what a credit is worth is decided when a period
    // closes, and lands in `earned` below.
    expect(standing.memory.creditsEver).toBe(3);
    // The 45-day-old credit is outside the rolling window and inside the total.
    // If these two were ever equal the window would be decorative.
    expect(standing.memory.credits30d).toBe(2);
    expect(standing.memory.byWorkspace).toEqual([
      { workspaceId: release, name: 'Release', creditsEver: 1, credits30d: 0 },
      { workspaceId: research, name: 'Research', creditsEver: 2, credits30d: 2 },
    ]);

    expect(standing.earned).toEqual({
      address: MINE,
      // Summed as BigInt: as doubles these three lose their last digits, and
      // the loss is invisible by the time anybody reads it.
      cumulativeBaseUnits: '6000000000000000006',
      // And the same total split by what earned it. The two always add up.
      cumulativeSpendBaseUnits: '3000000000000000001',
      cumulativeMemoryBaseUnits: '3000000000000000005',
      periods: 3,
      recent: [
        {
          periodStart: '2026-09-20T12:20:00.000Z',
          periodEnd: '2026-09-20T12:30:00.000Z',
          amountBaseUnits: '3000000000000000003',
          // A period a subscriber earned: no confirmed spend at all.
          spendBaseUnits: '0',
          memoryBaseUnits: '3000000000000000003',
        },
        {
          periodStart: '2026-09-20T12:10:00.000Z',
          periodEnd: '2026-09-20T12:20:00.000Z',
          amountBaseUnits: '2000000000000000002',
          spendBaseUnits: '2000000000000000000',
          memoryBaseUnits: '2',
        },
        {
          periodStart: '2026-09-20T12:00:00.000Z',
          periodEnd: '2026-09-20T12:10:00.000Z',
          amountBaseUnits: '1000000000000000001',
          // Settled before the memory layer existed, so it carries a total and
          // no parts. Read as what it was - spend - rather than as a breakdown
          // that does not add up to the amount beside it.
          spendBaseUnits: '1000000000000000001',
          memoryBaseUnits: '0',
        },
      ],
    });

    // Millionths of a dollar, never dollars: a payable amount that arrives as
    // 2.042 has already lost money to a float.
    expect(Number.isInteger(standing.spend.confirmedMicros)).toBe(true);
    expect(JSON.stringify(standing)).not.toContain('$');

    expect(new Date(standing.generatedAt).getTime()).toBeGreaterThan(0);
  });

  it('never shows another account its agents, its spend or its earnings', async () => {
    const { research } = await seed();

    const { owner: other } = await signedInOwner();
    const theirs = await makeWorkspace(other, 'Theirs');
    await mintKey(other, theirs, 'Their Agent');
    await other.put('/auth/wallet', { address: STRANGER });

    const standing = (await other.get<Standing>('/rewards/standing')).body;

    expect(standing.agents.map((agent) => agent.name)).toEqual(['Their Agent']);
    expect(standing.agents.every((agent) => agent.workspaceId === theirs)).toBe(true);
    expect(standing.spend.byWorkspace.map((row) => row.workspaceId)).toEqual([theirs]);
    expect(standing.spend.byWorkspace.map((row) => row.workspaceId)).not.toContain(research);
    expect(standing.spend.confirmedMicros).toBe(0);
    // Their own address, their own row - and not a base unit of the other one.
    expect(standing.earned.address).toBe(STRANGER);
    expect(standing.earned.cumulativeBaseUnits).toBe('999000000000000000000');
    expect(standing.earned.periods).toBe(1);
  });

  it('says no wallet is linked instead of reporting an earning of nothing', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner, 'No Wallet');
    const agent = await mintKey(owner, workspaceId, 'Worker');
    await usage(workspaceId, agent.agent.id, 'verified', 5_000);
    // Rows exist for somebody - just not for this account, which has no address
    // to be found by.
    await accrue(STRANGER, 0, '123');

    const standing = (await owner.get<Standing>('/rewards/standing')).body;

    expect(standing.earned).toEqual({
      address: null,
      cumulativeBaseUnits: '0',
      cumulativeSpendBaseUnits: '0',
      cumulativeMemoryBaseUnits: '0',
      periods: 0,
      recent: [],
    });
    // The spend is still real and still reported: earning nothing yet is not
    // the same as having done nothing.
    expect(standing.spend.confirmedMicros).toBe(5_000);
  });

  it('answers an account with no workspaces without inventing anything', async () => {
    const { owner } = await signedInOwner();

    const standing = (await owner.get<Standing>('/rewards/standing')).body;

    expect(standing.agents).toEqual([]);
    expect(standing.spend).toEqual({
      confirmedMicros: 0,
      confirmedMicros30d: 0,
      unconfirmedReports: 0,
      byWorkspace: [],
    });
    expect(standing.earned.address).toBeNull();
  });

  it('is refused without a session, and to an agent key', async () => {
    const { research, planner } = await seed();
    expect(research).toBeTruthy();

    expect((await client().get('/rewards/standing')).status).toBe(401);
    // An agent has no wallet and no earnings of its own; it spends for the
    // person who owns the workspace.
    expect((await client({ apiKey: planner.apiKey }).get('/rewards/standing')).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('GET /rewards, the memory layer', () => {
  /**
   * The summary carries the same credits under the name that now pays them.
   *
   * `earned` is the older name for these rows and keeps its shape because the
   * console reads it; `memory` is the reward layer, and the two are one query
   * apart, so a test that lets them disagree is a test that lets the screen
   * disagree with the payout.
   */

  it('reports credits ever and credits lately, every workspace included', async () => {
    const { owner } = await signedInOwner();
    const research = await makeWorkspace(owner, 'Research');
    const quiet = await makeWorkspace(owner, 'Quiet');

    await credit(research);
    await credit(research, new Date(Date.now() - 45 * 24 * 60 * 60 * 1000));

    const summary = await owner.get<{
      earned: { points: number };
      memory: {
        creditsEver: number;
        credits30d: number;
        byWorkspace: { workspaceId: string; name: string; creditsEver: number; credits30d: number }[];
      };
    }>('/rewards');

    expect(summary.status).toBe(200);
    expect(summary.body.memory.creditsEver).toBe(2);
    expect(summary.body.memory.credits30d).toBe(1);

    // A workspace nobody has read from is listed at nought rather than dropped:
    // the nought is the answer to "why am I earning nothing from memory", and
    // leaving the row out deletes the answer.
    expect(summary.body.memory.byWorkspace).toEqual([
      { workspaceId: quiet, name: 'Quiet', creditsEver: 0, credits30d: 0 },
      { workspaceId: research, name: 'Research', creditsEver: 2, credits30d: 1 },
    ]);

    // The old field and the new one count the same rows. They are allowed to be
    // named differently; they are not allowed to disagree.
    expect(summary.body.earned.points).toBe(summary.body.memory.creditsEver);
  });

  it('never counts credits earned by another account', async () => {
    const mine = await signedInOwner();
    const workspaceId = await makeWorkspace(mine.owner, 'Mine');
    await credit(workspaceId);

    const stranger = await signedInOwner();
    const summary = await stranger.owner.get<{ memory: { creditsEver: number; byWorkspace: unknown[] } }>(
      '/rewards'
    );

    expect(summary.body.memory.creditsEver).toBe(0);
    expect(summary.body.memory.byWorkspace).toEqual([]);
  });
});
