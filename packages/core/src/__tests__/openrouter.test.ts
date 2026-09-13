/**
 * The supported integration: asking OpenRouter what a generation actually cost.
 *
 * Two things are being protected here, and they pull in opposite directions.
 *
 *   NOTHING IS PAID THAT WAS NOT CONFIRMED. A body we cannot read, a cost field
 *   that is not there — none of it settles at zero and none of it settles at a
 *   guess. It stays pending.
 *
 *   NOTHING CONFIRMED IS EVER LOST. A 500, a rate limit, a rotated key, an
 *   unreachable host: every one of those waits. Only OpenRouter saying "I have
 *   no such generation" rejects a report, because only that means it was never
 *   spent.
 *
 * Plus the arithmetic, which is the part that has to be exact rather than
 * merely close: cost becomes integer millionths of a dollar without a float
 * ever touching it.
 *
 * No test here reaches the network. fetch is stubbed in every one — including
 * the tests about a key that cannot be put in a header, which stay honest only
 * because that check is made against the runtime's Headers before fetch is
 * called at all. A stub cannot refuse a header the way a real request would, so
 * a version of this that left the check to fetch would pass while an owner was
 * told to wait out an OpenRouter outage that was not happening.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  openRouterUsageSource,
  openRouterVerifier,
  probeOpenRouterKey,
  usdToMicros,
} from '../providers/openrouter';
import { reportUsage, verifyPendingUsage } from '../usage';
import { setUsageCredential } from '../usage-credentials';
import { authorize } from '../access';
import { getPrisma } from '../db';
import { makeAgent, makeWorkspace, type AgentFixture, type WorkspaceFixture } from './helpers';

const KEY = 'sk-or-v1-aaaabbbbccccddddeeeeffff00001111';
const OTHER_KEY = 'sk-or-v1-99998888777766665555444433332222';

let originalSecretKey: string | undefined;

beforeEach(() => {
  originalSecretKey = process.env.OFFCUT_SECRET_KEY;
  process.env.OFFCUT_SECRET_KEY = crypto.randomBytes(32).toString('base64');

  // Nothing in this suite may reach OpenRouter. A call nobody stubbed fails
  // here rather than quietly spending somebody's credits during a test run.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('a test tried to reach the network');
    })
  );
});

afterEach(() => {
  if (originalSecretKey === undefined) delete process.env.OFFCUT_SECRET_KEY;
  else process.env.OFFCUT_SECRET_KEY = originalSecretKey;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// A stubbed OpenRouter
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  bearer: string;
}

function reply(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (body === undefined) throw new SyntaxError('Unexpected token < in JSON');
      return body;
    },
  } as unknown as Response;
}

/** Answers with `body` for any generation lookup, and accepts any key check. */
function stubOpenRouter(
  respond: (url: URL, bearer: string) => Response | Promise<Response>
): Call[] {
  const calls: Call[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: { headers: Record<string, string> }) => {
      const bearer = (init.headers.Authorization ?? '').replace(/^Bearer /, '');
      calls.push({ url: input, bearer });
      return respond(new URL(input), bearer);
    })
  );

  return calls;
}

/** The generation body OpenRouter returns, with only the fields we read. */
function generation(fields: Record<string, unknown>) {
  return { data: { id: 'gen-x', model: 'anthropic/claude-haiku-4.5', ...fields } };
}

function generationOnly(respond: (url: URL, bearer: string) => Response | Promise<Response>) {
  return stubOpenRouter((url, bearer) => {
    // A key check always succeeds, so a test about verification is not also a
    // test about linking.
    if (url.pathname.endsWith('/key')) return reply(200, { data: { label: 'test' } });
    return respond(url, bearer);
  });
}

async function contextFor(workspace: WorkspaceFixture, agent: AgentFixture) {
  return authorize(agent.principal, workspace.id, 'recall');
}

// ---------------------------------------------------------------------------
describe('Cost becomes integer millionths of a dollar, exactly', () => {
  it('converts a decimal price without a float rounding it', () => {
    // 0.029 * 1_000_000 is 28999.999999999996 in IEEE 754. Truncating that pays
    // 28999 micros for a 29000 micro request, every time, for everybody.
    expect(usdToMicros(0.029)).toBe(29_000);
    expect(usdToMicros(0.0015)).toBe(1500);
    expect(usdToMicros(0.07)).toBe(70_000);
    expect(usdToMicros(1.1)).toBe(1_100_000);
  });

  it('is always an integer', () => {
    for (const price of [0, 0.000001, 0.0015, 0.029, 1.1, 12.345678, 2147.483647]) {
      const micros = usdToMicros(price);
      expect(micros).not.toBeNull();
      expect(Number.isInteger(micros)).toBe(true);
    }
  });

  it('rounds half up below the smallest unit, and in one direction for everyone', () => {
    // A millionth of a dollar is where the unit ends. Below it the only thing
    // that matters is that nobody is rounded a different way from anybody else.
    expect(usdToMicros(1.0000005)).toBe(1_000_001);
    expect(usdToMicros(1.5e-6)).toBe(2);
    expect(usdToMicros(1e-7)).toBe(0);
    expect(usdToMicros(5e-7)).toBe(1);
  });

  it('reads a price sent as a string as well as a number', () => {
    expect(usdToMicros('0.0015')).toBe(1500);
    expect(usdToMicros(' 0.0015 ')).toBe(1500);
    expect(usdToMicros('1e-3')).toBe(1000);
  });

  it('refuses anything that is not a usable amount', () => {
    for (const bad of [undefined, null, '', 'free', {}, [], NaN, Infinity, -Infinity, -0.5, true]) {
      expect(usdToMicros(bad)).toBeNull();
    }
  });

  it('refuses a number too large to be one generation', () => {
    // $2,147.483647 is the largest value the column holds. Past it the field is
    // not an expensive request, it is a misread unit — and a misread unit must
    // be noticed, not stored.
    expect(usdToMicros(2147.483647)).toBe(2_147_483_647);
    expect(usdToMicros(2147.483648)).toBeNull();
    expect(usdToMicros('1e9')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('Only an unknown generation is a rejection', () => {
  it('returns null when OpenRouter has never heard of the id', async () => {
    generationOnly(() => reply(404, { error: { message: 'Not found' } }));

    expect(await openRouterVerifier(KEY).verify('gen-never-charged')).toBeNull();
  });

  it('throws on a 500, so the report waits instead of being destroyed', async () => {
    generationOnly(() => reply(500, { error: { message: 'internal' } }));

    await expect(openRouterVerifier(KEY).verify('gen-aaa111')).rejects.toThrow(/pending/i);
  });

  it('throws on a rate limit', async () => {
    generationOnly(() => reply(429));

    await expect(openRouterVerifier(KEY).verify('gen-aaa111')).rejects.toThrow(/pending/i);
  });

  it('throws on a rejected key, so a key rotation does not delete earnings', async () => {
    // The sharpest case for the rule. An owner who rotates their OpenRouter key
    // would otherwise wipe out every report still waiting, by doing something
    // they were right to do.
    generationOnly(() => reply(401, { error: { message: 'Invalid credentials' } }));

    await expect(openRouterVerifier(KEY).verify('gen-aaa111')).rejects.toThrow(/pending/i);
  });

  it('throws when OpenRouter cannot be reached at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED 104.18.0.1:443');
      })
    );

    await expect(openRouterVerifier(KEY).verify('gen-aaa111')).rejects.toThrow(/pending/i);
  });
});

// ---------------------------------------------------------------------------
describe('A body we cannot read defers rather than paying zero', () => {
  const unreadable: [string, unknown][] = [
    ['no data object', {}],
    ['a data object with no cost in it', generation({})],
    ['a cost that is not a number', generation({ total_cost: 'free' })],
    ['a null cost', generation({ total_cost: null })],
    ['a negative cost', generation({ total_cost: -0.5 })],
    ['data that is not an object', { data: 'nope' }],
  ];

  for (const [description, body] of unreadable) {
    it(`throws on ${description}`, async () => {
      generationOnly(() => reply(200, body));

      // Not null, which would reject the report; not zero, which would settle
      // it for nothing. Pending is the only recoverable answer.
      await expect(openRouterVerifier(KEY).verify('gen-aaa111')).rejects.toThrow(/pending/i);
    });
  }

  it('throws when the response is not JSON at all', async () => {
    generationOnly(() => reply(200));

    await expect(openRouterVerifier(KEY).verify('gen-aaa111')).rejects.toThrow(/pending/i);
  });

  it('still confirms a generation that genuinely cost nothing', async () => {
    // A free model is verified at zero, not deferred. The field was there and
    // it said zero; that is an answer, and the workspace earns nothing for it.
    generationOnly(() => reply(200, generation({ total_cost: 0, tokens_prompt: 10 })));

    const answer = await openRouterVerifier(KEY).verify('gen-free');
    expect(answer).toEqual({ generationId: 'gen-free', totalTokens: 10, costMicros: 0 });
  });
});

// ---------------------------------------------------------------------------
describe('The answer is read from the fields OpenRouter actually sends', () => {
  it('reads total_cost, and the provider token counts', async () => {
    generationOnly(() =>
      reply(
        200,
        generation({
          total_cost: 0.0015,
          usage: 0.0015,
          tokens_prompt: 10,
          tokens_completion: 25,
          native_tokens_prompt: 12,
          native_tokens_completion: 30,
        })
      )
    );

    expect(await openRouterVerifier(KEY).verify('gen-aaa111')).toEqual({
      generationId: 'gen-aaa111',
      totalTokens: 42,
      costMicros: 1500,
    });
  });

  it('falls back to the normalised token counts when native ones are absent', async () => {
    generationOnly(() =>
      reply(200, generation({ total_cost: 0.0015, tokens_prompt: 10, tokens_completion: 25 }))
    );

    const answer = await openRouterVerifier(KEY).verify('gen-aaa111');
    expect(answer?.totalTokens).toBe(35);
  });

  it('records zero tokens rather than refusing, because tokens are not the money', async () => {
    generationOnly(() => reply(200, generation({ total_cost: 0.0015 })));

    const answer = await openRouterVerifier(KEY).verify('gen-aaa111');
    expect(answer?.costMicros).toBe(1500);
    expect(answer?.totalTokens).toBe(0);
  });

  it('reads usage only when total_cost is missing', async () => {
    generationOnly(() => reply(200, generation({ usage: 0.002 })));

    const answer = await openRouterVerifier(KEY).verify('gen-aaa111');
    expect(answer?.costMicros).toBe(2000);
  });

  it('asks about the right generation, with the right key', async () => {
    const calls = generationOnly(() => reply(200, generation({ total_cost: 0.001 })));

    await openRouterVerifier(KEY).verify('gen-with spaces&=');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://openrouter.ai/api/v1/generation?id=gen-with%20spaces%26%3D'
    );
    expect(calls[0].bearer).toBe(KEY);
  });
});

// ---------------------------------------------------------------------------
describe('The key never leaves the closure it was given to', () => {
  it('is not a property of the verifier', () => {
    const verifier = openRouterVerifier(KEY);

    expect(JSON.stringify(verifier)).not.toContain(KEY);
    expect(JSON.stringify(Object.keys(verifier))).not.toContain(KEY);
    expect(Object.values(verifier).join(' ')).not.toContain(KEY);
  });

  it('is not in the error thrown when the provider fails', async () => {
    generationOnly(() => reply(500, { error: { message: `key was ${KEY}` } }));

    try {
      await openRouterVerifier(KEY).verify('gen-aaa111');
      throw new Error('expected a refusal');
    } catch (error) {
      // The serialised form, because that is what reaches a log: an error's
      // message, its stack, and anything a transport attaches to it.
      const serialised = JSON.stringify({
        message: (error as Error).message,
        stack: (error as Error).stack,
        whole: error,
      });
      expect(serialised).not.toContain(KEY);
      // Not even the fragment that would identify it.
      expect(serialised).not.toContain('0000');
    }
  });

  it('is not in the error thrown when the host is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // Some runtimes attach the whole request, headers included, to the
        // failure. Nothing from it may be rethrown.
        throw Object.assign(new Error('fetch failed'), {
          request: { headers: { Authorization: `Bearer ${KEY}` } },
        });
      })
    );

    try {
      await openRouterVerifier(KEY).verify('gen-aaa111');
      throw new Error('expected a refusal');
    } catch (error) {
      const serialised = JSON.stringify({
        message: (error as Error).message,
        stack: (error as Error).stack,
        whole: error,
      });
      expect(serialised).not.toContain(KEY);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Checking a key before it is stored', () => {
  it('accepts a key OpenRouter recognises', async () => {
    const calls = stubOpenRouter(() => reply(200, { data: { label: 'offcut' } }));

    expect(await probeOpenRouterKey(KEY)).toEqual({ ok: true });
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/key');
    expect(calls[0].bearer).toBe(KEY);
  });

  it('separates a key OpenRouter refuses from an OpenRouter that is down', async () => {
    // Telling an owner their working key is invalid because OpenRouter had a
    // bad minute is how somebody deletes a good credential.
    stubOpenRouter(() => reply(401));
    expect(await probeOpenRouterKey(KEY)).toEqual({ ok: false, reason: 'rejected' });

    stubOpenRouter(() => reply(503));
    expect(await probeOpenRouterKey(KEY)).toEqual({
      ok: false,
      reason: 'unreachable',
      status: 503,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ENOTFOUND');
      })
    );
    expect(await probeOpenRouterKey(KEY)).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('separates a key that cannot be sent at all from an OpenRouter that is down', async () => {
    // The copy-paste artefact, and the reason it gets its own answer. A key
    // pasted from a rendered page, a PDF or a word processor carries invisible
    // characters and curly punctuation, and OpenRouter keys are full of
    // hyphens for an en dash to replace. The runtime refuses to put any of
    // these in a header, so no request is made — which read as an outage tells
    // the owner to wait for a service that is working, while the workspace
    // links nothing and confirms nothing.
    const calls = stubOpenRouter(() => reply(200, { data: { label: 'offcut' } }));

    const pasted = [
      `sk-or-v1-aaaa​bbbbccccddddeeeeffff`, // zero-width space
      `sk-or-v1-aaaa–bbbbccccddddeeeeffff`, // en dash for a hyphen
      `sk-or-v1-aaaa’bbbbccccddddeeeeffff`, // curly apostrophe
      `sk-or-v1-aaaa\nbbbbccccddddeeeeffff`, // a line break from a wrapped page
    ];

    for (const key of pasted) {
      expect(await probeOpenRouterKey(key)).toEqual({ ok: false, reason: 'malformed' });
    }

    // Nothing went out for any of them. "Nothing was sent" is the whole of what
    // makes this different from an outage, so it is asserted rather than
    // assumed.
    expect(calls).toHaveLength(0);

    // And the keys that merely look odd are still OpenRouter's to judge: a tab,
    // surrounding space and a latin-1 letter all go in a header fine, and a key
    // this function pre-judged would be a good credential refused locally.
    expect(await probeOpenRouterKey(`sk-or-v1-aaaa\tbbbbccccddddeeeeffff`)).toEqual({ ok: true });
    expect(await probeOpenRouterKey(`  ${KEY}  `)).toEqual({ ok: true });
    expect(await probeOpenRouterKey(`sk-or-v1-aaaébbbbccccddddeeeeffff`)).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it('says nothing about a key it could not send, not even which character was wrong', async () => {
    // The runtime's own message quotes the header value it rejected, and the
    // header value is the key: `Headers.append: "Bearer sk-or-v1-…" is an
    // invalid header value`. Rethrowing it would put a live credential in a log.
    const key = `sk-or-v1-aaaabbbb​ccccddddeeeeffff`;

    const probe = await probeOpenRouterKey(key);

    expect(JSON.stringify(probe)).not.toContain(key);
    expect(JSON.stringify(probe)).not.toContain('sk-or-v1');
    expect(JSON.stringify(probe)).toBe('{"ok":false,"reason":"malformed"}');
  });

  it('leaves a report pending on a key it cannot send, and does not blame the network', async () => {
    // A key stored before it was ever checked this way still has to verify
    // against something. Pending is right — the spend is real and the owner can
    // still relink — but the reason has to name the key, or whoever reads it
    // goes looking for an outage that never happened.
    const verifier = openRouterVerifier(`sk-or-v1-aaaa–bbbbccccddddeeeeffff`);

    const message = await verifier.verify('gen-aaa111').then(
      () => 'it resolved, which it must not',
      (error: Error) => error.message
    );

    expect(message).toMatch(/cannot be sent in a request header/i);
    expect(message).not.toMatch(/could not be reached/i);
  });

  it('never returns anything about the key beyond whether it works', async () => {
    stubOpenRouter(() => reply(200, { data: { label: `sk-or-v1-...`, usage: 25.5, limit: 100 } }));

    const probe = await probeOpenRouterKey(KEY);
    expect(JSON.stringify(probe)).not.toContain(KEY);
    expect(JSON.stringify(probe)).toBe('{"ok":true}');
  });
});

// ---------------------------------------------------------------------------
// Settling pending reports, per workspace
// ---------------------------------------------------------------------------

async function workspaceWithKey(apiKey: string) {
  const workspace = await makeWorkspace();
  // Linking makes one key check. Each test replaces this stub afterwards with
  // the one it actually cares about.
  stubOpenRouter(() => reply(200, { data: { label: 'offcut' } }));
  await setUsageCredential(workspace.owner.principal, workspace.id, apiKey);
  return workspace;
}

async function reportOne(workspace: WorkspaceFixture, generationId: string) {
  const agent = await makeAgent(workspace, `Worker-${generationId}`);
  await reportUsage(getPrisma(), await contextFor(workspace, agent), [{ generationId }]);
}

async function statusOf(generationId: string) {
  const row = await getPrisma().modelUsage.findFirst({ where: { generationId } });
  return row ? { status: row.status, cost: row.verifiedCostMicros } : null;
}

describe('Each workspace is verified against its own key', () => {
  it('confirms two workspaces that each paid with a different key', async () => {
    // This is why verification is per workspace at all. OpenRouter answers
    // about a generation only to the key that paid for it, so one shared
    // verifier would confirm one workspace and reject every other.
    const first = await workspaceWithKey(KEY);
    const second = await workspaceWithKey(OTHER_KEY);

    await reportOne(first, 'gen-first-111');
    await reportOne(second, 'gen-second-22');

    generationOnly((url, bearer) => {
      const id = url.searchParams.get('id');
      const owns = bearer === KEY ? 'gen-first-111' : 'gen-second-22';
      if (id !== owns) return reply(404);
      return reply(200, generation({ total_cost: bearer === KEY ? 0.0015 : 0.002 }));
    });

    const run = await verifyPendingUsage(getPrisma(), openRouterUsageSource(getPrisma()));

    expect(run).toEqual({ verified: 2, rejected: 0, deferred: 0 });
    expect(await statusOf('gen-first-111')).toEqual({ status: 'verified', cost: 1500 });
    expect(await statusOf('gen-second-22')).toEqual({ status: 'verified', cost: 2000 });
  });

  it('would have rejected the second workspace under one shared verifier', async () => {
    // The bug the per-workspace source exists to prevent, demonstrated: real
    // spend rejected as unknown because it was asked about with the wrong key.
    const first = await workspaceWithKey(KEY);
    const second = await workspaceWithKey(OTHER_KEY);

    await reportOne(first, 'gen-first-111');
    await reportOne(second, 'gen-second-22');

    generationOnly((url) =>
      url.searchParams.get('id') === 'gen-first-111'
        ? reply(200, generation({ total_cost: 0.0015 }))
        : reply(404)
    );

    const run = await verifyPendingUsage(getPrisma(), openRouterVerifier(KEY));

    expect(run).toEqual({ verified: 1, rejected: 1, deferred: 0 });
    expect(await statusOf('gen-second-22')).toEqual({ status: 'rejected', cost: 0 });
  });

  it('leaves a workspace with no linked key pending, never rejected', async () => {
    // Its owner has not linked a key yet. There is nothing to ask with, and
    // "we did not ask" must never be recorded as "it was not spent".
    const workspace = await makeWorkspace();
    await reportOne(workspace, 'gen-nokey-111');

    generationOnly(() => reply(404));

    const run = await verifyPendingUsage(getPrisma(), openRouterUsageSource(getPrisma()));

    expect(run).toEqual({ verified: 0, rejected: 0, deferred: 0 });
    expect(await statusOf('gen-nokey-111')).toEqual({ status: 'pending', cost: 0 });
  });

  it('hands back an id parked by a workspace that has no key to answer with', async () => {
    // The whole path, with real credentials: a workspace that linked nothing
    // reports an id it never paid for. Nothing ever asks about that row — it is
    // not fetched at all — so it would hold the generation, and the unique key
    // on it, against the workspace whose key can actually confirm it.
    const squatter = await makeWorkspace();
    await reportOne(squatter, 'gen-squatted-1');

    const payer = await workspaceWithKey(KEY);
    await reportOne(payer, 'gen-squatted-1');

    generationOnly((url, bearer) =>
      bearer === KEY && url.searchParams.get('id') === 'gen-squatted-1'
        ? reply(200, generation({ total_cost: 0.0042 }))
        : reply(404)
    );

    const run = await verifyPendingUsage(getPrisma(), openRouterUsageSource(getPrisma()));

    expect(run).toEqual({ verified: 1, rejected: 0, deferred: 0 });
    expect(await statusOf('gen-squatted-1')).toEqual({ status: 'verified', cost: 4200 });

    const rows = await getPrisma().modelUsage.findMany({
      where: { generationId: 'gen-squatted-1' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(payer.id);
  });

  it('does not let unverifiable rows starve the workspaces that can be verified', async () => {
    // Rows nobody can ask about are the oldest in the table, and the batch is
    // ordered oldest first. Without the filter they would fill every run and
    // the workspace that did link a key would never be reached.
    const keyless = await makeWorkspace();
    for (const id of ['gen-old-aaa11', 'gen-old-bbb22', 'gen-old-ccc33']) {
      await reportOne(keyless, id);
    }

    const linked = await workspaceWithKey(KEY);
    await reportOne(linked, 'gen-new-ddd44');

    generationOnly(() => reply(200, generation({ total_cost: 0.001 })));

    const run = await verifyPendingUsage(getPrisma(), openRouterUsageSource(getPrisma()), {
      limit: 2,
    });

    expect(run.verified).toBe(1);
    expect(await statusOf('gen-new-ddd44')).toEqual({ status: 'verified', cost: 1000 });
    expect(await statusOf('gen-old-aaa11')).toEqual({ status: 'pending', cost: 0 });
  });

  it('defers a workspace whose credential cannot be decrypted', async () => {
    // The usual cause is a changed OFFCUT_SECRET_KEY. That is a server
    // misconfiguration, and a server misconfiguration must not reject spend.
    const workspace = await workspaceWithKey(KEY);
    await reportOne(workspace, 'gen-locked-11');

    process.env.OFFCUT_SECRET_KEY = crypto.randomBytes(32).toString('base64');

    generationOnly(() => reply(200, generation({ total_cost: 0.001 })));

    const run = await verifyPendingUsage(getPrisma(), openRouterUsageSource(getPrisma()));

    expect(run).toEqual({ verified: 0, rejected: 0, deferred: 1 });
    expect(await statusOf('gen-locked-11')).toEqual({ status: 'pending', cost: 0 });
  });

  it('decrypts a workspace key once however many rows it has', async () => {
    const workspace = await workspaceWithKey(KEY);
    for (const id of ['gen-many-aaa1', 'gen-many-bbb2', 'gen-many-ccc3']) {
      await reportOne(workspace, id);
    }

    const calls = generationOnly(() => reply(200, generation({ total_cost: 0.001 })));

    const source = openRouterUsageSource(getPrisma());
    const spy = vi.spyOn(source, 'forWorkspace');

    await verifyPendingUsage(getPrisma(), source);

    expect(spy).toHaveBeenCalledTimes(1);
    // One lookup, three questions.
    expect(calls.filter((call) => call.url.includes('/generation'))).toHaveLength(3);
  });

  it('settles a 404 as rejected and a 500 as still pending, through the whole path', async () => {
    const workspace = await workspaceWithKey(KEY);
    await reportOne(workspace, 'gen-gone-1111');
    await reportOne(workspace, 'gen-flaky-111');

    generationOnly((url) =>
      url.searchParams.get('id') === 'gen-gone-1111' ? reply(404) : reply(500)
    );

    const run = await verifyPendingUsage(getPrisma(), openRouterUsageSource(getPrisma()));

    expect(run).toEqual({ verified: 0, rejected: 1, deferred: 1 });
    expect(await statusOf('gen-gone-1111')).toEqual({ status: 'rejected', cost: 0 });
    expect(await statusOf('gen-flaky-111')).toEqual({ status: 'pending', cost: 0 });
  });
});

// ---------------------------------------------------------------------------
describe('Linking a corrected key reopens what the wrong one refused', () => {
  /**
   * The likeliest way to lose real money in this system, and it needs no
   * attacker. An owner links the wrong OpenRouter key — a second account, a
   * personal one where the team's belonged — and a day of genuine spend settles
   * as `rejected`, correctly, because that key truly does not know those
   * requests. Linking the right key afterwards used to fix nothing: a settled
   * row is never asked about again, so the spend stayed gone and no surface
   * anywhere said why.
   */
  it('confirms spend the previous key could not, once the right one is linked', async () => {
    const workspace = await workspaceWithKey(OTHER_KEY);
    await reportOne(workspace, 'gen-wrongkey-1');

    // The wrong key: OpenRouter does not know this generation.
    generationOnly(() => reply(404));
    await verifyPendingUsage(getPrisma(), openRouterUsageSource(getPrisma()));
    expect(await statusOf('gen-wrongkey-1')).toEqual({ status: 'rejected', cost: 0 });

    // The owner links the key that actually paid.
    stubOpenRouter(() => reply(200, { data: { label: 'offcut' } }));
    await setUsageCredential(workspace.owner.principal, workspace.id, KEY);

    generationOnly((url, bearer) =>
      bearer === KEY && url.searchParams.get('id') === 'gen-wrongkey-1'
        ? reply(200, generation({ total_cost: 0.0031 }))
        : reply(404)
    );

    const run = await verifyPendingUsage(getPrisma(), openRouterUsageSource(getPrisma()));

    expect(run.verified).toBe(1);
    expect(await statusOf('gen-wrongkey-1')).toEqual({ status: 'verified', cost: 3100 });
  });

  it('does not reopen anything already confirmed, so nothing is paid twice', async () => {
    // The direction that would cost money: re-linking must never put a settled,
    // paid row back in the queue.
    const workspace = await workspaceWithKey(KEY);
    await reportOne(workspace, 'gen-already-ok');

    generationOnly(() => reply(200, generation({ total_cost: 0.005 })));
    await verifyPendingUsage(getPrisma(), openRouterUsageSource(getPrisma()));
    expect(await statusOf('gen-already-ok')).toEqual({ status: 'verified', cost: 5000 });

    stubOpenRouter(() => reply(200, { data: { label: 'offcut' } }));
    await setUsageCredential(workspace.owner.principal, workspace.id, OTHER_KEY);

    // If it had been reopened, this would answer and overwrite the amount.
    generationOnly(() => reply(200, generation({ total_cost: 99 })));
    const run = await verifyPendingUsage(getPrisma(), openRouterUsageSource(getPrisma()));

    expect(run.verified).toBe(0);
    expect(await statusOf('gen-already-ok')).toEqual({ status: 'verified', cost: 5000 });
  });

  it('leaves the rejections of another workspace alone', async () => {
    const mine = await workspaceWithKey(KEY);
    const theirs = await workspaceWithKey(OTHER_KEY);
    await reportOne(theirs, 'gen-theirs-rej');

    generationOnly(() => reply(404));
    await verifyPendingUsage(getPrisma(), openRouterUsageSource(getPrisma()));
    expect(await statusOf('gen-theirs-rej')).toEqual({ status: 'rejected', cost: 0 });

    stubOpenRouter(() => reply(200, { data: { label: 'offcut' } }));
    await setUsageCredential(mine.owner.principal, mine.id, KEY);

    expect(await statusOf('gen-theirs-rej')).toEqual({ status: 'rejected', cost: 0 });
  });
});
