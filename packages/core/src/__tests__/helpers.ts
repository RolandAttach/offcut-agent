/**
 * Fixtures for the invariant and acceptance suites.
 *
 * Scenarios are built the way a real integration is: an owner creates a
 * workspace, mints agent keys, and each agent authenticates through
 * authenticateAgent() exactly as a connected client would. No test constructs a
 * Principal by hand, because doing so would bypass the very identity check that
 * SS3.2 makes load-bearing.
 */

import { randomUUID } from 'node:crypto';
import { authenticateAgent } from '../access';
import { createAgent, createUser, createWorkspace } from '../admin';
import { Memory } from '../memory';
import type { Permissions, Principal } from '../types';

let counter = 0;

export interface OwnerFixture {
  userId: string;
  principal: Principal;
  memory: Memory;
}

export interface WorkspaceFixture {
  id: string;
  slug: string;
  owner: OwnerFixture;
}

export interface AgentFixture {
  id: string;
  name: string;
  apiKey: string;
  principal: Principal;
  memory: Memory;
}

export async function makeOwner(): Promise<OwnerFixture> {
  counter += 1;
  const user = await createUser({
    email: `owner${counter}-${Date.now()}@offcut.test`,
    password: 'correct-horse-battery',
    displayName: `Owner ${counter}`,
  });

  const principal: Principal = {
    kind: 'user',
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
  };

  return { userId: user.id, principal, memory: new Memory(principal) };
}

export async function makeWorkspace(owner?: OwnerFixture): Promise<WorkspaceFixture> {
  const resolvedOwner = owner ?? (await makeOwner());
  counter += 1;

  const workspace = await createWorkspace({
    ownerId: resolvedOwner.userId,
    name: `Workspace ${counter}`,
    description: 'Created by the test suite',
  });

  return { id: workspace.id, slug: workspace.slug, owner: resolvedOwner };
}

export async function makeAgent(
  workspace: WorkspaceFixture,
  name: string,
  permissions?: Partial<Permissions>
): Promise<AgentFixture> {
  const created = await createAgent(workspace.owner.principal, workspace.id, {
    name,
    kind: 'subagent',
    ...(permissions ? { permissions } : {}),
  });

  // Authenticate through the real path: the key IS the identity.
  const principal = await authenticateAgent(created.apiKey);

  return {
    id: created.agent.id,
    name: created.agent.name,
    apiKey: created.apiKey,
    principal,
    memory: new Memory(principal),
  };
}

export async function makeLead(
  workspace: WorkspaceFixture,
  name = 'Lead',
  permissions?: Partial<Permissions>
): Promise<AgentFixture> {
  const created = await createAgent(workspace.owner.principal, workspace.id, {
    name,
    kind: 'lead',
    ...(permissions ? { permissions } : {}),
  });

  const principal = await authenticateAgent(created.apiKey);

  return {
    id: created.agent.id,
    name: created.agent.name,
    apiKey: created.apiKey,
    principal,
    memory: new Memory(principal),
  };
}

/** Every write needs an idempotency key; tests that do not care get a fresh one. */
export function key(label = 'test'): string {
  return `${label}-${randomUUID()}`;
}

/**
 * The SS3.6 end-to-end scenario, reused by several tests.
 *
 *   R1 (researcher) the application must work offline
 *   D1 (developer)  project data is stored locally
 *   T1 (tester)     one saved record disappears after a restart
 */
export async function seedEndToEndScenario(workspace: WorkspaceFixture) {
  const researcher = await makeAgent(workspace, 'Researcher');
  const developer = await makeAgent(workspace, 'Developer');
  const tester = await makeAgent(workspace, 'Tester');

  const r1 = await researcher.memory.add({
    workspaceId: workspace.id,
    type: 'fact',
    text: 'The application must work offline.',
    topic: 'release-1',
    source: 'product brief, section 2',
    idempotencyKey: key('r1'),
  });

  const d1 = await developer.memory.add({
    workspaceId: workspace.id,
    type: 'decision',
    text: 'Project data is stored locally.',
    topic: 'release-1',
    source: 'architecture call 2026-09-02',
    factKey: 'storage.location',
    factValue: 'local',
    factContext: 'release-1',
    idempotencyKey: key('d1'),
  });

  const t1 = await tester.memory.add({
    workspaceId: workspace.id,
    type: 'result',
    text: 'One saved record disappears after a restart.',
    topic: 'release-1',
    source: 'regression run #148',
    idempotencyKey: key('t1'),
  });

  return { researcher, developer, tester, r1, d1, t1 };
}
