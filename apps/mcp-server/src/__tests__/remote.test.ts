/**
 * The remote store, against a fake server.
 *
 * What is being proved here is not that fetch works. It is that a key minted
 * on https://offcut.tech reaches https://offcut.tech - the exact thing that was
 * false before this file existed, when the console printed a command that
 * opened a SQLite file on the caller's machine and refused the key it had just
 * been given.
 *
 * So: the URL, the Bearer header, the body, and every way it can fail said in
 * words the person reading the client's log can act on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RemoteError, createRemoteMemory, normaliseBaseUrl, pingServer } from '../remote';
import type { FetchLike } from '../remote';
import { MEMORY_OPERATIONS } from '../memory-surface';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A server that answers however the test needs, and records what it was asked. */
function fakeServer(
  reply: { status?: number; body?: unknown; text?: string } | ((call: Call) => {
    status?: number;
    body?: unknown;
    text?: string;
  })
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);

    const answer = typeof reply === 'function' ? reply(call) : reply;
    const status = answer.status ?? 200;
    const text = answer.text ?? JSON.stringify(answer.body ?? {});

    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };

  return { fetchImpl, calls };
}

const KEY = 'offcut_sk_live_example';

describe('the remote store addresses the server it was given', () => {
  it('sends every memory operation to its own route, with the key as a Bearer token', async () => {
    const { fetchImpl, calls } = fakeServer({ body: { ok: true } });
    const memory = createRemoteMemory({ baseUrl: 'https://offcut.tech', apiKey: KEY, fetchImpl });

    for (const operation of MEMORY_OPERATIONS) {
      await memory[operation]({ workspaceId: 'ws_1', topic: 'release-1' });
    }

    expect(calls.map((call) => call.url)).toEqual(
      MEMORY_OPERATIONS.map((operation) => `https://offcut.tech/api/workspaces/ws_1/memory/${operation}`)
    );

    for (const call of calls) {
      expect(call.method).toBe('POST');
      expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(call.headers['content-type']).toBe('application/json');
      // The body is the argument object the local method would have taken,
      // untouched. The workspace appears in the path as well, which is how the
      // console addresses it; apps/api reads it from there.
      expect(call.body).toEqual({ workspaceId: 'ws_1', topic: 'release-1' });
    }
  });

  it('returns what the server answered, unchanged', async () => {
    const { fetchImpl } = fakeServer({ body: { recordId: 'rec_9', version: 1 } });
    const memory = createRemoteMemory({ baseUrl: 'https://offcut.tech', apiKey: KEY, fetchImpl });

    await expect(memory.add({ workspaceId: 'ws_1', text: 'x' })).resolves.toEqual({
      recordId: 'rec_9',
      version: 1,
    });
  });

  it('reports usage to the usage controller, with the reports as the body', async () => {
    const { fetchImpl, calls } = fakeServer({ body: { accepted: 1, duplicates: [], rejected: [] } });
    const memory = createRemoteMemory({ baseUrl: 'https://offcut.tech', apiKey: KEY, fetchImpl });

    await memory.reportUsage('ws_1', [{ generationId: 'gen-1' }]);

    expect(calls[0].url).toBe('https://offcut.tech/api/workspaces/ws_1/usage');
    expect(calls[0].body).toEqual({ reports: [{ generationId: 'gen-1' }] });
  });

  it('escapes the workspace id rather than pasting it into a path', async () => {
    const { fetchImpl, calls } = fakeServer({ body: {} });
    const memory = createRemoteMemory({ baseUrl: 'https://offcut.tech', apiKey: KEY, fetchImpl });

    await memory.recall({ workspaceId: 'ws/../other' });

    expect(calls[0].url).toBe('https://offcut.tech/api/workspaces/ws%2F..%2Fother/memory/recall');
  });

  it('refuses a call with no workspace before it makes a request', async () => {
    const { fetchImpl, calls } = fakeServer({ body: {} });
    const memory = createRemoteMemory({ baseUrl: 'https://offcut.tech', apiKey: KEY, fetchImpl });

    await expect(memory.add({ text: 'no workspace' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(calls).toHaveLength(0);
  });

  it('accepts a pasted URL with a trailing slash or a trailing /api', () => {
    expect(normaliseBaseUrl('https://offcut.tech/')).toBe('https://offcut.tech');
    expect(normaliseBaseUrl('https://offcut.tech/api')).toBe('https://offcut.tech');
    expect(normaliseBaseUrl('  https://offcut.tech/api/  ')).toBe('https://offcut.tech');
    expect(normaliseBaseUrl('http://localhost:4000')).toBe('http://localhost:4000');
  });
});

describe('what it says when it fails', () => {
  it('names the per-server rule when the key is refused', async () => {
    const { fetchImpl } = fakeServer({
      status: 401,
      body: { error: { code: 'UNAUTHENTICATED', message: 'No verified connection.', details: {} } },
    });
    const memory = createRemoteMemory({ baseUrl: 'https://offcut.tech', apiKey: KEY, fetchImpl });

    await expect(memory.recall({ workspaceId: 'ws_1' })).rejects.toThrow(
      'That key was not accepted by https://offcut.tech. Keys are minted per server: a key from one OFFCUT does not work on another.'
    );
  });

  it('says the same on a 403, and repeats what the server said', async () => {
    const { fetchImpl } = fakeServer({
      status: 403,
      body: { error: { code: 'REVOKED', message: 'Access for "b" has been revoked.', details: {} } },
    });
    const memory = createRemoteMemory({ baseUrl: 'https://offcut.tech', apiKey: KEY, fetchImpl });

    const failure = await memory.recall({ workspaceId: 'ws_1' }).catch((error) => error);

    expect(failure).toBeInstanceOf(RemoteError);
    expect(failure.code).toBe('REVOKED');
    expect(failure.message).toContain('a key from one OFFCUT does not work on another');
    expect(failure.message).toContain('Access for "b" has been revoked.');
  });

  it('says the workspace is not on that server on a 404', async () => {
    const { fetchImpl } = fakeServer({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Workspace not found.', details: {} } },
    });
    const memory = createRemoteMemory({ baseUrl: 'https://offcut.tech', apiKey: KEY, fetchImpl });

    const failure = await memory.recall({ workspaceId: 'ws_missing' }).catch((error) => error);

    expect(failure.code).toBe('NOT_FOUND');
    expect(failure.message).toContain('That workspace is not on https://offcut.tech');
  });

  it('asks whether the URL is an OFFCUT at all when a 404 is not an OFFCUT error', async () => {
    const { fetchImpl } = fakeServer({ status: 404, text: '<html>Cannot POST</html>' });
    const memory = createRemoteMemory({ baseUrl: 'https://example.com', apiKey: KEY, fetchImpl });

    const failure = await memory.recall({ workspaceId: 'ws_1' }).catch((error) => error);

    expect(failure.code).toBe('UNREACHABLE');
    expect(failure.message).toContain('Is OFFCUT_API_URL pointing at an OFFCUT server?');
  });

  it('carries a core refusal across unchanged', async () => {
    const { fetchImpl } = fakeServer({
      status: 409,
      body: {
        error: {
          code: 'VERSION_CONFLICT',
          message: 'Record rec_1 has moved on: expected version 1, current is 2.',
          details: { recordId: 'rec_1' },
        },
      },
    });
    const memory = createRemoteMemory({ baseUrl: 'https://offcut.tech', apiKey: KEY, fetchImpl });

    const failure = await memory.add({ workspaceId: 'ws_1' }).catch((error) => error);

    expect(failure.code).toBe('VERSION_CONFLICT');
    expect(failure.message).toBe('Record rec_1 has moved on: expected version 1, current is 2.');
    expect(failure.details).toEqual({ recordId: 'rec_1' });
  });

  it('names the server and refuses to pretend when it cannot be reached', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND offcut.tech');
    };
    const memory = createRemoteMemory({ baseUrl: 'https://offcut.tech', apiKey: KEY, fetchImpl });

    const failure = await memory.add({ workspaceId: 'ws_1' }).catch((error) => error);

    expect(failure.code).toBe('UNREACHABLE');
    expect(failure.message).toContain('Could not reach https://offcut.tech');
    expect(failure.message).toContain('getaddrinfo ENOTFOUND offcut.tech');
    // The sentence that matters: nothing was written somewhere else instead.
    expect(failure.message).toContain('nothing was read or written locally');
  });

  it('refuses a body that is not JSON even when the status is 200', async () => {
    const { fetchImpl } = fakeServer({ status: 200, text: '<html>Sign in</html>' });
    const memory = createRemoteMemory({ baseUrl: 'https://offcut.tech', apiKey: KEY, fetchImpl });

    const failure = await memory.recall({ workspaceId: 'ws_1' }).catch((error) => error);

    expect(failure.code).toBe('UNREACHABLE');
    expect(failure.message).toContain('not JSON');
  });
});

describe('the startup check', () => {
  it('reads /api/health and reports the service it found', async () => {
    const { fetchImpl, calls } = fakeServer({ body: { service: 'offcut-agent-api', version: '3.1.0' } });

    await expect(pingServer('https://offcut.tech/', fetchImpl)).resolves.toEqual({
      service: 'offcut-agent-api',
      version: '3.1.0',
    });
    expect(calls[0].url).toBe('https://offcut.tech/api/health');
    expect(calls[0].method).toBe('GET');
    // No key on the health route: it is public, and sending the key to a
    // server that has not been identified yet is how keys end up in logs.
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it('refuses a server that answers /api/health with something else', async () => {
    const { fetchImpl } = fakeServer({ body: { hello: 'world' } });

    await expect(pingServer('https://example.com', fetchImpl)).rejects.toThrow(
      'not as an OFFCUT server would'
    );
  });
});

describe('the remote path never reaches for the database', () => {
  /**
   * A source check rather than a runtime one, and deliberately so: the failure
   * being guarded against happens at IMPORT time, so by the time a test could
   * observe it the file is already open. The rule is simple enough to read -
   * the files on the remote path may name @offcut/core in a type, never in a
   * value.
   */
  // vitest runs with the package root as the working directory.
  const srcDir = path.resolve(process.cwd(), 'src');

  for (const file of ['remote.ts', 'tools.ts', 'memory-surface.ts', 'mode.ts']) {
    it(`${file} imports @offcut/core only as a type, if at all`, () => {
      const source = fs.readFileSync(path.join(srcDir, file), 'utf8');
      const imports = source.match(/^import[^;]+from '@offcut\/core';/gm) ?? [];
      for (const statement of imports) {
        expect(statement.startsWith('import type')).toBe(true);
      }
    });
  }

  it('index.ts loads the core lazily, inside the local branch', () => {
    const source = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
    expect(source).not.toMatch(/^import \{[^}]*\} from '@offcut\/core';/m);
    expect(source).toContain("await import('@offcut/core')");
  });
});
