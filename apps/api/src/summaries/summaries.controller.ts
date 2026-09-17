/**
 * The optional module of SS9 over HTTP.
 *
 * Two routes read or change a per-workspace permission, and one runs a summary.
 * As everywhere else, the rules live in @offcut/core — this layer only resolves
 * who is asking.
 *
 * Note what is NOT here: no route accepts a model API key, and none returns one.
 * The credential lives in the server's environment; the console can learn
 * whether one is configured and nothing more.
 */

import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { getModelSummarySettings, setModelSummaries, summarize, type Principal } from '@offcut/core';
import { z } from 'zod';
import { CurrentPrincipal } from '../auth/principal.guard';
import { RateLimit } from '../common/rate-limit.guard';

const settingsSchema = z.object({
  enabled: z.boolean(),
  // A provider slug such as "anthropic/claude-haiku-4.5". Passed through
  // verbatim; the provider is the authority on what exists.
  model: z.string().trim().min(1).max(120).optional(),
});

const summarizeSchema = z.object({
  topic: z.string().trim().max(200).optional(),
  scope: z.enum(['workspace', 'private']).optional(),
});

@Controller('workspaces/:id/model-summaries')
export class SummariesController {
  @Get()
  async settings(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return { settings: await getModelSummarySettings(principal, id) };
  }

  @Patch()
  async update(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown
  ) {
    const input = settingsSchema.parse(body);
    const result = await setModelSummaries(principal, id, input);

    return {
      ...result,
      notice: input.enabled
        ? 'Record text from this workspace will now be sent to the configured provider when a summary is requested. Turn this off to stop that.'
        : 'No memory from this workspace will be sent to any external model.',
    };
  }

  /**
   * Tighter than an ordinary write: each call is an outbound request that costs
   * money and sends text off the machine.
   */
  @RateLimit({ limit: 12, windowMs: 60_000, label: 'summary requests' })
  @Post('run')
  async run(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown
  ) {
    const input = summarizeSchema.parse(body ?? {});
    return summarize(principal, { workspaceId: id, ...input });
  }
}
