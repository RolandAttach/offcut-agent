/**
 * Workspace and agent administration over HTTP.
 *
 * These are the owner powers of SS2: create a workspace, grant access, revoke
 * it. Every handler forwards to @offcut/core, which is where the "only an owner
 * may do this" checks actually live - repeating them here would create a second
 * source of truth about permissions.
 */

import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  createAgent,
  createWorkspace,
  deleteWorkspace,
  getWorkspaceStats,
  listAgents,
  listWorkspaces,
  revokeAgent,
  rotateAgentKey,
  updateAgentPermissions,
  updateWorkspace,
  type Principal,
} from '@offcut/core';
import { CurrentPrincipal, CurrentUser } from '../auth/principal.guard';

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  contextLimit: z.number().int().min(500).max(60000).optional(),
});

const updateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  contextLimit: z.number().int().min(500).max(60000).optional(),
});

const permissionsSchema = z.object({
  canRead: z.boolean().optional(),
  canWrite: z.boolean().optional(),
  canImport: z.boolean().optional(),
  canMerge: z.boolean().optional(),
  canResolve: z.boolean().optional(),
  canForget: z.boolean().optional(),
  canExport: z.boolean().optional(),
});

const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['lead', 'subagent']).optional(),
  description: z.string().trim().max(500).optional(),
  permissions: permissionsSchema.optional(),
});

@Controller('workspaces')
export class WorkspacesController {
  @Get()
  async list(@CurrentUser() user: { userId: string }) {
    return { workspaces: await listWorkspaces(user.userId) };
  }

  @Post()
  async create(@CurrentUser() user: { userId: string }, @Body() body: unknown) {
    const input = createWorkspaceSchema.parse(body);
    const workspace = await createWorkspace({ ownerId: user.userId, ...input });
    return {
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        description: workspace.description,
        contextLimit: workspace.contextLimit,
        createdAt: workspace.createdAt.toISOString(),
        counts: { agents: 0, records: 0, openConflicts: 0 },
      },
    };
  }

  @Get(':id/stats')
  async stats(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return { stats: await getWorkspaceStats(principal, id) };
  }

  @Patch(':id')
  async update(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown
  ) {
    const patch = updateWorkspaceSchema.parse(body);
    const workspace = await updateWorkspace(principal, id, patch);
    return {
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        description: workspace.description,
        contextLimit: workspace.contextLimit,
      },
    };
  }

  @Delete(':id')
  async remove(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    await deleteWorkspace(principal, id);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  @Get(':id/agents')
  async agents(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return { agents: await listAgents(principal, id) };
  }

  /**
   * Mints an agent key.
   *
   * The plaintext key appears in this response and nowhere else, ever - only its
   * hash is stored. The console must show it once and say so.
   */
  @Post(':id/agents')
  async addAgent(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown
  ) {
    const input = createAgentSchema.parse(body);
    const created = await createAgent(principal, id, input);
    return {
      agent: created.agent,
      apiKey: created.apiKey,
      notice: 'This key is shown once. Store it now - it cannot be retrieved later.',
    };
  }

  @Patch(':id/agents/:agentId')
  async setPermissions(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('agentId') agentId: string,
    @Body() body: unknown
  ) {
    const permissions = permissionsSchema.parse(body);
    await updateAgentPermissions(principal, id, agentId, permissions);
    return { ok: true };
  }

  @Post(':id/agents/:agentId/revoke')
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('agentId') agentId: string
  ) {
    await revokeAgent(principal, id, agentId);
    return {
      ok: true,
      notice:
        'Further operations by this agent are blocked. Context already delivered to another application cannot be recalled.',
    };
  }

  @Post(':id/agents/:agentId/rotate')
  async rotate(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('agentId') agentId: string
  ) {
    const result = await rotateAgentKey(principal, id, agentId);
    return {
      apiKey: result.apiKey,
      notice: 'The previous key stopped working. This one is shown once.',
    };
  }
}
