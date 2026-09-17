/**
 * The eight memory operations over HTTP.
 *
 * Note what is absent: validation, permission checks, merge rules, budget logic.
 * Each handler constructs a Memory bound to the verified principal and calls the
 * matching method. SS4 says the MCP server carries "no separate business logic",
 * and the same discipline applies here - otherwise the console could drift away
 * from what agents experience, which invariant 8 forbids.
 *
 * Both credential kinds reach these routes. A console session and an agent key
 * hit identical code, so what an owner sees in the UI is what an agent gets.
 */

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Request } from 'express';
import { Memory, OffcutError, type EventCursor, type Principal } from '@offcut/core';
import { CurrentPrincipal } from '../auth/principal.guard';
import { RateLimit } from '../common/rate-limit.guard';

/** Every write needs an idempotency key; the console mints one per action. */
function withWorkspace(workspaceId: string, body: unknown): Record<string, unknown> {
  return { ...(body as Record<string, unknown>), workspaceId };
}

/**
 * Write budget. Sized for a busy agent fleet rather than a human clicking:
 * a subagent saving results in a tight loop is normal traffic here.
 */
const WRITE_LIMIT = { limit: 240, windowMs: 60_000, label: 'writes' };

/** Merge and import touch many rows at once, so they get their own tighter budget. */
const HEAVY_LIMIT = { limit: 30, windowMs: 60_000, label: 'bulk operations' };

/**
 * One console tab holds one stream open, so this budget is really about
 * reconnects: a client whose stream dies and is reopened in a loop is a poll
 * loop wearing a different hat, and every connection behind it costs a query a
 * second for as long as it lives.
 */
const STREAM_LIMIT = { limit: 30, windowMs: 60_000, label: 'stream connections' };

/**
 * The most trail entries one poll will carry.
 *
 * An import or a large merge appends thousands of entries between two ticks.
 * Serialising all of them into one tick would hold the socket for as long as
 * that takes, so a poll takes a page and comes straight back for the rest.
 */
const POLL_PAGE = 200;

/**
 * Poll and heartbeat periods, in one object rather than two constants.
 *
 * Mutable because the suite turns the heartbeat down: proving that a keep-alive
 * comment is really written should not cost fifteen seconds of wall clock, and
 * a heartbeat no test has ever seen is a line of code rather than a behaviour.
 */
export const streamTiming = { pollMs: 1_000, heartbeatMs: 15_000 };

/**
 * Where a client that lost its connection asks to be put back.
 *
 * Starting every stream at the head is right for a first connection and wrong
 * for a reconnection: the console was disconnected for exactly as long as it
 * took to notice and come back, and everything appended in that gap would never
 * be sent. So a reconnecting client hands back the last cursor it saw and the
 * feed continues from there. Absent `after` there is nothing to resume, which
 * is what keeps the timeline snapshot and the feed meeting exactly once.
 *
 * `afterId` is carried through present-or-absent rather than defaulted: the
 * core reads it missing as "strictly later timestamps" and empty as "the rest
 * of that millisecond too", and flattening the two would drop an entry that
 * happens to share its millisecond with the cursor.
 */
function resumeFrom(after: string | undefined, afterId: string | undefined): EventCursor | undefined {
  if (after === undefined) return undefined;

  // Refused here rather than on the first poll: once the SSE headers are out
  // the status is 200, and a complaint inside a success is not a refusal.
  if (Number.isNaN(new Date(after).getTime())) {
    throw new OffcutError('VALIDATION', 'Event cursor "after" must be an ISO timestamp.', {
      details: { after },
    });
  }

  return afterId === undefined ? { after } : { after, afterId };
}

@Controller('workspaces/:id/memory')
export class MemoryController {
  private memory(principal: Principal): Memory {
    return new Memory(principal);
  }

  @RateLimit(WRITE_LIMIT)
  @Post('add')
  add(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.memory(principal).add(withWorkspace(id, body) as never);
  }

  @RateLimit(HEAVY_LIMIT)
  @Post('import')
  import(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.memory(principal).import(withWorkspace(id, body) as never);
  }

  @RateLimit(HEAVY_LIMIT)
  @Post('merge')
  merge(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.memory(principal).merge(withWorkspace(id, body ?? {}) as never);
  }

  @Post('recall')
  recall(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.memory(principal).recall(withWorkspace(id, body ?? {}) as never);
  }

  @Post('inspect')
  inspect(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.memory(principal).inspect(withWorkspace(id, body ?? {}) as never);
  }

  @RateLimit(WRITE_LIMIT)
  @Post('resolve')
  resolve(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.memory(principal).resolve(withWorkspace(id, body) as never);
  }

  @RateLimit(WRITE_LIMIT)
  @Post('forget')
  forget(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.memory(principal).forget(withWorkspace(id, body) as never);
  }

  @RateLimit(HEAVY_LIMIT)
  @Post('export')
  export(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.memory(principal).export(withWorkspace(id, body ?? {}) as never);
  }

  // -------------------------------------------------------------------------
  // Read views for the console. Same access rules, no new logic.
  // -------------------------------------------------------------------------

  @Get('records')
  async records(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query('topic') topic?: string,
    @Query('search') search?: string,
    @Query('includeDeleted') includeDeleted?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    // Query strings arrive as text; the core's schema rejects anything that is
    // not a positive integer, so a bad value fails loudly rather than silently
    // paging from zero.
    const parsedLimit = limit ? Number(limit) : 25;
    const parsedOffset = offset ? Number(offset) : 0;

    return this.memory(principal).inspect({
      workspaceId: id,
      ...(topic ? { topic } : {}),
      ...(search ? { search } : {}),
      includeDeleted: includeDeleted === 'true',
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 25,
      offset: Number.isFinite(parsedOffset) ? parsedOffset : 0,
    });
  }

  @Get('blocks')
  async blocks(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query('topic') topic?: string
  ) {
    return { blocks: await this.memory(principal).blocks(id, topic) };
  }

  @Get('conflicts')
  async conflicts(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return { conflicts: await this.memory(principal).conflicts(id) };
  }

  @Get('timeline')
  async timeline(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return { events: await this.memory(principal).timeline(id, 60) };
  }

  // -------------------------------------------------------------------------
  // The live feed
  // -------------------------------------------------------------------------

  /**
   * What the console watches while its agents work.
   *
   * There is no push out of the store to subscribe to: SS4 puts the first
   * release on one local process over SQLite, which has no listen/notify, so
   * the honest implementation is a poll. What makes a poll cheap enough to run
   * per open tab is the cursor - each tick asks only for what was appended
   * since the last one, which on an idle workspace is one indexed lookup a
   * second and no rows.
   *
   * Session only. An agent has no reason to watch a console; the core refuses
   * it either way, and doing the refusing here means it arrives as the same
   * JSON 403 every other route returns rather than as an open socket that
   * never says anything.
   */
  @RateLimit(STREAM_LIMIT)
  @Sse('events')
  async events(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Req() request: Request,
    @Query('after') after?: string,
    @Query('afterId') afterId?: string
  ): Promise<Observable<MessageEvent>> {
    const memory = this.memory(principal);

    // Before any stream exists, on purpose. Once the SSE headers are out the
    // status is already 200, and a refusal could only be a message inside a
    // success - which no client reads as a refusal.
    const head = await memory.eventsCursor(id);

    // After the authorization above, so a malformed cursor cannot tell a
    // stranger their guess at a workspace id was wrong.
    const start = resumeFrom(after, afterId) ?? head;

    return new Observable<MessageEvent>((subscriber) => {
      let cursor: EventCursor = start;
      let polling = false;
      let stopped = false;

      // Where the trail stands, first thing. The console already has its list
      // from the timeline; this names the exact point that list ends, so what
      // follows neither repeats it nor steps over it.
      subscriber.next({ type: 'ready', data: { cursor } });

      const poll = async (): Promise<void> => {
        // A query slower than the interval must not stack another behind it.
        // Nothing else guards re-entry here on purpose: closing the stream stops
        // it by clearing the ticker, so a leaked interval shows up as reads that
        // keep arriving rather than as a timer nobody can see.
        if (polling) return;
        polling = true;

        try {
          for (;;) {
            const page = await memory.eventsSince(id, cursor, POLL_PAGE);
            if (stopped) return;

            cursor = page.cursor;
            for (const event of page.events) subscriber.next({ type: 'event', data: event });

            // A full page means more is waiting behind it. Waiting out the
            // interval would drip a burst - an import, a merge - at a page a
            // second, so the next page is fetched immediately instead.
            if (page.events.length < POLL_PAGE) return;
          }
        } catch (error) {
          subscriber.error(error);
        } finally {
          polling = false;
        }
      };

      const ticker = setInterval(() => void poll(), streamTiming.pollMs);

      // A comment rather than a message: proxies and load balancers close
      // connections that have been silent, and an EventSource ignores comment
      // lines. It goes straight to the socket because an SSE comment has no
      // MessageEvent shape to travel in.
      const heartbeat = setInterval(() => {
        const response = request.res;
        if (response && !response.writableEnded) response.write(': heartbeat\n\n');
      }, streamTiming.heartbeatMs);

      const stop = (): void => {
        stopped = true;
        clearInterval(ticker);
        clearInterval(heartbeat);
        request.off('close', stop);
      };

      // Closing the tab is how this stream normally ends, and the interval it
      // would otherwise leave behind queries the database for as long as the
      // server runs.
      request.on('close', stop);

      return stop;
    });
  }
}
