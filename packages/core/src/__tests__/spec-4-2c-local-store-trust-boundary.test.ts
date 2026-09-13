/**
 * SS4.2, the "Local storage" row: "SDK checks do not protect against a process
 * with direct database-file access; operating-system permissions are required."
 *
 * This is a statement about where OFFCUT's defence ENDS, and a test can pin
 * exactly that shape: the check holds on the path the SDK owns, and it is
 * absent - openly, by design - on the path it does not. Both halves matter. A
 * product that quietly added a tamper seal would be making a promise the threat
 * model does not make, and this file would go red and ask for the documentation
 * to be rewritten.
 *
 * What stands in for "a process with direct file access" is raw SQL against the
 * same store through $executeRaw: no access layer, no store.ts, none of our
 * code. What it CANNOT stand in for is a separate operating-system process, and
 * nothing here asserts anything about file permissions - that half of the
 * clause belongs to the operating system and stays outside the suite.
 */

import { describe, expect, it } from 'vitest';
import { getPrisma } from '../db';
import { isOffcutError } from '../errors';
import { key, makeAgent, makeWorkspace } from './helpers';

describe('SS4.2 - where the SDK protects the store, and where it stops', () => {
  it('holds the line on its own path: no reader reaches another agent private record', async () => {
    const workspace = await makeWorkspace();
    const author = await makeAgent(workspace, 'Author');
    const reader = await makeAgent(workspace, 'Reader', { canExport: true });
    const outsider = await makeAgent(await makeWorkspace(), 'Outsider');

    await author.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'Only the author may read this.',
      topic: 'notes',
      source: 'private working notes',
      scope: 'private',
      idempotencyKey: key('boundary-private'),
    });

    const recalled = await reader.memory.recall({ workspaceId: workspace.id, query: 'author' });
    expect(JSON.stringify(recalled)).not.toContain('Only the author may read this.');

    const exported = await reader.memory.export({ workspaceId: workspace.id });
    expect(exported.counts.records).toBe(0);

    const denied = await outsider.memory
      .recall({ workspaceId: workspace.id, query: 'author' })
      .catch((error: unknown) => error);
    expect(isOffcutError(denied)).toBe(true);
  });

  it('cannot stop a writer that goes straight at the database', async () => {
    const workspace = await makeWorkspace();
    const author = await makeAgent(workspace, 'Author');
    const reader = await makeAgent(workspace, 'Reader');

    const added = await author.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'Only the author may read this.',
      topic: 'notes',
      source: 'private working notes',
      scope: 'private',
      idempotencyKey: key('boundary-tamper'),
    });

    const db = getPrisma();

    // A process with write access to the file changes the audience and the text.
    // Neither change went through authorize(), createRecord() or any check we
    // wrote, because a file is not an API.
    await db.$executeRaw`UPDATE "memory_records" SET "scope" = 'workspace', "text" = 'Rewritten by something that had the file.' WHERE "recordId" = ${added.recordId}`;

    const recalled = await reader.memory.recall({ workspaceId: workspace.id, query: 'rewritten' });

    // The SDK serves what it finds. It has no way to know this row was not
    // written by the author, and SS4.2 says so rather than pretending otherwise.
    const texts = recalled.items.map((item) => item.text);
    expect(texts).toContain('Rewritten by something that had the file.');

    // And the record still presents the author as its author: the contentHash
    // is a merge key, not a seal, so nothing detects that the text moved.
    const item = recalled.items.find(
      (entry) => entry.text === 'Rewritten by something that had the file.'
    );
    expect(item!.refs[0]!.agentName).toBe('Author');
  });

  it('leaves no trace of that write in the audit trail', async () => {
    const workspace = await makeWorkspace();
    const author = await makeAgent(workspace, 'Author');

    const added = await author.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'Written through the SDK.',
      topic: 'notes',
      source: 'this test',
      idempotencyKey: key('boundary-audit'),
    });

    const db = getPrisma();
    const before = await db.auditEvent.count({ where: { workspaceId: workspace.id } });

    await db.$executeRaw`UPDATE "memory_records" SET "text" = 'Changed underneath.' WHERE "recordId" = ${added.recordId}`;

    const after = await db.auditEvent.count({ where: { workspaceId: workspace.id } });

    // Nothing was recorded, because nothing in OFFCUT was called. The timeline
    // is an account of what came through the SDK - not of what happened to the
    // file. That is the boundary, stated as an assertion.
    expect(after).toBe(before);

    const inspected = await author.memory.inspect({
      workspaceId: workspace.id,
      recordId: added.recordId,
    });
    expect(inspected.records[0]!.text).toBe('Changed underneath.');
    expect(inspected.records[0]!.version).toBe(1);
  });
});
