/**
 * SS3.1 - "Connection does not mean automatically reading every chat... Without
 * a write or import, OFFCUT does not know those records." And the decisions log
 * behind it: "explicit writes and imports only", against the alternative of
 * promising access to every chat after installation.
 *
 * The existing suite pins the honest half of import - a claimed author never
 * becomes the verified one. Nobody had asserted the negative the clause is
 * really about: that setting everything up and connecting produces an empty
 * memory, because connecting is not ingestion.
 *
 * This is the core half, run through the same path a client takes: create the
 * workspace, mint the keys, authenticate, and then look at what is there. The
 * MCP surface half - that no tool can be pointed at a file or a chat log - is
 * in packages/acceptance/src/spec-surface-inventory.test.ts, which is the suite
 * that imports the server's tool definitions.
 */

import { describe, expect, it } from 'vitest';
import { getPrisma } from '../db';
import { isOffcutError } from '../errors';
import { key, makeAgent, makeLead, makeWorkspace } from './helpers';

describe('SS3.1 - connecting is not access to anything', () => {
  it('leaves the workspace empty after every agent has connected', async () => {
    const workspace = await makeWorkspace();
    const lead = await makeLead(workspace, 'Lead', { canExport: true });
    await makeAgent(workspace, 'Researcher');
    await makeAgent(workspace, 'Developer');

    // Three verified connections, and not one record.
    const recalled = await lead.memory.recall({
      workspaceId: workspace.id,
      query: 'anything at all',
    });
    expect(recalled.items).toEqual([]);
    expect(recalled.consideredRecords).toBe(0);

    const inspected = await lead.memory.inspect({ workspaceId: workspace.id });
    expect(inspected.returned).toBe(0);

    const exported = await lead.memory.export({ workspaceId: workspace.id });
    expect(exported.counts.records).toBe(0);

    // Straight at the store, in case something wrote outside the caller's view.
    const rows = await getPrisma().memoryRecord.count({ where: { workspaceId: workspace.id } });
    expect(rows).toBe(0);
  });

  it('stays empty until a record is handed over on purpose', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeLead(workspace, 'Lead', { canImport: true });
    const db = getPrisma();

    // An import with nothing in it is not a scan of anything: it is rejected,
    // because the payload IS the import.
    const empty = await agent.memory
      .import({ workspaceId: workspace.id, records: [], idempotencyKey: key('import-empty') })
      .catch((error: unknown) => error);
    expect(isOffcutError(empty)).toBe(true);
    expect(await db.memoryRecord.count({ where: { workspaceId: workspace.id } })).toBe(0);

    // Merging an empty workspace produces nothing to merge, rather than going
    // looking for material.
    const merged = await agent.memory.merge({
      workspaceId: workspace.id,
      idempotencyKey: key('import-merge'),
    });
    expect(merged.blocks).toEqual([]);
    expect(await db.memoryRecord.count({ where: { workspaceId: workspace.id } })).toBe(0);

    // One explicit import, and exactly what was handed over is what is there.
    const imported = await agent.memory.import({
      workspaceId: workspace.id,
      records: [
        {
          type: 'fact',
          text: 'Handed over deliberately.',
          topic: 'migration',
          source: 'notes.json',
        },
      ],
      idempotencyKey: key('import-one'),
    });
    expect(imported.imported).toBe(1);

    const rows = await db.memoryRecord.findMany({ where: { workspaceId: workspace.id } });
    expect(rows.map((row) => row.text)).toEqual(['Handed over deliberately.']);
  });

  it('refuses the import to an agent that was not granted it', async () => {
    // Importing is a permission, not a side effect of being connected.
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Researcher');

    const denied = await agent.memory
      .import({
        workspaceId: workspace.id,
        records: [{ type: 'fact', text: 'Should not land.', topic: 'migration', source: 'file' }],
        idempotencyKey: key('import-denied'),
      })
      .catch((error: unknown) => error);

    expect(isOffcutError(denied)).toBe(true);
    const rows = await getPrisma().memoryRecord.count({ where: { workspaceId: workspace.id } });
    expect(rows).toBe(0);
  });
});
