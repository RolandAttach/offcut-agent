/**
 * Dispatch, against a store that only records what it was asked.
 *
 * packages/acceptance already runs callTool against the real core; what it
 * cannot see is a tool that is advertised and never routed, because it only
 * calls the eight it knows about. offcut_usage_report was exactly that: listed
 * in TOOL_DEFINITIONS, missing from the switch, and answered "Unknown tool" by
 * the surface that had just offered it to the model.
 */

import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS, TOOL_NAMES, callTool } from '../tools';
import type { MemorySurface } from '../memory-surface';

function recordingStore(): { store: MemorySurface; seen: { method: string; args: unknown[] }[] } {
  const seen: { method: string; args: unknown[] }[] = [];

  const note =
    (method: string) =>
    async (...args: unknown[]): Promise<unknown> => {
      seen.push({ method, args });
      return { method };
    };

  const store = {
    add: note('add'),
    import: note('import'),
    merge: note('merge'),
    recall: note('recall'),
    inspect: note('inspect'),
    resolve: note('resolve'),
    forget: note('forget'),
    export: note('export'),
    reportUsage: note('reportUsage'),
  } as unknown as MemorySurface;

  return { store, seen };
}

describe('callTool routes every tool it advertises', () => {
  it('sends each memory tool to the method of the same name', async () => {
    const { store, seen } = recordingStore();

    for (const operation of [
      'add',
      'import',
      'merge',
      'recall',
      'inspect',
      'resolve',
      'forget',
      'export',
    ]) {
      await callTool(store, `offcut_memory_${operation}`, { workspaceId: 'ws_1' });
    }

    expect(seen.map((call) => call.method)).toEqual([
      'add',
      'import',
      'merge',
      'recall',
      'inspect',
      'resolve',
      'forget',
      'export',
    ]);
    // The arguments go across as one object, untouched: the schemas are the
    // core's, and a second copy of them here is how the surfaces drift apart.
    expect(seen[0].args).toEqual([{ workspaceId: 'ws_1' }]);
  });

  it('routes offcut_usage_report, splitting the workspace from the reports', async () => {
    const { store, seen } = recordingStore();

    await callTool(store, 'offcut_usage_report', {
      workspaceId: 'ws_1',
      reports: [{ generationId: 'gen-1' }],
    });

    expect(seen).toEqual([
      { method: 'reportUsage', args: ['ws_1', [{ generationId: 'gen-1' }]] },
    ]);
  });

  it('leaves no advertised tool unrouted', async () => {
    const { store } = recordingStore();

    for (const name of TOOL_NAMES) {
      // A tool that is listed and not dispatched throws "Unknown tool", which
      // is a promise broken by the same file that made it.
      await expect(callTool(store, name, { workspaceId: 'ws_1' })).resolves.toBeDefined();
    }

    expect(TOOL_NAMES).toHaveLength(TOOL_DEFINITIONS.length);
  });

  it('still refuses a name it never advertised', async () => {
    const { store } = recordingStore();
    await expect(callTool(store, 'offcut_memory_delete_everything', {})).rejects.toThrow(
      'Unknown tool'
    );
  });
});
