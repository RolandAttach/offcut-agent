/**
 * HTTP-surface tests.
 *
 * The core and acceptance suites prove the memory rules. This one proves the
 * third surface does not weaken them: that the Nest layer authenticates the way
 * SS3.2 requires, refuses what the Access Layer refuses, and leaks nothing
 * across workspaces (SS7.1).
 *
 * A real server is started on an ephemeral port and driven over fetch. Mounting
 * controllers directly would skip guards, filters and cookie handling — exactly
 * the parts that only exist at this layer and therefore only fail here.
 */

import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory, getPrisma, resolveBackupDir } from '@offcut/core';
import { custom, numberToHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { AppModule } from '../app.module';
import { SIWE_STATEMENT, setSiweTransport } from '../auth/siwe';
import { activeChain } from '../common/chains';
import { config } from '../common/config';
import { resetRateLimits } from '../common/rate-limit.guard';
import { streamTiming } from '../memory/memory.controller';

let app: INestApplication;
let base: string;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  // Mirrors main.ts. Only one route writes its own response headers instead
  // of going through Nest's reply path, and it is the one route whose CORS
  // headers could therefore go missing - so the suite has to have them to lose.
  app.enableCors({ origin: [config.webOrigin], credentials: true });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

afterAll(async () => {
  await app?.close();
});

// ---------------------------------------------------------------------------
// A tiny client: keeps one cookie jar, or sends a Bearer key instead.
// ---------------------------------------------------------------------------

interface Response<T> {
  status: number;
  body: T;
}

function client(auth?: { apiKey?: string }) {
  let cookie = '';

  async function call<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response<T>> {
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
    patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
    put: <T>(path: string, body: unknown) => call<T>('PUT', path, body),
    del: <T>(path: string) => call<T>('DELETE', path),
    get cookie() {
      return cookie;
    },
  };
}

const uid = () => Math.random().toString(36).slice(2, 10);
const idem = (label: string) => `e2e-${label}-${uid()}`;

/** Signs a fresh owner in and hands back an authenticated client. */
async function signedInOwner() {
  const owner = client();
  const email = `e2e-${uid()}@offcut.test`;

  const registered = await owner.post<{ user: { id: string } }>('/auth/register', {
    email,
    password: 'correct-horse-battery',
    displayName: 'E2E Owner',
  });
  expect(registered.status).toBe(201);

  return { owner, email, userId: registered.body.user.id };
}

async function makeWorkspace(owner: ReturnType<typeof client>, name = 'E2E Workspace') {
  const created = await owner.post<{ workspace: { id: string } }>('/workspaces', { name });
  expect(created.status).toBe(201);
  return created.body.workspace.id;
}

async function mintKey(
  owner: ReturnType<typeof client>,
  workspaceId: string,
  name: string,
  permissions?: Record<string, boolean>
) {
  const created = await owner.post<{ apiKey: string; agent: { id: string } }>(
    `/workspaces/${workspaceId}/agents`,
    { name, kind: 'subagent', ...(permissions ? { permissions } : {}) }
  );
  expect(created.status).toBe(201);
  return created.body;
}

// ---------------------------------------------------------------------------
describe('Health', () => {
  it('is public and reports that the core needs no token or model', async () => {
    const anonymous = client();
    const response = await anonymous.get<{
      database: string;
      tokenRequired: boolean;
      externalModel: string;
    }>('/health');

    expect(response.status).toBe(200);
    expect(response.body.database).toBe('ok');
    // Invariant 10, observable from outside the process.
    expect(response.body.tokenRequired).toBe(false);
    expect(response.body.externalModel).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
describe('Authentication', () => {
  it('refuses every protected route without a credential', async () => {
    const anonymous = client();

    for (const path of ['/workspaces', '/auth/me']) {
      const response = await anonymous.get(path);
      expect(response.status).toBe(401);
    }
  });

  it('registers, signs in and returns the session as an httpOnly cookie', async () => {
    const { owner, email } = await signedInOwner();

    const me = await owner.get<{ user: { email: string } }>('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);

    // The cookie must not be readable by scripts.
    const fresh = client();
    const login = await fresh.post('/auth/login', { email, password: 'correct-horse-battery' });
    expect(login.status).toBe(201);
    expect(fresh.cookie).toContain('offcut_session=');
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const { email } = await signedInOwner();

    const wrongPassword = await client().post<{ error: { message: string } }>('/auth/login', {
      email,
      password: 'not-the-password',
    });
    const unknownAccount = await client().post<{ error: { message: string } }>('/auth/login', {
      email: `nobody-${uid()}@offcut.test`,
      password: 'not-the-password',
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    // Whether an email is registered is not public information.
    expect(wrongPassword.body.error.message).toBe(unknownAccount.body.error.message);
  });

  it('rate limits sign-in attempts', async () => {
    resetRateLimits();
    const { email } = await signedInOwner();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await client().post('/auth/login', { email, password: 'wrong' });
      statuses.push(response.status);
    }

    // Ten are allowed per window; the rest are refused before touching scrypt.
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    resetRateLimits();
  });
});

// ---------------------------------------------------------------------------
describe('Agent keys are the identity', () => {
  it('authenticates an agent by Bearer key and attributes its writes', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const { apiKey } = await mintKey(owner, workspaceId, 'Researcher');

    const agent = client({ apiKey });
    const added = await agent.post<{ recordId: string; version: number }>(
      `/workspaces/${workspaceId}/memory/add`,
      {
        type: 'fact',
        text: 'Written over HTTP by an agent key.',
        topic: 'e2e',
        source: 'test',
        idempotencyKey: idem('add'),
      }
    );

    expect(added.status).toBe(201);
    expect(added.body.version).toBe(1);

    const records = await agent.get<{ records: { agentName: string }[] }>(
      `/workspaces/${workspaceId}/memory/records`
    );
    expect(records.body.records[0]!.agentName).toBe('Researcher');
  });

  it('ignores an agentId supplied in the request body', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const { apiKey } = await mintKey(owner, workspaceId, 'Honest');
    const impostor = await mintKey(owner, workspaceId, 'Victim');

    const agent = client({ apiKey });
    await agent.post(`/workspaces/${workspaceId}/memory/add`, {
      type: 'fact',
      text: 'Trying to write as someone else.',
      topic: 'e2e',
      source: 'test',
      // A model-supplied author. It must change nothing (SS3.2, SS7).
      agentId: impostor.agent.id,
      idempotencyKey: idem('spoof'),
    });

    const records = await agent.get<{ records: { agentName: string }[] }>(
      `/workspaces/${workspaceId}/memory/records`
    );
    expect(records.body.records[0]!.agentName).toBe('Honest');
  });

  it('blocks a revoked key on the very next request', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const { apiKey, agent: created } = await mintKey(owner, workspaceId, 'Contractor');

    const agent = client({ apiKey });
    expect((await agent.post(`/workspaces/${workspaceId}/memory/recall`, { query: 'x' })).status).toBe(
      201
    );

    await owner.post(`/workspaces/${workspaceId}/agents/${created.id}/revoke`);

    const after = await agent.post<{ error: { code: string } }>(
      `/workspaces/${workspaceId}/memory/recall`,
      { query: 'x' }
    );
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('REVOKED');
  });
});

// ---------------------------------------------------------------------------
describe('Permissions are enforced at this layer too', () => {
  it('refuses operations the agent was not granted', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const { apiKey } = await mintKey(owner, workspaceId, 'Limited', {
      canRead: true,
      canWrite: true,
      canExport: false,
      canForget: false,
      canResolve: false,
      canImport: false,
    });

    const agent = client({ apiKey });

    // Each body must be VALID, otherwise schema validation rejects it before the
    // permission check and the test would pass for the wrong reason.
    const attempts: { path: string; body: unknown }[] = [
      { path: 'export', body: {} },
      { path: 'forget', body: { recordId: 'rec_whatever', idempotencyKey: idem('f') } },
      {
        path: 'import',
        body: {
          records: [{ type: 'fact', text: 'Should never land.', topic: 'e2e' }],
          idempotencyKey: idem('i'),
        },
      },
    ];

    for (const attempt of attempts) {
      const response = await agent.post<{ error: { code: string } }>(
        `/workspaces/${workspaceId}/memory/${attempt.path}`,
        attempt.body
      );
      expect(response.status, `${attempt.path} should be refused`).toBe(403);
      expect(response.body.error.code).toBe('ACCESS_DENIED');
    }

    // And the refused import wrote nothing.
    const records = await agent.get<{ total: number }>(`/workspaces/${workspaceId}/memory/records`);
    expect(records.body.total).toBe(0);
  });

  it('stops an agent creating another agent', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const { apiKey } = await mintKey(owner, workspaceId, 'Ambitious');

    const agent = client({ apiKey });
    const attempt = await agent.post<{ error: { code: string } }>(
      `/workspaces/${workspaceId}/agents`,
      { name: 'Self-granted', kind: 'lead' }
    );

    expect(attempt.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('Cross-workspace isolation', () => {
  it('returns no content, summary or metadata from a workspace you cannot see', async () => {
    const insider = await signedInOwner();
    const insiderWorkspace = await makeWorkspace(insider.owner, 'Insider');
    const { apiKey: insiderKey } = await mintKey(insider.owner, insiderWorkspace, 'Insider Agent');

    await client({ apiKey: insiderKey }).post(`/workspaces/${insiderWorkspace}/memory/add`, {
      type: 'fact',
      text: 'CONFIDENTIAL launch date is March.',
      topic: 'launch',
      source: 'board deck',
      idempotencyKey: idem('secret'),
    });

    const outsider = await signedInOwner();
    const outsiderWorkspace = await makeWorkspace(outsider.owner, 'Outsider');
    const { apiKey: outsiderKey } = await mintKey(
      outsider.owner,
      outsiderWorkspace,
      'Outsider Agent'
    );

    // Neither a foreign owner session nor a foreign agent key gets anything.
    for (const probe of [outsider.owner, client({ apiKey: outsiderKey })]) {
      for (const path of ['memory/recall', 'memory/inspect', 'memory/export']) {
        const response = await probe.post<{ error: { code: string } }>(
          `/workspaces/${insiderWorkspace}/${path}`,
          { query: 'launch' }
        );
        expect(response.status).toBe(403);
        expect(JSON.stringify(response.body)).not.toContain('CONFIDENTIAL');
        expect(JSON.stringify(response.body)).not.toContain('March');
      }

      const stats = await probe.get<{ error: { code: string } }>(
        `/workspaces/${insiderWorkspace}/stats`
      );
      expect(stats.status).toBe(403);
      // Not even a count escapes.
      expect(JSON.stringify(stats.body)).not.toMatch(/"records":\s*\d/);
    }
  });

  it('answers identically for a foreign workspace and one that does not exist', async () => {
    const { owner } = await signedInOwner();
    const other = await signedInOwner();
    const foreign = await makeWorkspace(other.owner);

    const real = await owner.post<{ error: { message: string } }>(
      `/workspaces/${foreign}/memory/recall`,
      { query: 'x' }
    );
    const imaginary = await owner.post<{ error: { message: string } }>(
      '/workspaces/ws_does_not_exist/memory/recall',
      { query: 'x' }
    );

    expect(real.status).toBe(imaginary.status);
    expect(real.body.error.message).toBe(imaginary.body.error.message);
  });
});

// ---------------------------------------------------------------------------
describe('Installation-wide snapshots are not on the HTTP surface', () => {
  /**
   * A snapshot is every row of every account: the users table, agent key
   * hashes, the text of records their owners wrote. SS3.1 knows one role, the
   * owner of a workspace, and names reaching another owner's workspace by
   * holding a credential as the thing that role exists to prevent. Nothing a
   * session cookie proves makes its holder the operator of the machine, so the
   * operator's controls are not on this surface at all.
   *
   * Probed here from a second account that owns nothing on the installation.
   */
  it('gives a signed-in account no route to the installation snapshot at all', async () => {
    // A backup directory of this test's own, so that a run which fails - one
    // where the route still answers - dumps the other account's rows somewhere
    // disposable rather than into the operator's real snapshot folder.
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'offcut-backup-probe-'));
    const previous = process.env.OFFCUT_DATA_DIR;
    process.env.OFFCUT_DATA_DIR = sandbox;
    const backupDir = resolveBackupDir();

    try {
      const insider = await signedInOwner();
      const insiderWorkspace = await makeWorkspace(insider.owner, 'Insider');
      const { apiKey } = await mintKey(insider.owner, insiderWorkspace, 'Insider Agent');

      await client({ apiKey }).post(`/workspaces/${insiderWorkspace}/memory/add`, {
        type: 'fact',
        text: 'CONFIDENTIAL the vendor contract renews in March.',
        topic: 'vendor',
        source: 'board deck',
        idempotencyKey: idem('snapshot-secret'),
      });

      const { owner: outsider } = await signedInOwner();

      for (const probe of [
        () => outsider.get<unknown>('/backups'),
        () => outsider.post<unknown>('/backups'),
        () => outsider.post<unknown>('/backups/prune'),
      ]) {
        const response = await probe();
        expect(response.status).toBe(404);

        const body = JSON.stringify(response.body);
        // Not the server's filesystem layout, not the installation's row
        // counts, not the size of what the operator has ever deleted.
        expect(body).not.toContain(backupDir);
        expect(body).not.toMatch(/"memoryRecord":s*d/);
        expect(body).not.toMatch(/"entries":s*d/);
        expect(body).not.toContain('CONFIDENTIAL');
      }

      // The half that matters most: no probe caused a file holding the other
      // account's memory to exist anywhere.
      expect(fs.readdirSync(backupDir)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.OFFCUT_DATA_DIR;
      else process.env.OFFCUT_DATA_DIR = previous;
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
describe('All eight operations over HTTP', () => {
  it('runs the full cycle and keeps the merge rules intact', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);

    const a = client({ apiKey: (await mintKey(owner, workspaceId, 'Alpha')).apiKey });
    const b = client({ apiKey: (await mintKey(owner, workspaceId, 'Beta')).apiKey });

    // add
    const first = await a.post<{ recordId: string }>(`/workspaces/${workspaceId}/memory/add`, {
      type: 'decision',
      text: 'Project data is stored locally.',
      topic: 'release-1',
      source: 'call',
      factKey: 'storage.location',
      factValue: 'local',
      factContext: 'release-1',
      idempotencyKey: idem('a1'),
    });
    expect(first.status).toBe(201);

    // The same finding from another agent: one retrieval item, two authors.
    await b.post(`/workspaces/${workspaceId}/memory/add`, {
      type: 'decision',
      text: 'Project data is stored locally.',
      topic: 'release-1',
      source: 'independent check',
      idempotencyKey: idem('b1'),
    });

    // A disagreement on the same named fact.
    await b.post(`/workspaces/${workspaceId}/memory/add`, {
      type: 'decision',
      text: 'Project data is stored in the cloud.',
      topic: 'release-1',
      source: 'review',
      factKey: 'storage.location',
      factValue: 'cloud',
      factContext: 'release-1',
      idempotencyKey: idem('b2'),
    });

    // import (owner has every permission)
    const imported = await owner.post<{ imported: number }>(
      `/workspaces/${workspaceId}/memory/import`,
      {
        records: [
          { type: 'result', text: 'Imported over HTTP.', topic: 'release-1', source: 'file' },
        ],
        idempotencyKey: idem('imp'),
      }
    );
    expect(imported.body.imported).toBe(1);

    // merge
    const merged = await owner.post<{ blocks: unknown[]; duplicatesCollapsed: number }>(
      `/workspaces/${workspaceId}/memory/merge`,
      { idempotencyKey: idem('m') }
    );
    expect(merged.body.blocks.length).toBeGreaterThan(0);
    expect(merged.body.duplicatesCollapsed).toBeGreaterThan(0);

    // recall
    const recalled = await a.post<{
      items: { text: string; merged: boolean; refs: { agentName: string }[] }[];
      conflicts: { id: string; sides: { recordId: string; value: string }[] }[];
    }>(`/workspaces/${workspaceId}/memory/recall`, { query: 'where is data stored' });

    const duplicate = recalled.body.items.find((item) => item.text.includes('stored locally'))!;
    expect(duplicate.merged).toBe(true);
    expect(duplicate.refs.map((ref) => ref.agentName).sort()).toEqual(['Alpha', 'Beta']);
    expect(recalled.body.conflicts).toHaveLength(1);

    // inspect
    const inspected = await a.post<{ total: number }>(
      `/workspaces/${workspaceId}/memory/inspect`,
      {}
    );
    expect(inspected.body.total).toBeGreaterThan(0);

    // resolve — owner only; an agent without canResolve is refused
    const conflictId = recalled.body.conflicts[0]!.id;
    const refused = await a.post<{ error: { code: string } }>(
      `/workspaces/${workspaceId}/memory/resolve`,
      {
        conflictId,
        chosenRecordId: recalled.body.conflicts[0]!.sides[0]!.recordId,
        rationale: 'I say so.',
      }
    );
    expect(refused.status).toBe(403);

    const resolved = await owner.post<{ conflict: { status: string } }>(
      `/workspaces/${workspaceId}/memory/resolve`,
      {
        conflictId,
        chosenRecordId: recalled.body.conflicts[0]!.sides[0]!.recordId,
        rationale: 'Offline requirement rules out cloud storage.',
        idempotencyKey: idem('r'),
      }
    );
    expect(resolved.body.conflict.status).toBe('resolved');

    // export
    const exported = await owner.post<{ counts: { records: number } }>(
      `/workspaces/${workspaceId}/memory/export`,
      {}
    );
    expect(exported.body.counts.records).toBeGreaterThan(0);

    // forget — the deleted text must not survive anywhere.
    //
    // A uniquely marked record is used rather than one of the duplicates above:
    // Alpha and Beta both wrote "stored locally", and deleting Alpha's must NOT
    // remove Beta's (invariant 3 — identical text from another author is its own
    // record). Asserting on the shared sentence would demand the opposite.
    const doomed = await a.post<{ recordId: string }>(`/workspaces/${workspaceId}/memory/add`, {
      type: 'result',
      text: 'ERASE-MARKER this line must disappear completely.',
      topic: 'release-1',
      source: 'test',
      idempotencyKey: idem('doomed'),
    });

    await owner.post(`/workspaces/${workspaceId}/memory/merge`, { idempotencyKey: idem('m2') });
    const beforeBlocks = await owner.get(`/workspaces/${workspaceId}/memory/blocks`);
    expect(JSON.stringify(beforeBlocks.body)).toContain('ERASE-MARKER');

    await owner.post(`/workspaces/${workspaceId}/memory/forget`, {
      recordId: doomed.body.recordId,
      purge: true,
      idempotencyKey: idem('f'),
    });

    const afterExport = await owner.post(`/workspaces/${workspaceId}/memory/export`, {});
    const afterBlocks = await owner.get(`/workspaces/${workspaceId}/memory/blocks`);
    const afterRecall = await owner.post(`/workspaces/${workspaceId}/memory/recall`, {
      query: 'erase marker',
    });

    expect(JSON.stringify(afterExport.body)).not.toContain('ERASE-MARKER');
    expect(JSON.stringify(afterBlocks.body)).not.toContain('ERASE-MARKER');
    expect(JSON.stringify(afterRecall.body)).not.toContain('ERASE-MARKER');

    // Beta's independent copy of the shared sentence is untouched.
    expect(JSON.stringify(afterExport.body)).toContain('stored locally.');
  });

  it('replays an idempotent write instead of duplicating it', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = client({ apiKey: (await mintKey(owner, workspaceId, 'Repeater')).apiKey });

    const payload = {
      type: 'fact',
      text: 'Sent twice.',
      topic: 'e2e',
      source: 'test',
      idempotencyKey: idem('same'),
    };

    const first = await agent.post<{ recordId: string; replayed: boolean }>(
      `/workspaces/${workspaceId}/memory/add`,
      payload
    );
    const second = await agent.post<{ recordId: string; replayed: boolean }>(
      `/workspaces/${workspaceId}/memory/add`,
      payload
    );

    expect(second.body.replayed).toBe(true);
    expect(second.body.recordId).toBe(first.body.recordId);

    const records = await agent.get<{ total: number }>(`/workspaces/${workspaceId}/memory/records`);
    expect(records.body.total).toBe(1);

    // The same key with different content is rejected outright.
    const mismatch = await agent.post<{ error: { code: string } }>(
      `/workspaces/${workspaceId}/memory/add`,
      { ...payload, text: 'Different content, same key.' }
    );
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('refuses a correction built on a stale version', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = client({ apiKey: (await mintKey(owner, workspaceId, 'Editor')).apiKey });

    const base = await agent.post<{ recordId: string }>(`/workspaces/${workspaceId}/memory/add`, {
      type: 'decision',
      text: 'Version one.',
      topic: 'e2e',
      source: 'test',
      idempotencyKey: idem('v1'),
    });

    await agent.post(`/workspaces/${workspaceId}/memory/add`, {
      type: 'decision',
      text: 'Version two.',
      topic: 'e2e',
      source: 'test',
      correctsRecordId: base.body.recordId,
      expectedVersion: 1,
      idempotencyKey: idem('v2'),
    });

    const stale = await agent.post<{ error: { code: string } }>(
      `/workspaces/${workspaceId}/memory/add`,
      {
        type: 'decision',
        text: 'Written from a stale read.',
        topic: 'e2e',
        source: 'test',
        correctsRecordId: base.body.recordId,
        expectedVersion: 1,
        idempotencyKey: idem('v2b'),
      }
    );

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
  });
});

// ---------------------------------------------------------------------------
describe('Pagination', () => {
  it('pages without ever reporting more than the caller may see', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = client({ apiKey: (await mintKey(owner, workspaceId, 'Bulk')).apiKey });

    for (let index = 0; index < 12; index += 1) {
      await agent.post(`/workspaces/${workspaceId}/memory/add`, {
        type: 'fact',
        text: `Record number ${index}.`,
        topic: 'bulk',
        source: 'loop',
        idempotencyKey: idem(`bulk-${index}`),
      });
    }

    const first = await agent.get<{
      records: { recordId: string }[];
      total: number;
      hasMore: boolean;
    }>(`/workspaces/${workspaceId}/memory/records?limit=5&offset=0`);

    expect(first.body.total).toBe(12);
    expect(first.body.records).toHaveLength(5);
    expect(first.body.hasMore).toBe(true);

    const last = await agent.get<{ records: unknown[]; hasMore: boolean }>(
      `/workspaces/${workspaceId}/memory/records?limit=5&offset=10`
    );
    expect(last.body.records).toHaveLength(2);
    expect(last.body.hasMore).toBe(false);

    // Pages must not overlap.
    const second = await agent.get<{ records: { recordId: string }[] }>(
      `/workspaces/${workspaceId}/memory/records?limit=5&offset=5`
    );
    const firstIds = new Set(first.body.records.map((record) => record.recordId));
    expect(second.body.records.every((record) => !firstIds.has(record.recordId))).toBe(true);
  });

  it('filters by search text', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = client({ apiKey: (await mintKey(owner, workspaceId, 'Searcher')).apiKey });

    for (const text of ['The cache is cold', 'The queue is full', 'Cache eviction is wrong']) {
      await agent.post(`/workspaces/${workspaceId}/memory/add`, {
        type: 'result',
        text,
        topic: 'search',
        source: 'test',
        idempotencyKey: idem('s'),
      });
    }

    const filtered = await agent.get<{ total: number }>(
      `/workspaces/${workspaceId}/memory/records?search=cache`
    );
    expect(filtered.body.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('Workspace administration', () => {
  it('updates settings and deletes only for the owner', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = client({ apiKey: (await mintKey(owner, workspaceId, 'Nosy')).apiKey });

    const agentAttempt = await agent.patch(`/workspaces/${workspaceId}`, { name: 'Hijacked' });
    expect(agentAttempt.status).toBe(403);

    const updated = await owner.patch<{ workspace: { name: string; contextLimit: number } }>(
      `/workspaces/${workspaceId}`,
      { name: 'Renamed', contextLimit: 9000 }
    );
    expect(updated.body.workspace.name).toBe('Renamed');
    expect(updated.body.workspace.contextLimit).toBe(9000);

    const deleted = await owner.del(`/workspaces/${workspaceId}`);
    expect(deleted.status).toBe(200);

    const gone = await owner.get<{ workspaces: unknown[] }>('/workspaces');
    expect(gone.body.workspaces).toHaveLength(0);
  });

  it('shows an agent key exactly once', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const created = await mintKey(owner, workspaceId, 'Once');

    expect(created.apiKey).toMatch(/^offcut_sk_/);

    const listed = await owner.get<{ agents: { keyPrefix: string }[] }>(
      `/workspaces/${workspaceId}/agents`
    );
    // The list carries a prefix for recognition and nothing usable.
    const entry = listed.body.agents.find((candidate) => candidate.keyPrefix.startsWith('offcut_sk_'))!;
    expect(entry.keyPrefix.length).toBeLessThan(created.apiKey.length);
    expect(JSON.stringify(listed.body)).not.toContain(created.apiKey);
  });
});

// ---------------------------------------------------------------------------
describe('The payout address', () => {
  // Deliberately mixed case: EIP-55 checksums are how addresses are copied out
  // of wallets and explorers, so this is the form that actually arrives.
  const CHECKSUMMED = '0xAbC0000000000000000000000000000000000001';

  it('is stored in the single form it will be paid in', async () => {
    // One wallet written two ways must not become two accounts: the publisher
    // matches the stored string against a Merkle leaf, and a leaf is built from
    // one spelling only.
    const { owner } = await signedInOwner();

    const linked = await owner.put<{ wallet: { address: string; linkedAt: string } }>(
      '/auth/wallet',
      { address: CHECKSUMMED }
    );

    expect(linked.status).toBe(200);
    expect(linked.body.wallet.address).toBe(CHECKSUMMED.toLowerCase());
    expect(linked.body.wallet.linkedAt).not.toBeNull();

    const summary = await owner.get<{ wallet: { address: string } }>('/rewards');
    expect(summary.body.wallet.address).toBe(CHECKSUMMED.toLowerCase());
  });

  it('refuses anything that is not an address instead of storing it', async () => {
    const { owner } = await signedInOwner();

    const rejected = [
      'not-an-address',
      '0x123',
      CHECKSUMMED.slice(2),
      `${CHECKSUMMED}00`,
      '0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      '',
    ];

    for (const address of rejected) {
      const attempt = await owner.put('/auth/wallet', { address });
      expect(attempt.status).toBe(400);
    }

    // Nothing was half-stored along the way.
    const summary = await owner.get<{ wallet: { address: string | null } }>('/rewards');
    expect(summary.body.wallet.address).toBeNull();
  });

  it('refuses the zero address, which is well formed and unrecoverable', async () => {
    const { owner } = await signedInOwner();

    const attempt = await owner.put('/auth/wallet', {
      address: '0x0000000000000000000000000000000000000000',
    });

    expect(attempt.status).toBe(400);
  });

  it('can be replaced, and clearing it loses nothing that was earned', async () => {
    const { owner } = await signedInOwner();
    const second = '0x00000000000000000000000000000000000000ff';

    await owner.put('/auth/wallet', { address: CHECKSUMMED });
    const replaced = await owner.put<{ wallet: { address: string } }>('/auth/wallet', {
      address: second,
    });
    expect(replaced.body.wallet.address).toBe(second);

    const cleared = await owner.del<{ wallet: { address: string | null; linkedAt: string | null } }>(
      '/auth/wallet'
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.wallet.address).toBeNull();
    expect(cleared.body.wallet.linkedAt).toBeNull();
  });

  it('belongs to a person, so an agent key cannot set one', async () => {
    // Agents hold keys, not wallets. A stolen agent key must not be able to
    // redirect its owner's rewards.
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = client({ apiKey: (await mintKey(owner, workspaceId, 'Greedy')).apiKey });

    const attempt = await agent.put('/auth/wallet', { address: CHECKSUMMED });
    expect(attempt.status).toBe(403);

    const summary = await agent.get('/rewards');
    expect(summary.status).toBe(403);
  });

  it('is invisible to another account', async () => {
    const first = await signedInOwner();
    await first.owner.put('/auth/wallet', { address: CHECKSUMMED });

    const other = await signedInOwner();
    const summary = await other.owner.get<{ wallet: { address: string | null } }>('/rewards');

    expect(summary.body.wallet.address).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('Retrievals credited: the product statistic, which is not the payout', () => {
  it('counts a record when another agent retrieves it, and counts it once', async () => {
    // The whole economics in one pass: writing earns nothing, another agent's
    // retrieval earns one point, and retrieving the same record again earns
    // nothing further. Farming by re-reading is what the unique constraint on
    // recordId exists to stop, and this is the HTTP-level proof of it.
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);

    const writer = client({ apiKey: (await mintKey(owner, workspaceId, 'Writer')).apiKey });
    const reader = client({ apiKey: (await mintKey(owner, workspaceId, 'Reader')).apiKey });

    await writer.post(`/workspaces/${workspaceId}/memory/add`, {
      type: 'decision',
      text: 'Deploys are frozen until the migration lands.',
      topic: 'release-1',
      idempotencyKey: idem('earn-write'),
    });

    const beforeRead = await owner.get<{ earned: { points: number } }>('/rewards');
    expect(beforeRead.body.earned.points).toBe(0);

    const recalled = await reader.post<{ items: unknown[] }>(
      `/workspaces/${workspaceId}/memory/recall`,
      { query: 'deploys frozen migration' }
    );
    expect(recalled.body.items.length).toBeGreaterThan(0);

    const afterRead = await owner.get<{
      earned: { points: number; byWorkspace: { workspaceId: string; points: number }[] };
    }>('/rewards');
    expect(afterRead.body.earned.points).toBe(1);
    expect(afterRead.body.earned.byWorkspace).toEqual([
      expect.objectContaining({ workspaceId, points: 1 }),
    ]);

    await reader.post(`/workspaces/${workspaceId}/memory/recall`, {
      query: 'deploys frozen migration',
    });
    const afterSecondRead = await owner.get<{ earned: { points: number } }>('/rewards');
    expect(afterSecondRead.body.earned.points).toBe(1);
  });

  it('does not credit an owner for reading their own workspace', async () => {
    // The console is the product being used, not a contribution to it.
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const writer = client({ apiKey: (await mintKey(owner, workspaceId, 'Writer')).apiKey });

    await writer.post(`/workspaces/${workspaceId}/memory/add`, {
      type: 'fact',
      text: 'The staging database is rebuilt nightly.',
      topic: 'infra',
      idempotencyKey: idem('self-read'),
    });

    await owner.post(`/workspaces/${workspaceId}/memory/recall`, { query: 'staging database' });

    const summary = await owner.get<{ earned: { points: number } }>('/rewards');
    expect(summary.body.earned.points).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('The rewards summary answers with the figure that actually pays', () => {
  /**
   * The shape the console reads. `confirmedSpend` is money, in integer
   * millionths of a dollar; `earned` is a count of retrievals and is not.
   */
  interface Summary {
    confirmedSpend: {
      micros: number;
      byWorkspace: {
        workspaceId: string;
        name: string;
        micros: number;
        credential: { provider: string; linked: boolean; hint: string; linkedAt: string | null };
      }[];
    };
    unconfirmed: {
      pending: { requests: number; reportedMicros: number };
      rejected: { requests: number; reasons: { reason: string; requests: number }[] };
    };
    earned: { points: number; byWorkspace: { workspaceId: string }[] };
  }

  /**
   * Written straight to the store: nothing reports usage over HTTP, and the
   * verifying path is a live call to OpenRouter. What is tested here is what
   * the summary does with settled rows, not how they settle.
   */
  async function usage(
    workspaceId: string,
    agentId: string,
    status: 'pending' | 'verified' | 'rejected',
    micros: number,
    rejectedReason = ''
  ): Promise<void> {
    await getPrisma().modelUsage.create({
      data: {
        workspaceId,
        provider: 'openrouter',
        generationId: `gen-${uid()}${uid()}`,
        reportedByAgentId: agentId,
        reportedCostMicros: micros,
        status,
        rejectedReason,
        verifiedCostMicros: status === 'verified' ? micros : 0,
        verifiedAt: status === 'pending' ? null : new Date(),
      },
    });
  }

  /**
   * Links a credential by writing the column. setUsageCredential needs a server
   * encryption key and a live probe at OpenRouter, and neither belongs in this
   * suite - but `linked` is read off the ciphertext being present, so a stand-in
   * string exercises exactly the branch the console depends on.
   */
  const CIPHER = 'SENTINEL-CIPHERTEXT-NEVER-LEAVES-THE-SERVER';

  async function linkKey(workspaceId: string, hint: string): Promise<void> {
    await getPrisma().workspace.update({
      where: { id: workspaceId },
      data: { usageKeyCipher: CIPHER, usageKeyHint: hint, usageLinkedAt: new Date() },
    });
  }

  it('reports confirmed AI spend, not the records another agent retrieved', async () => {
    // The bug this endpoint had: it answered with retrievals while the
    // publisher accrues on confirmed spend, so the console showed one number
    // and the payout used another. Both are present here and they are
    // deliberately different, because a test where they agree proves nothing.
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);

    const writer = await mintKey(owner, workspaceId, 'Writer');
    const reader = await mintKey(owner, workspaceId, 'Reader');

    await client({ apiKey: writer.apiKey }).post(`/workspaces/${workspaceId}/memory/add`, {
      type: 'decision',
      text: 'The migration runs before the deploy, not after it.',
      topic: 'release-2',
      idempotencyKey: idem('spend-write'),
    });
    await client({ apiKey: reader.apiKey }).post(`/workspaces/${workspaceId}/memory/recall`, {
      query: 'migration before deploy',
    });

    await usage(workspaceId, reader.agent.id, 'verified', 4_231_000);

    const summary = await owner.get<Summary>('/rewards');

    expect(summary.body.confirmedSpend.micros).toBe(4_231_000);
    expect(summary.body.earned.points).toBe(1);
  });

  it('reports spend as whole millionths of a dollar and never as dollars', async () => {
    // A payable amount that arrives as 0.421 has already lost money to a float,
    // and the loss is invisible by the time anybody reads it. Dollars are for
    // the edge to derive from this integer, not for this endpoint to send.
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = await mintKey(owner, workspaceId, 'Spender');

    await usage(workspaceId, agent.agent.id, 'verified', 421_237);

    const summary = await owner.get<Summary>('/rewards');

    expect(summary.body.confirmedSpend.micros).toBe(421_237);
    expect(Number.isInteger(summary.body.confirmedSpend.micros)).toBe(true);
    expect(JSON.stringify(summary.body)).not.toContain('$');
  });

  it('pays on nothing the provider has not answered for', async () => {
    // Reported is not confirmed, and refused is never confirmed. If either were
    // summed into the figure, an agent could earn by reporting large numbers,
    // which is the whole reason confirmation exists.
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = await mintKey(owner, workspaceId, 'Spender');

    await usage(workspaceId, agent.agent.id, 'verified', 1_000_000);
    await usage(workspaceId, agent.agent.id, 'pending', 5_000_000);
    await usage(workspaceId, agent.agent.id, 'rejected', 9_000_000);

    const summary = await owner.get<Summary>('/rewards');

    expect(summary.body.confirmedSpend.micros).toBe(1_000_000);
  });

  it('names the reports that earn nothing, and the reason each was refused', async () => {
    // The promise the landing page makes about this endpoint: a report nobody
    // can confirm earns nothing, and the console names which ones those are and
    // why. Without these counts the console has a figure and no way to explain
    // it, and somebody whose reports were all refused reads $0.00 as "this does
    // not work" - the one conclusion that is both wrong and unrecoverable.
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = await mintKey(owner, workspaceId, 'Spender');

    await usage(workspaceId, agent.agent.id, 'verified', 1_000_000);
    await usage(workspaceId, agent.agent.id, 'pending', 400_000);
    await usage(workspaceId, agent.agent.id, 'pending', 600_000);
    await usage(workspaceId, agent.agent.id, 'rejected', 9_000_000, 'the provider does not recognise this request');
    await usage(workspaceId, agent.agent.id, 'rejected', 2_000_000, 'the provider does not recognise this request');
    await usage(workspaceId, agent.agent.id, 'rejected', 3_000_000, 'reported by an agent of another workspace');

    const summary = await owner.get<Summary>('/rewards');

    // Neither figure is folded into the one that pays.
    expect(summary.body.confirmedSpend.micros).toBe(1_000_000);

    expect(summary.body.unconfirmed.pending).toEqual({ requests: 2, reportedMicros: 1_000_000 });
    expect(summary.body.unconfirmed.rejected.requests).toBe(3);
    expect(summary.body.unconfirmed.rejected.reasons).toEqual([
      { reason: 'the provider does not recognise this request', requests: 2 },
      { reason: 'reported by an agent of another workspace', requests: 1 },
    ]);
  });

  it('answers with nothing outstanding rather than omitting the question', async () => {
    // An absent field and "nothing is waiting" are different answers, and a
    // console that cannot tell them apart has to guess which one it received.
    const { owner } = await signedInOwner();
    await makeWorkspace(owner);

    const summary = await owner.get<Summary>('/rewards');

    expect(summary.body.unconfirmed).toEqual({
      pending: { requests: 0, reportedMicros: 0 },
      rejected: { requests: 0, reasons: [] },
    });
  });

  it('counts only the reports of workspaces this person owns', async () => {
    // Pending and rejected counts are usage data like any other: a stranger's
    // reports must not appear in this account's explanation of its own zero.
    const { owner } = await signedInOwner();
    const mine = await makeWorkspace(owner, 'Mine');
    const agent = await mintKey(owner, mine, 'Mine');

    const stranger = await signedInOwner();
    const theirs = await makeWorkspace(stranger.owner, 'Theirs');
    const theirAgent = await mintKey(stranger.owner, theirs, 'Theirs');

    await usage(mine, agent.agent.id, 'pending', 100_000);
    await usage(theirs, theirAgent.agent.id, 'pending', 900_000);
    await usage(theirs, theirAgent.agent.id, 'rejected', 500_000, 'the provider does not recognise this request');

    const summary = await owner.get<Summary>('/rewards');

    expect(summary.body.unconfirmed.pending).toEqual({ requests: 1, reportedMicros: 100_000 });
    expect(summary.body.unconfirmed.rejected.requests).toBe(0);
  });

  it('totals every workspace the person owns, in one answer', async () => {
    // The reason this endpoint is not under /workspaces: a console that had to
    // add up N calls would get the total wrong the first time somebody made a
    // second workspace.
    const { owner } = await signedInOwner();
    const first = await makeWorkspace(owner, 'First');
    const second = await makeWorkspace(owner, 'Second');

    const one = await mintKey(owner, first, 'One');
    const two = await mintKey(owner, second, 'Two');

    await usage(first, one.agent.id, 'verified', 300_000);
    await usage(second, two.agent.id, 'verified', 700_000);

    const summary = await owner.get<Summary>('/rewards');

    expect(summary.body.confirmedSpend.micros).toBe(1_000_000);

    const byWorkspace = new Map(
      summary.body.confirmedSpend.byWorkspace.map((row) => [row.workspaceId, row.micros])
    );
    expect(byWorkspace.get(first)).toBe(300_000);
    expect(byWorkspace.get(second)).toBe(700_000);
  });

  it('shows a workspace with no key linked instead of hiding its zero', async () => {
    // The failure worth preventing: somebody links a key in one workspace,
    // spends in another, and reads a zero they have no way to explain. A row
    // that is absent from the list cannot say "nobody can be asked about this",
    // so unlike the retrieval statistic, nothing here is filtered out.
    const { owner } = await signedInOwner();
    const linked = await makeWorkspace(owner, 'Has a key');
    const bare = await makeWorkspace(owner, 'No key');

    await linkKey(linked, '9f3a');

    const summary = await owner.get<Summary>('/rewards');

    const rows = new Map(
      summary.body.confirmedSpend.byWorkspace.map((row) => [row.workspaceId, row])
    );
    expect(rows.size).toBe(2);

    expect(rows.get(linked)?.credential.linked).toBe(true);
    expect(rows.get(linked)?.credential.hint).toBe('9f3a');
    expect(rows.get(linked)?.micros).toBe(0);

    expect(rows.get(bare)?.credential.linked).toBe(false);
    expect(rows.get(bare)?.credential.hint).toBe('');
    expect(rows.get(bare)?.credential.linkedAt).toBeNull();

    // The old statistic keeps its own rule: nothing retrieved, nothing listed.
    expect(summary.body.earned.byWorkspace).toEqual([]);
  });

  it('never lets the stored credential out, in any form', async () => {
    // Four characters may leave this server and nothing else. Not the key, not
    // the ciphertext, not a field named after either - a response body is
    // logged, cached, and pasted into issues.
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    await linkKey(workspaceId, '9f3a');

    const summary = await owner.get<Summary>('/rewards');
    const body = JSON.stringify(summary.body);

    expect(body).not.toContain(CIPHER);
    expect(body).not.toContain('Cipher');
    expect(body).toContain('9f3a');
  });

  it('answers an account with no workspaces with a zero it can explain', async () => {
    // Not an absent field and not an error: "you have no workspaces" is a fact
    // the console can state, where a missing figure renders as nothing at all.
    const { owner } = await signedInOwner();

    const summary = await owner.get<Summary>('/rewards');

    expect(summary.body.confirmedSpend.micros).toBe(0);
    expect(summary.body.confirmedSpend.byWorkspace).toEqual([]);
  });

  it('counts no spend belonging to another account', async () => {
    const first = await signedInOwner();
    const workspaceId = await makeWorkspace(first.owner);
    const agent = await mintKey(first.owner, workspaceId, 'Spender');
    await usage(workspaceId, agent.agent.id, 'verified', 8_000_000);

    const other = await signedInOwner();
    const summary = await other.owner.get<Summary>('/rewards');

    expect(summary.body.confirmedSpend.micros).toBe(0);
    expect(summary.body.confirmedSpend.byWorkspace).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The reward metric over HTTP: linking the key that confirms spend, and
// reporting the spend. Without these routes an owner cannot link a key at all,
// so nothing is ever confirmed and the whole chain pays zero.
// ---------------------------------------------------------------------------

/**
 * Deliberately distinctive: every five-character run of it is a string that
 * appears nowhere in a cuid, a timestamp or an error message, so the leak check
 * below cannot pass by luck.
 */
const OPENROUTER_KEY = 'sk-or-v1-zzqqwwjjvvmmttbbrrnnkkpplldd';

/** Last four characters - the one fragment the house rules let out. */
const KEY_HINT = OPENROUTER_KEY.slice(-4);

/**
 * Stands in for OpenRouter, and passes everything else through.
 *
 * The suite drives the server over the same global `fetch`, so a stub that
 * answered every call would break the client rather than the provider. Returns
 * the keys OpenRouter was actually presented with.
 */
function stubOpenRouter(answer: (url: URL) => { status: number; body?: unknown }): string[] {
  const realFetch = globalThis.fetch.bind(globalThis);
  const bearers: string[] = [];

  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== 'openrouter.ai') return realFetch(input as string, init);

    const headers = (init?.headers ?? {}) as Record<string, string>;
    bearers.push((headers.Authorization ?? '').replace(/^Bearer /, ''));

    const { status, body } = answer(url);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  return bearers;
}

/** OpenRouter recognising the key, so a test about linking is only about that. */
const keyAccepted = () => stubOpenRouter(() => ({ status: 200, body: { data: { label: 'e2e' } } }));

/**
 * Every substring of the key longer than the four characters a hint may carry.
 *
 * Returned rather than asserted so a failure names what escaped. Four
 * characters are what an owner needs to recognise which key is linked; a fifth
 * is a fragment of a credential in a response body, which nothing may return.
 */
function leakedFragments(body: unknown, key: string): string[] {
  const text = JSON.stringify(body);
  const found: string[] = [];

  for (let size = 5; size <= key.length; size += 1) {
    for (let start = 0; start + size <= key.length; start += 1) {
      const fragment = key.slice(start, start + size);
      if (text.includes(fragment)) found.push(fragment);
    }
  }

  return found;
}

describe('The provider credential', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('links a key, reports it as four characters, and clears it again', async () => {
    const bearers = keyAccepted();
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);

    const before = await owner.get<{ credential: { linked: boolean } }>(
      `/workspaces/${workspaceId}/usage/credential`
    );
    expect(before.status).toBe(200);
    expect(before.body.credential.linked).toBe(false);

    const linked = await owner.put<{
      credential: { linked: boolean; provider: string; hint: string; linkedAt: string | null };
    }>(`/workspaces/${workspaceId}/usage/credential`, { apiKey: OPENROUTER_KEY });

    expect(linked.status).toBe(200);
    expect(linked.body.credential).toMatchObject({
      linked: true,
      provider: 'openrouter',
      hint: KEY_HINT,
    });
    expect(linked.body.credential.linkedAt).not.toBeNull();

    // The key was checked against OpenRouter before it was stored, which is
    // what stops a typo becoming a workspace that mysteriously earns nothing.
    expect(bearers).toEqual([OPENROUTER_KEY]);

    const after = await owner.get<{ credential: { linked: boolean; hint: string } }>(
      `/workspaces/${workspaceId}/usage/credential`
    );
    expect(after.body.credential.linked).toBe(true);
    expect(after.body.credential.hint).toBe(KEY_HINT);

    const cleared = await owner.del<{
      credential: { linked: boolean; hint: string; linkedAt: string | null };
    }>(`/workspaces/${workspaceId}/usage/credential`);

    expect(cleared.status).toBe(200);
    expect(cleared.body.credential).toMatchObject({ linked: false, hint: '', linkedAt: null });

    const gone = await owner.get<{ credential: { linked: boolean } }>(
      `/workspaces/${workspaceId}/usage/credential`
    );
    expect(gone.body.credential.linked).toBe(false);
  });

  it('never returns more of the key than its hint, on any route or any failure', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);

    keyAccepted();
    const bodies: unknown[] = [
      (await owner.put(`/workspaces/${workspaceId}/usage/credential`, { apiKey: OPENROUTER_KEY }))
        .body,
      (await owner.get(`/workspaces/${workspaceId}/usage/credential`)).body,
      (await owner.del(`/workspaces/${workspaceId}/usage/credential`)).body,
    ];
    vi.unstubAllGlobals();

    // A refusal is where a key is most likely to be echoed back, inside the
    // message explaining what was wrong with it.
    stubOpenRouter(() => ({ status: 401, body: { error: { message: 'no such key' } } }));
    bodies.push(
      (await owner.put(`/workspaces/${workspaceId}/usage/credential`, { apiKey: OPENROUTER_KEY }))
        .body
    );

    for (const body of bodies) {
      expect(leakedFragments(body, OPENROUTER_KEY)).toEqual([]);
    }

    // And the hint really is in there, so the loop above is not passing because
    // the routes answer with nothing at all.
    expect(JSON.stringify(bodies[1])).toContain(KEY_HINT);
  });

  it('stores nothing when OpenRouter does not recognise the key', async () => {
    stubOpenRouter(() => ({ status: 401 }));
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);

    const refused = await owner.put<{ error: { code: string } }>(
      `/workspaces/${workspaceId}/usage/credential`,
      { apiKey: OPENROUTER_KEY }
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION');

    const status = await owner.get<{ credential: { linked: boolean; hint: string } }>(
      `/workspaces/${workspaceId}/usage/credential`
    );
    expect(status.body.credential.linked).toBe(false);
    expect(status.body.credential.hint).toBe('');
  });

  it('is the owner alone: another account and the workspace own agent are refused', async () => {
    keyAccepted();
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    await owner.put(`/workspaces/${workspaceId}/usage/credential`, { apiKey: OPENROUTER_KEY });

    const stranger = (await signedInOwner()).owner;
    const agent = client({ apiKey: (await mintKey(owner, workspaceId, 'Curious')).apiKey });

    for (const probe of [stranger, agent]) {
      const read = await probe.get<{ error: { code: string } }>(
        `/workspaces/${workspaceId}/usage/credential`
      );
      const write = await probe.put(`/workspaces/${workspaceId}/usage/credential`, {
        apiKey: 'sk-or-v1-somebody-elses-key-entirely',
      });
      const clear = await probe.del(`/workspaces/${workspaceId}/usage/credential`);

      expect(read.status).toBe(403);
      expect(write.status).toBe(403);
      expect(clear.status).toBe(403);
      // Not even which key is linked, or that one is.
      expect(JSON.stringify(read.body)).not.toContain(KEY_HINT);
    }

    // The owner's credential survived all of that untouched.
    const still = await owner.get<{ credential: { linked: boolean; hint: string } }>(
      `/workspaces/${workspaceId}/usage/credential`
    );
    expect(still.body.credential).toMatchObject({ linked: true, hint: KEY_HINT });
  });
});

describe('Reporting confirmed AI spend', () => {
  it('takes reports from an agent and refuses them from a signed-in person', async () => {
    // The metric follows what a connected subagent spent. A human in the
    // console is not the thing being measured - and a session-only route, which
    // is what most console routes look like, would leave the only participant
    // that can report unable to reach this at all.
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = client({ apiKey: (await mintKey(owner, workspaceId, 'Spender')).apiKey });

    const asPerson = await owner.post<{ error: { code: string } }>(
      `/workspaces/${workspaceId}/usage`,
      { reports: [{ generationId: `gen-person-${uid()}` }] }
    );
    expect(asPerson.status).toBe(403);
    expect(asPerson.body.error.code).toBe('ACCESS_DENIED');

    const asAgent = await agent.post<{
      accepted: number;
      duplicates: string[];
      rejected: { generationId: string; reason: string }[];
    }>(`/workspaces/${workspaceId}/usage`, {
      reports: [
        { generationId: `gen-ok-${uid()}`, model: 'anthropic/claude-haiku-4.5' },
        { generationId: 'no' },
      ],
    });

    expect(asAgent.status).toBe(201);
    expect(asAgent.body.accepted).toBe(1);
    // An unusable id is reported back, not fatal to the good entry beside it.
    expect(asAgent.body.rejected).toHaveLength(1);
    expect(asAgent.body.duplicates).toEqual([]);
  });

  it('counts one request once however many times it is reported', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = client({ apiKey: (await mintKey(owner, workspaceId, 'Replayer')).apiKey });

    const generationId = `gen-replay-${uid()}`;

    const first = await agent.post<{ accepted: number; duplicates: string[] }>(
      `/workspaces/${workspaceId}/usage`,
      { reports: [{ generationId, reportedCostMicros: 4_000 }] }
    );
    const again = await agent.post<{ accepted: number; duplicates: string[] }>(
      `/workspaces/${workspaceId}/usage`,
      { reports: [{ generationId, reportedCostMicros: 4_000_000 }] }
    );

    expect(first.body).toMatchObject({ accepted: 1, duplicates: [] });
    // Replayed with a thousand times the claimed cost, and it changes nothing:
    // the row exists and the second report writes none of itself onto it.
    expect(again.body).toMatchObject({ accepted: 0, duplicates: [generationId] });

    // Twice inside ONE batch is the same rule, on the path that reads the table
    // only once.
    const batched = await agent.post<{ accepted: number }>(`/workspaces/${workspaceId}/usage`, {
      reports: [{ generationId }, { generationId }],
    });
    expect(batched.body.accepted).toBe(0);
  });

  it('refuses a batch larger than the core will accept', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = client({ apiKey: (await mintKey(owner, workspaceId, 'Bulk Reporter')).apiKey });

    const reports = Array.from({ length: 201 }, (_, index) => ({
      generationId: `gen-flood-${index}-${uid()}`,
    }));

    const refused = await agent.post<{ error: { code: string } }>(
      `/workspaces/${workspaceId}/usage`,
      { reports }
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION');

    // Refused whole, not trimmed to fit: the first id of that batch is still
    // unknown, so nothing was quietly counted on the way to the refusal.
    const retry = await agent.post<{ accepted: number }>(`/workspaces/${workspaceId}/usage`, {
      reports: [reports[0]!],
    });
    expect(retry.body.accepted).toBe(1);
  });

  it('rate limits an agent reporting in a loop', async () => {
    // Every accepted row becomes a provider call later, so an unbounded loop
    // here spends somebody else's API budget rather than filling a table.
    resetRateLimits();
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = client({ apiKey: (await mintKey(owner, workspaceId, 'Looper')).apiKey });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 34; attempt += 1) {
      const response = await agent.post(`/workspaces/${workspaceId}/usage`, {
        reports: [{ generationId: `gen-loop-${attempt}-${uid()}` }],
      });
      statuses.push(response.status);
    }

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    resetRateLimits();
  });

  it('will not let an agent report spend into another workspace', async () => {
    const insider = await signedInOwner();
    const theirs = await makeWorkspace(insider.owner, 'Theirs');

    const outsider = await signedInOwner();
    const ours = await makeWorkspace(outsider.owner, 'Ours');
    const agent = client({ apiKey: (await mintKey(outsider.owner, ours, 'Ambitious')).apiKey });

    const attempt = await agent.post<{ error: { code: string } }>(`/workspaces/${theirs}/usage`, {
      reports: [{ generationId: `gen-cross-${uid()}` }],
    });

    expect(attempt.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The live feed: a long-lived response, which is a shape nothing else here has.
// ---------------------------------------------------------------------------

interface StreamFrame {
  /** The SSE event name, or 'message' when the frame carried none. */
  event: string;
  data: string;
  /** Comment lines - the heartbeat travels as one and carries no data. */
  comment: string;
}

function parseFrame(chunk: string): StreamFrame {
  let event = 'message';
  const data: string[] = [];
  const comments: string[] = [];

  for (const line of chunk.split('\n')) {
    if (line === '') continue;
    if (line.startsWith(':')) {
      comments.push(line.slice(1).trim());
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  return { event, data: data.join('\n'), comment: comments.join(' ') };
}

/**
 * Opens the stream and reads it frame by frame.
 *
 * The cookie jar above cannot be used for this: it reads a response to the end,
 * and this response has no end until somebody closes it. What the console does
 * is read forward and stop, so that is what the suite does too.
 */
async function openStream(path: string, headers: Record<string, string>) {
  const abort = new AbortController();
  const response = await fetch(`${base}/api${path}`, {
    headers: { Accept: 'text/event-stream', Origin: config.webOrigin, ...headers },
    signal: abort.signal,
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const waiting: StreamFrame[] = [];

  async function pump(): Promise<void> {
    // Bounded, so a frame that never arrives fails as a missing frame rather
    // than as a test timeout that says nothing about which one was missing.
    let deadline: NodeJS.Timeout | undefined;
    const overdue = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error(`no frame arrived within ${FRAME_WAIT_MS}ms`)),
        FRAME_WAIT_MS
      );
    });

    try {
      const { value, done } = await Promise.race([reader.read(), overdue]);
      if (done) throw new Error('the stream closed before the frame under test arrived');

      buffer += decoder.decode(value, { stream: true });
      for (let split = buffer.indexOf('\n\n'); split !== -1; split = buffer.indexOf('\n\n')) {
        waiting.push(parseFrame(buffer.slice(0, split)));
        buffer = buffer.slice(split + 2);
      }
    } finally {
      clearTimeout(deadline);
    }
  }

  async function frame(): Promise<StreamFrame> {
    while (waiting.length === 0) await pump();
    return waiting.shift()!;
  }

  async function frameOfType(type: string): Promise<StreamFrame> {
    for (;;) {
      const next = await frame();
      if (next.event === type) return next;
      // Nest turns a thrown poll into an error frame and ends the stream.
      // Reported here, or the failure reads as an unexplained disconnection.
      if (next.event === 'error') throw new Error(`the stream reported: ${next.data}`);
    }
  }

  return { response, frame, frameOfType, close: () => abort.abort() };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long any one frame may take before the suite calls it missing. */
const FRAME_WAIT_MS = 8_000;

/**
 * Opens the stream only far enough to read the status line, then lets go.
 *
 * The refusal tests cannot use the cookie-jar client: it reads a response to
 * the end, and a stream that actually opened does not have one. Reading the
 * status and walking away is also what a refused client really does.
 */
async function streamStatus(path: string, headers: Record<string, string>) {
  const abort = new AbortController();
  const response = await fetch(`${base}/api${path}`, {
    headers: { Accept: 'text/event-stream', ...headers },
    signal: abort.signal,
  });

  if (response.status === 200) {
    abort.abort();
    return { status: 200, code: 'the stream opened' };
  }

  const body = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: body.error.code };
}

/** Counts the reads the stream makes while `run` is in flight. */
async function countingReads<T>(run: (reads: () => number) => Promise<T>): Promise<T> {
  type EventsSince = typeof Memory.prototype.eventsSince;
  const real: EventsSince = Memory.prototype.eventsSince;
  let reads = 0;

  Memory.prototype.eventsSince = function counted(
    this: Memory,
    ...args: Parameters<EventsSince>
  ): ReturnType<EventsSince> {
    reads += 1;
    return real.apply(this, args);
  };

  try {
    return await run(() => reads);
  } finally {
    Memory.prototype.eventsSince = real;
  }
}

describe('Watching a workspace work', () => {
  it('says where the trail stands before it says anything else', async () => {
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = client({ apiKey: (await mintKey(owner, workspaceId, 'Streamer')).apiKey });

    const stream = await openStream(`/workspaces/${workspaceId}/memory/events`, {
      Cookie: owner.cookie,
    });

    try {
      expect(stream.response.status).toBe(200);
      expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
      // Anything cached here would be a replay of somebody else's workspace.
      expect(stream.response.headers.get('cache-control')).toContain('no-store');
      // The stream writes its own headers rather than going through Nest's
      // reply path, which is the one place the console's credentials could be
      // dropped on the floor.
      expect(stream.response.headers.get('access-control-allow-credentials')).toBe('true');
      expect(stream.response.headers.get('access-control-allow-origin')).toBe(config.webOrigin);

      const ready = await stream.frame();
      expect(ready.event).toBe('ready');

      // The cursor arrives first so the console can say "my list ends here" -
      // without it the client cannot tell a quiet workspace from a lost entry.
      const { cursor } = JSON.parse(ready.data) as { cursor: { after: string; afterId?: string } };
      expect(new Date(cursor.after).toString()).not.toBe('Invalid Date');

      const written = await agent.post<{ recordId: string }>(
        `/workspaces/${workspaceId}/memory/add`,
        {
          type: 'fact',
          text: 'The application must work offline.',
          topic: 'release-1',
          idempotencyKey: idem('stream'),
        }
      );
      expect(written.status).toBe(201);

      const landed = await stream.frameOfType('event');
      const row = JSON.parse(landed.data) as { action: string; targetId: string; detail: unknown };
      expect(row.action).toBe('memory.add');
      expect(row.targetId).toBe(written.body.recordId);
      // The mapped row, not the stored one: detail is an object here, text there.
      expect(row.detail).toMatchObject({ topic: 'release-1' });
    } finally {
      stream.close();
    }
  });

  it('stops reading the database the moment the client goes away', async () => {
    // The whole cost of this route is the interval behind it. Left running
    // after a closed tab it queries forever, and nobody would ever see it: the
    // console looks fine, and the server quietly does a workspace's worth of
    // reads a second for every tab anyone ever opened.
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);

    await countingReads(async (reads) => {
      const stream = await openStream(`/workspaces/${workspaceId}/memory/events`, {
        Cookie: owner.cookie,
      });
      await stream.frame();

      await pause(2_200);
      expect(reads()).toBeGreaterThan(0);

      stream.close();
      // Long enough for a read already in flight to finish and be counted.
      await pause(300);
      const afterClose = reads();

      await pause(2_500);
      expect(reads()).toBe(afterClose);
    });
  });

  it('drains a burst rather than dripping it out a page a second', async () => {
    // An import or a large merge appends far more than one page between two
    // ticks. Waiting out the interval per page would put the console minutes
    // behind its own agents on exactly the occasions it matters most.
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);

    const stream = await openStream(`/workspaces/${workspaceId}/memory/events`, {
      Cookie: owner.cookie,
    });

    try {
      const ready = await stream.frame();
      const { cursor } = JSON.parse(ready.data) as { cursor: { after: string } };
      const base = new Date(cursor.after).getTime();

      // Distinct timestamps, a millisecond apart, so the burst is a burst and
      // not a test of the tiebreak - that one lives in the core suite.
      await getPrisma().auditEvent.createMany({
        data: Array.from({ length: 500 }, (_, index) => ({
          workspaceId,
          actorType: 'system',
          actorId: 'suite',
          actorName: 'Suite',
          action: 'memory.add',
          targetId: `burst-${index}`,
          detail: '{}',
          createdAt: new Date(base + index + 1),
        })),
      });

      const started = Date.now();
      const seen: string[] = [];
      while (seen.length < 500) {
        const next = await stream.frameOfType('event');
        seen.push((JSON.parse(next.data) as { targetId: string }).targetId);
      }

      expect(seen[0]).toBe('burst-0');
      expect(seen.at(-1)).toBe('burst-499');
      // Three pages. At one page per tick this could not finish inside three
      // seconds; polling straight back finishes it inside one.
      expect(Date.now() - started).toBeLessThan(2_500);
    } finally {
      stream.close();
    }
  });

  it('keeps a silent connection alive with a comment', async () => {
    // Proxies close connections that have said nothing. A comment is the one
    // thing that can be sent without inventing an entry that never happened.
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);

    const realHeartbeat = streamTiming.heartbeatMs;
    streamTiming.heartbeatMs = 250;

    const stream = await openStream(`/workspaces/${workspaceId}/memory/events`, {
      Cookie: owner.cookie,
    });

    try {
      expect((await stream.frame()).event).toBe('ready');
      const beat = await stream.frame();
      expect(beat.comment).toBe('heartbeat');
      // A comment, not a message: a client must never mistake it for work.
      expect(beat.data).toBe('');
    } finally {
      stream.close();
      streamTiming.heartbeatMs = realHeartbeat;
    }
  });

  it('refuses an agent key, with a body rather than a silent open socket', async () => {
    // An agent has no reason to watch a console. Refusing before the stream
    // exists is what makes this a 403 a client can read at all - after the
    // headers are out, the status is 200 whatever happens next.
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const { apiKey: agentKey } = await mintKey(owner, workspaceId, 'Nosy');

    const refused = await streamStatus(`/workspaces/${workspaceId}/memory/events`, {
      Authorization: `Bearer ${agentKey}`,
    });

    expect(refused.status).toBe(403);
    expect(refused.code).toBe('ACCESS_DENIED');
  });

  it('refuses a signed-in person who does not own the workspace', async () => {
    const insider = await signedInOwner();
    const theirs = await makeWorkspace(insider.owner, 'Theirs');

    const outsider = await signedInOwner();
    const refused = await streamStatus(`/workspaces/${theirs}/memory/events`, {
      Cookie: outsider.owner.cookie,
    });

    expect(refused.status).toBe(403);
    expect(refused.code).toBe('ACCESS_DENIED');
  });

  it('answers for a workspace that does not exist exactly as it answers for one that is not yours', async () => {
    // SS7.1 forbids handing back content, summary OR metadata from memory the
    // caller cannot see, and whether a workspace exists is metadata. A 404 here
    // beside the 403 above would turn this route into an existence oracle: try
    // ids, and the status code sorts the real ones from the invented ones.
    const { owner } = await signedInOwner();

    const missing = await streamStatus('/workspaces/ws-that-never-existed/memory/events', {
      Cookie: owner.cookie,
    });

    expect(missing.status).toBe(403);
    expect(missing.code).toBe('ACCESS_DENIED');
  });

  it('rate limits a client that reconnects in a loop', async () => {
    // Every connection is a poll that runs until it is closed, so reopening in
    // a loop multiplies the read rate by however fast the loop goes.
    resetRateLimits();
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 34; attempt += 1) {
      const abort = new AbortController();
      const response = await fetch(
        `${base}/api/workspaces/${workspaceId}/memory/events`,
        { headers: { Cookie: owner.cookie, Accept: 'text/event-stream' }, signal: abort.signal }
      );
      statuses.push(response.status);
      abort.abort();
    }

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    resetRateLimits();
  });
});

// ---------------------------------------------------------------------------
describe('Sign-In-With-Ethereum: a second door, never a gate', () => {
  /**
   * The chain, stubbed at the JSON-RPC wire and nowhere above it.
   *
   * viem's real verifier runs against this: the message is parsed by viem, the
   * signature is checked by viem, and only the transport is ours. Stubbing the
   * verifier instead would leave these tests proving that a stub says no, which
   * proves nothing. The one thing this wire cannot do is execute EVM bytecode,
   * so the ERC-6492/1271 call fails and viem settles an EOA signature by
   * recovering the address - real cryptography, and the half a test can reach.
   */
  let chainReachable = true;

  const stubChain = custom(
    {
      async request({ method }: { method: string }) {
        if (!chainReachable) throw new Error('fetch failed');
        if (method === 'eth_chainId') return numberToHex(activeChain.id);
        throw new Error('no EVM behind this transport');
      },
    },
    { retryCount: 0 }
  );

  beforeAll(() => setSiweTransport(stubChain));
  afterAll(() => setSiweTransport(null));
  beforeEach(() => {
    chainReachable = true;
  });

  /**
   * A client that keeps more than one cookie.
   *
   * The jar above holds a single cookie string, which is all the email door
   * ever sets. A wallet sign-in answers with two Set-Cookie headers - the spent
   * nonce being cleared, and the new session - so a jar that kept only the last
   * one seen would throw the session away and every assertion after it would be
   * about the wrong thing.
   */
  function walletClient() {
    const jar = new Map<string, string>();

    async function call<T>(method: string, path: string, body?: unknown): Promise<Response<T>> {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const cookies = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      if (cookies) headers.Cookie = cookies;

      const response = await fetch(`${base}/api${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(';')[0]!;
        const equals = pair.indexOf('=');
        const name = pair.slice(0, equals);
        const value = pair.slice(equals + 1);
        if (value) jar.set(name, value);
        else jar.delete(name);
      }

      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
    }

    return {
      get: <T>(path: string) => call<T>('GET', path),
      post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
      del: <T>(path: string) => call<T>('DELETE', path),
      has: (name: string) => jar.has(name),
      cookieNames: () => [...jar.keys()],
    };
  }

  const newAccount = () => privateKeyToAccount(generatePrivateKey());
  type Account = ReturnType<typeof newAccount>;

  interface WalletUserBody {
    id: string;
    email: string | null;
    displayName: string;
    wallet: { address: string; provenAt: string | null } | null;
  }

  /** Everything the console must put in the message, in one place. */
  function messageFields(address: `0x${string}`, nonce: string) {
    return {
      address,
      chainId: activeChain.id,
      domain: config.webHost,
      nonce,
      uri: `${config.webOrigin}/console`,
      version: '1' as const,
      statement: SIWE_STATEMENT,
      issuedAt: new Date(),
    };
  }

  /**
   * One whole sign-in, with a seam for each thing a test needs to spoil: what
   * the message says, and who signs it.
   */
  async function signInWith(
    wallet: ReturnType<typeof walletClient>,
    account: Account,
    options: { overrides?: Record<string, unknown>; signer?: Account } = {}
  ) {
    const minted = await wallet.get<{ nonce: string }>('/auth/siwe/nonce');
    expect(minted.status).toBe(200);

    const message = createSiweMessage({
      ...messageFields(account.address, minted.body.nonce),
      ...options.overrides,
    } as never);
    const signature = await (options.signer ?? account).signMessage({ message });

    return {
      message,
      signature,
      response: await wallet.post<{
        user: WalletUserBody;
        error: { code: string; message: string };
      }>('/auth/siwe/verify', { message, signature }),
    };
  }

  it('signs in a wallet nobody has seen before and opens an account with no email', async () => {
    const wallet = walletClient();
    const account = newAccount();

    const { response } = await signInWith(wallet, account);

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBeNull();
    expect(response.body.user.wallet?.address).toBe(account.address.toLowerCase());
    // provenAt is the whole point: a typed address never gets one.
    expect(response.body.user.wallet?.provenAt).not.toBeNull();
    expect(wallet.has('offcut_session')).toBe(true);
    // One nonce, one use - the cookie is gone whatever happened.
    expect(wallet.has('offcut_siwe')).toBe(false);

    const me = await wallet.get<{ user: WalletUserBody }>('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(response.body.user.id);
    expect(me.body.user.email).toBeNull();
    const lowercase = account.address.toLowerCase();
    expect(me.body.user.displayName).toBe(`${lowercase.slice(0, 6)}…${lowercase.slice(-4)}`);
    expect(me.body.user.wallet?.address).toBe(account.address.toLowerCase());
  });

  it('gives the wallet door the same session the email door gives', async () => {
    // The session is where the two doors become one. If a wallet session were
    // second class anywhere, memory would have started depending on a wallet,
    // which SS5 line 151 forbids outright.
    const wallet = walletClient();
    await signInWith(wallet, newAccount());

    const created = await wallet.post<{ workspace: { id: string } }>('/workspaces', {
      name: 'Opened With A Wallet',
    });
    expect(created.status).toBe(201);

    const listed = await wallet.get<{ workspaces: { id: string }[] }>('/workspaces');
    expect(listed.body.workspaces.map((workspace) => workspace.id)).toContain(
      created.body.workspace.id
    );
  });

  it('signs into the account that linked this address by hand rather than opening a second one', async () => {
    const account = newAccount();
    const { owner } = await signedInOwner();
    await owner.put('/auth/wallet', { address: account.address });

    // Typed in, so nothing is proved yet and /auth/me says so.
    const before = await owner.get<{ user: WalletUserBody }>('/auth/me');
    expect(before.body.user.wallet?.provenAt).toBeNull();

    const wallet = walletClient();
    const { response } = await signInWith(wallet, account);

    expect(response.status).toBe(201);
    expect(response.body.user.email).not.toBeNull();
    expect(response.body.user.wallet?.provenAt).not.toBeNull();

    const after = await owner.get<{ user: WalletUserBody }>('/auth/me');
    expect(response.body.user.id).toBe(after.body.user.id);
    expect(after.body.user.wallet?.provenAt).not.toBeNull();
  });

  it('refuses a nonce this browser was never given', async () => {
    const wallet = walletClient();
    // A nonce cookie is minted, then a different nonce is signed: exactly what
    // replaying a message captured from somebody else's sign-in looks like.
    const { response } = await signInWith(wallet, newAccount(), {
      overrides: { nonce: 'abcdefghij0123456789' },
    });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toMatch(/nonce/i);
  });

  /** One Set-Cookie value, read without any intention of obeying it. */
  function setCookieValue(response: globalThis.Response, name: string): string | null {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';')[0]!;
      const equals = pair.indexOf('=');
      if (pair.slice(0, equals) === name) return pair.slice(equals + 1) || null;
    }
    return null;
  }

  /**
   * A nonce captured off the wire, and a way to keep spending it.
   *
   * Deliberately NOT a cookie jar. Every other test here drives a browser, and
   * a browser is the one client that cooperates: it drops the nonce cookie the
   * moment the server clears it, so a jar can only ever prove that the jar
   * works. The attacker a nonce exists to stop is the client that does not
   * cooperate - curl, a proxy, anyone replaying a request out of an access log,
   * a HAR or a terminated TLS session. It keeps the cookie VALUE and sends it
   * back verbatim, which is what these two tests do.
   */
  async function captureNonce() {
    const minted = await fetch(`${base}/api/auth/siwe/nonce`);
    expect(minted.status).toBe(200);

    const cookie = setCookieValue(minted, config.siweCookie);
    expect(cookie).toBeTruthy();
    const { nonce } = (await minted.json()) as { nonce: string };

    return {
      /** A message for this nonce, signed by whoever is told to sign it. */
      async sign(account: Account, signer: Account = account) {
        const message = createSiweMessage(messageFields(account.address, nonce) as never);
        return { message, signature: await signer.signMessage({ message }) };
      },

      /** The captured request, sent again: same body, same cookie header. */
      async verify(request: { message: string; signature: string }) {
        const response = await fetch(`${base}/api/auth/siwe/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${config.siweCookie}=${cookie}`,
          },
          body: JSON.stringify(request),
        });

        const text = await response.text();
        return {
          status: response.status,
          body: (text ? JSON.parse(text) : {}) as {
            user?: WalletUserBody;
            error?: { message: string };
          },
          session: setCookieValue(response, config.sessionCookie),
        };
      },
    };
  }

  it('refuses a captured sign-in request replayed by a client that ignores Set-Cookie', async () => {
    const captured = await captureNonce();
    const request = await captured.sign(newAccount());

    const first = await captured.verify(request);
    expect(first.status).toBe(201);
    expect(first.session).toBeTruthy();

    // Byte for byte the same request, three times, from something that never
    // took the cleared cookie. If the nonce were spent only in the browser,
    // each of these would be a fresh thirty-day session on somebody else's
    // memory, bought by having watched one sign-in once.
    const second = await captured.verify(request);
    const third = await captured.verify(request);

    expect(second.status).toBe(401);
    expect(second.body.error?.message).toMatch(/nonce/i);
    expect(second.session).toBeNull();
    expect(third.status).toBe(401);
    expect(third.session).toBeNull();
  });

  it('spends the nonce on a refusal too, so being caught out buys no second go', async () => {
    const captured = await captureNonce();
    const claimed = newAccount();

    const forged = await captured.sign(claimed, newAccount());
    const refused = await captured.verify(forged);
    expect(refused.status).toBe(401);
    expect(refused.body.error?.message).toMatch(/not made by the address/i);

    // The same cookie, and this time the address signs for itself. A refusal is
    // exactly the moment an attacker would want another attempt, so the nonce
    // has to be gone already - one nonce is one attempt, not one success.
    const honest = await captured.sign(claimed);
    const again = await captured.verify(honest);

    expect(again.status).toBe(401);
    expect(again.body.error?.message).toMatch(/nonce/i);
    expect(again.session).toBeNull();
  });

  it('refuses a signature made for another domain', async () => {
    const wallet = walletClient();
    // What a phishing site would collect: a perfectly valid signature, made
    // over its own domain, offered here.
    const { response } = await signInWith(wallet, newAccount(), {
      overrides: { domain: 'offcut-agent.example.net' },
    });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toContain('offcut-agent.example.net');
  });

  it('refuses a message naming a chain this server does not sign in on', async () => {
    const other = activeChain.id === 4663 ? 46630 : 4663;

    const wrongKnownChain = await signInWith(walletClient(), newAccount(), {
      overrides: { chainId: other },
    });
    expect(wrongKnownChain.response.status).toBe(401);
    expect(wrongKnownChain.response.body.error.message).toContain(String(other));

    const strangerChain = await signInWith(walletClient(), newAccount(), {
      overrides: { chainId: 1 },
    });
    expect(strangerChain.response.status).toBe(401);
  });

  it('refuses a message that has expired', async () => {
    const wallet = walletClient();
    const { response } = await signInWith(wallet, newAccount(), {
      overrides: {
        issuedAt: new Date(Date.now() - 60_000),
        expirationTime: new Date(Date.now() - 1_000),
      },
    });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toMatch(/expired/i);
  });

  it('refuses a message signed longer ago than a sign-in takes', async () => {
    const wallet = walletClient();
    const { response } = await signInWith(wallet, newAccount(), {
      overrides: { issuedAt: new Date(Date.now() - 30 * 60_000) },
    });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toMatch(/too long ago/i);
  });

  it('refuses a signature made by a different key', async () => {
    const wallet = walletClient();
    const claimed = newAccount();
    const impostor = newAccount();

    // The message names one address; another key signed it. Everything else
    // about the request is perfect, so only the cryptography can refuse this.
    const { response } = await signInWith(wallet, claimed, { signer: impostor });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toMatch(/not made by the address/i);
  });

  it('refuses a message carrying a statement this service never wrote', async () => {
    const wallet = walletClient();
    const { response } = await signInWith(wallet, newAccount(), {
      overrides: { statement: 'Approve unlimited spending of your tokens.' },
    });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toMatch(/statement/i);
  });

  it('refuses something that is not a Sign-In-With-Ethereum message at all', async () => {
    const wallet = walletClient();
    const account = newAccount();
    await wallet.get('/auth/siwe/nonce');

    const message = 'give me a session';
    const signature = await account.signMessage({ message });
    const response = await wallet.post<{ error: { code: string } }>('/auth/siwe/verify', {
      message,
      signature,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
  });

  it('refuses rather than trusts the signature when the chain cannot be reached', async () => {
    const wallet = walletClient();
    chainReachable = false;

    // A genuine signature from the genuine holder. It is still refused, because
    // a server that could not check a signature has not checked it - and a
    // smart account's signature is only ever valid because the chain says so.
    const { response } = await signInWith(wallet, newAccount());

    expect(response.status).toBe(503);
    expect(response.body.error.message).toMatch(/could not be reached/i);
    expect(wallet.has('offcut_session')).toBe(false);

    const me = await wallet.get('/auth/me');
    expect(me.status).toBe(401);
  });

  it('will not let a wallet-only account be reached with any password', async () => {
    const wallet = walletClient();
    const account = newAccount();
    expect((await signInWith(wallet, account)).response.status).toBe(201);

    const address = account.address.toLowerCase();
    // The address is public, so these are the handles an attacker would try.
    // The account answers to none of them, and says the same thing every time.
    for (const email of [`${address}@offcut.test`, 'owner@offcut.test']) {
      for (const password of ['', 'password', address]) {
        const attempt = await client().post<{ error: { message: string } }>('/auth/login', {
          email,
          password,
        });
        // 400 when the password field is empty, 401 when the pair is plausible.
        expect([400, 401]).toContain(attempt.status);
        if (attempt.status === 401) {
          expect(attempt.body.error.message).toBe('Incorrect email or password.');
        }
      }
    }
  });

  it('rate limits wallet sign-in attempts', async () => {
    resetRateLimits();
    const wallet = walletClient();
    const account = newAccount();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const message = createSiweMessage(
        messageFields(account.address, 'abcdefghij0123456789') as never
      );
      const signature = await account.signMessage({ message });
      const response = await wallet.post('/auth/siwe/verify', { message, signature });
      statuses.push(response.status);
    }

    // Ten a quarter-hour is far above an honest sign-in and far below useful
    // guessing at somebody else's signature.
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    resetRateLimits();
  });

  it('hands out the nonce in an httpOnly cookie that is not the nonce', async () => {
    const wallet = walletClient();
    const minted = await wallet.get<{ nonce: string }>('/auth/siwe/nonce');

    expect(minted.status).toBe(200);
    expect(minted.body.nonce.length).toBeGreaterThanOrEqual(8);
    expect(wallet.cookieNames()).toContain('offcut_siwe');

    const raw = await fetch(`${base}/api/auth/siwe/nonce`);
    const header = raw.headers.getSetCookie().join(' ');
    const body = (await raw.json()) as { nonce: string };

    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    // Signed, not stored: the cookie carries the nonce inside a token this
    // server minted, which is how there is no nonce table anywhere.
    const value = header.split('offcut_siwe=')[1]!.split(';')[0]!;
    expect(value).not.toBe(body.nonce);
    expect(value.split('.').length).toBe(3);
  });
});

describe('Picking the stream back up where it dropped', () => {
  it('replays what was appended while the client was away, and refuses a cursor that is not a time', async () => {
    // Without this the reconnect is a silent hole: the stream would restart at
    // the head, and every entry written between the drop and the retry would
    // exist in the store, in the timeline, and nowhere the open console can
    // see it until somebody reloads the page.
    const { owner } = await signedInOwner();
    const workspaceId = await makeWorkspace(owner);
    const agent = client({ apiKey: (await mintKey(owner, workspaceId, 'Resumer')).apiKey });

    const first = await openStream(`/workspaces/${workspaceId}/memory/events`, {
      Cookie: owner.cookie,
    });

    let cursor: { after: string; afterId?: string };
    try {
      const ready = await first.frame();
      cursor = (JSON.parse(ready.data) as { cursor: typeof cursor }).cursor;
    } finally {
      first.close();
    }

    // The gap: written with nobody watching.
    const written = await agent.post<{ recordId: string }>(
      `/workspaces/${workspaceId}/memory/add`,
      {
        type: 'decision',
        text: 'Ship the console before the CLI.',
        topic: 'release-1',
        idempotencyKey: idem('resume'),
      }
    );
    expect(written.status).toBe(201);

    const query = new URLSearchParams({ after: cursor.after });
    if (cursor.afterId !== undefined) query.set('afterId', cursor.afterId);

    const resumed = await openStream(
      `/workspaces/${workspaceId}/memory/events?${query.toString()}`,
      { Cookie: owner.cookie }
    );

    try {
      const ready = await resumed.frame();
      expect(ready.event).toBe('ready');
      // Not the head: the stream stands where the client left it.
      expect((JSON.parse(ready.data) as { cursor: typeof cursor }).cursor).toEqual(cursor);

      const landed = await resumed.frameOfType('event');
      expect((JSON.parse(landed.data) as { targetId: string }).targetId).toBe(written.body.recordId);
    } finally {
      resumed.close();
    }

    // A cursor that is not a timestamp is a refusal before the headers, not an
    // error frame inside a 200 that no client reads as a refusal.
    const refused = await streamStatus(`/workspaces/${workspaceId}/memory/events?after=yesterday`, {
      Cookie: owner.cookie,
    });
    expect(refused.status).toBe(400);
    expect(refused.code).toBe('VALIDATION');
  });
});
