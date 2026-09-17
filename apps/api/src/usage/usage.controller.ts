/**
 * Linking the provider key, and reporting what was spent with it.
 *
 * The two halves of the reward chain, addressed to two different callers. The
 * credential belongs to an owner: SS2 puts granting access in their hands, and
 * this is a credential that can be spent. The reports belong to an agent: only
 * a connected subagent spends model tokens on a task, so only an agent may say
 * that it did. Both rules live in @offcut/core and are not restated here - this
 * file establishes who is asking and forwards, like every other controller.
 *
 * WHY THE KEY ARRIVES IN A BODY. PUT with a JSON body, never a query string and
 * never a path segment. A key in a URL is written to the access log of every
 * proxy between the browser and this process, and one in a path additionally
 * reaches the browser's history and the Referer header of the next request. A
 * body reaches none of those: the only logger in this app is the exception
 * filter, which prints a stack and never the request that produced it.
 *
 * Nothing here returns the key. GET answers whether one is linked and its last
 * four characters, which is the most the core lets out.
 */

import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import {
  Memory,
  clearUsageCredential,
  getUsageCredential,
  secretsConfigured,
  setUsageCredential,
  type Principal,
  type UsageReport,
} from '@offcut/core';
import { CurrentPrincipal } from '../auth/principal.guard';
import { RateLimit } from '../common/rate-limit.guard';

/**
 * That a string arrived, and nothing else about it.
 *
 * What an OpenRouter key looks like is decided in the core, which asks
 * OpenRouter rather than matching today's prefix. Checking it here would also
 * put it in reach of a zod issue: a failed `.regex()` or `.enum()` reports the
 * value it rejected, and the exception filter serialises those issues into the
 * response body.
 */
const credentialSchema = z.object({ apiKey: z.string() });

/**
 * The core refuses more than this in one call. The same number here refuses an
 * oversized batch as a 400 that names the field, before the array is walked.
 */
const MAX_REPORTS = 200;

/**
 * Shape only, on purpose. Which providers can be confirmed, what a usable
 * generation id is and what a negative token count becomes are all the core's
 * to decide, and it answers per report: one bad id in a batch of two hundred is
 * listed in `rejected` while the other 199 are accepted. Deciding any of it
 * again here would make HTTP stricter than the SDK over the same body, which is
 * the drift invariant 8 exists to prevent.
 */
const reportsSchema = z.object({
  reports: z
    .array(
      z.object({
        generationId: z.string(),
        provider: z.string().optional(),
        reportedTokens: z.number().optional(),
        reportedCostMicros: z.number().optional(),
        model: z.string().optional(),
      })
    )
    .max(MAX_REPORTS),
});

/**
 * Report budget. Every accepted row becomes one question the publisher later
 * asks OpenRouter, so this is really a budget on someone else's API: an agent
 * looping POSTs spends the verification run, not this process. Sized like the
 * bulk memory operations next door, which cost the same order of work.
 */
const REPORT_LIMIT = { limit: 30, windowMs: 60_000, label: 'usage reports' };

/**
 * Linking costs an outbound call to OpenRouter before anything is stored, so
 * the budget is a person's rather than a fleet's. Nobody links a key twenty
 * times a minute; a loop that did would make OpenRouter's rate limit this
 * server's problem.
 */
const LINK_LIMIT = { limit: 20, windowMs: 60_000, label: 'credential updates' };

@Controller('workspaces/:id/usage')
export class UsageController {
  @Get('credential')
  async credential(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return {
      credential: await getUsageCredential(principal, id),
      // Whether this server holds OFFCUT_SECRET_KEY at all. Without it a link
      // fails the moment somebody pastes a key, and the console would rather
      // say so on the screen before they go and fetch one.
      canStore: secretsConfigured(),
    };
  }

  /**
   * PUT, not POST: sending the same key twice has to mean the same as sending
   * it once, because the console retries this on a dropped connection.
   */
  @RateLimit(LINK_LIMIT)
  @Put('credential')
  async link(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown
  ) {
    const input = credentialSchema.parse(body);
    return {
      credential: await setUsageCredential(principal, id, input.apiKey),
      notice:
        'Rewards follow confirmed spend out of a fixed, pre-funded pool. Linking a key does not promise that spend comes back, and spending more does not add to the pool.',
    };
  }

  @Delete('credential')
  async unlink(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return {
      credential: await clearUsageCredential(principal, id),
      notice:
        'Spend already confirmed keeps its points. Reports still waiting stop being asked about until a key is linked again.',
    };
  }

  /**
   * The agent route.
   *
   * @CurrentPrincipal rather than @CurrentUser, which most console routes use:
   * the caller here is an agent key, and a route that demanded a session would
   * make the metric unreportable by the only participant that can report it.
   * The refusal of a human still happens - in reportUsage, once.
   */
  @RateLimit(REPORT_LIMIT)
  @Post()
  async report(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown
  ) {
    const input = reportsSchema.parse(body);

    // Through Memory, like every write on this surface. One path to the usage
    // table is what makes its unique key the single answer to "has this request
    // been counted", and calling reportUsage directly would mean authorize()
    // ran here - a permission decision this layer does not get to hold.
    //
    // The cast covers `provider`, which arrives as a string because the list of
    // supported ones is the core's to police, per report.
    return new Memory(principal).reportUsage(id, input.reports as UsageReport[]);
  }
}
