/**
 * What a caller is told when its input is wrong.
 *
 * Written after the MCP connection check (scripts/check-mcp.mjs) reported a call
 * with missing required fields back to the model as:
 *
 *     { "error": { "code": "UNKNOWN", "message": "[{\"code\":\"invalid_type\"..." } }
 *
 * The operation had thrown a raw zod error, which is not an OffcutError, so the
 * MCP server fell through to its catch-all. To a model, UNKNOWN plus a dump of
 * zod internals reads as "this is broken, stop trying"; VALIDATION plus
 * "idempotencyKey: Required" reads as "fix the argument and call again". The
 * difference decides whether an agent recovers on its own.
 *
 * It was also a divergence between surfaces, which SS4 forbids: HTTP already
 * translated zod rejections in its exception filter and returned 400 VALIDATION,
 * while MCP and the SDK did not. Two surfaces, two answers, same input. So the
 * translation now lives in the core and every surface inherits it — which is
 * what these tests hold in place.
 */

import { describe, expect, it } from 'vitest';
import { asZodError, isOffcutError, OffcutError, parseInput } from '../errors';
import { addInputSchema } from '../types';
import { key, makeAgent, makeWorkspace } from './helpers';

// ---------------------------------------------------------------------------
describe('A rejected input is reported as VALIDATION on every surface', () => {
  it('turns a missing required field into an OffcutError, not a zod error', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Writer');

    // idempotencyKey is required; this is the exact call shape that produced
    // UNKNOWN over MCP.
    const failure = await agent.memory
      .add({ workspaceId: workspace.id, type: 'result', text: 'x', topic: 't' } as never)
      .then(
        () => null,
        (error: unknown) => error
      );

    expect(failure).not.toBeNull();
    expect(isOffcutError(failure)).toBe(true);
    expect((failure as OffcutError).code).toBe('VALIDATION');
    expect((failure as OffcutError).status).toBe(400);
  });

  it('names the offending field, so a model can act on the message', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Writer');

    const failure = (await agent.memory
      .add({ workspaceId: workspace.id, type: 'result', text: 'x', topic: 't' } as never)
      .catch((error: unknown) => error)) as OffcutError;

    // The whole point of translating rather than swallowing: the caller learns
    // WHICH argument was wrong.
    expect(failure.message).toContain('idempotencyKey');
    expect(failure.message).not.toContain('"code"'); // not a raw zod dump
    expect(Array.isArray((failure.details as { issues?: unknown[] }).issues)).toBe(true);
  });

  it('rejects an unknown record type the same way', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Writer');

    const failure = (await agent.memory
      .add({
        workspaceId: workspace.id,
        type: 'speculation',
        text: 'x',
        topic: 't',
        idempotencyKey: key(),
      } as never)
      .catch((error: unknown) => error)) as OffcutError;

    expect(isOffcutError(failure)).toBe(true);
    expect(failure.code).toBe('VALIDATION');
    expect(failure.message).toContain('type');
  });

  it('covers every operation, not just add', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Writer');

    // Each of the eight operations begins with a schema parse. One that still
    // used a raw `.parse()` would surface as UNKNOWN over MCP, so they are
    // checked together rather than trusted individually.
    const calls: Array<[string, Promise<unknown>]> = [
      ['recall', agent.memory.recall({} as never)],
      ['inspect', agent.memory.inspect({} as never)],
      ['merge', agent.memory.merge({} as never)],
      ['export', agent.memory.export({} as never)],
      ['forget', agent.memory.forget({} as never)],
      ['resolve', agent.memory.resolve({} as never)],
      ['import', agent.memory.import({} as never)],
    ];

    for (const [name, call] of calls) {
      const failure = await call.then(
        () => null,
        (error: unknown) => error
      );

      expect(failure, `${name} accepted empty input`).not.toBeNull();
      expect(isOffcutError(failure), `${name} threw a non-OffcutError`).toBe(true);
      expect((failure as OffcutError).code, `${name} used the wrong code`).toBe('VALIDATION');
    }
  });
});

// ---------------------------------------------------------------------------
describe('The translation itself', () => {
  it('recognises a zod error by shape rather than by class', () => {
    // Simulating the cross-copy case: an object that IS a zod error in every way
    // that matters, but is not an instance of the zod class imported here.
    const foreign = { name: 'ZodError', issues: [{ path: ['topic'], message: 'Required' }] };

    expect(asZodError(foreign)).not.toBeNull();
    expect(asZodError({ name: 'TypeError' })).toBeNull();
    expect(asZodError(null)).toBeNull();
    expect(asZodError('ZodError')).toBeNull();
  });

  it('recognises an OffcutError by shape rather than by class', () => {
    // Same hazard, other direction: two copies of @offcut/core would make
    // `instanceof OffcutError` false and turn a 403 into a 500.
    const foreign = { name: 'OffcutError', code: 'ACCESS_DENIED', status: 403 };

    expect(isOffcutError(foreign)).toBe(true);
    expect(isOffcutError(new OffcutError('VALIDATION', 'real one'))).toBe(true);
    expect(isOffcutError(new Error('not one'))).toBe(false);
    expect(isOffcutError({ name: 'OffcutError' })).toBe(false); // no code, no status
    expect(isOffcutError(null)).toBe(false);
  });

  it('passes a non-zod failure through untouched', () => {
    const boom = new Error('the disk is on fire');
    const schema = {
      parse() {
        throw boom;
      },
    };

    // A storage failure must not be relabelled as the caller's mistake.
    expect(() => parseInput(schema, {})).toThrow(boom);
  });

  it('returns the parsed value when the input is good', () => {
    const parsed = parseInput(addInputSchema, {
      workspaceId: 'ws_1',
      type: 'fact',
      text: 'hello',
      topic: 'topic',
      idempotencyKey: 'good-enough-key',
    });

    expect(parsed.type).toBe('fact');
    expect(parsed.topic).toBe('topic');
  });
});
