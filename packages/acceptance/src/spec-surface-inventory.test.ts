/**
 * The whole surface, listed and swept - for SS1.4 and for the second half of
 * SS3.1.
 *
 * SS4 gives the MCP server no business logic: it is the tool definitions plus a
 * dispatcher. That makes TOOL_DEFINITIONS the complete list of things an agent
 * can ask OFFCUT to do, and a complete list is the only honest way to assert
 * two negatives the specification makes:
 *
 *   SS1.4  "No trades, swaps, arbitrage, market monitoring, stock portfolios,
 *          or transaction signing." Until now the trading boundary was pinned
 *          in the site's words only - the page says the product does not trade.
 *          Here the product's own API says it, by not having anywhere to do it.
 *   SS3.1  "Connection does not mean automatically reading every chat." A tool
 *          that took a file path, a folder or a chat export would be exactly
 *          the automatic ingestion the decisions log rejected, so no tool takes
 *          one: the material an import loads is carried in the call.
 *
 * The inventory is asserted exactly rather than by pattern. A new tool makes
 * this file red on purpose - a tenth capability is a decision about what the
 * product is, and it should cost somebody a deliberate edit here.
 *
 * It lives in this suite because acceptance is the one that already imports the
 * MCP server's source; apps/mcp-server has no suite of its own.
 */

import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS, TOOL_NAMES } from '../../../apps/mcp-server/src/tools';

/** Name, description and every word of the input schema, as one string. */
function fullText(tool: (typeof TOOL_DEFINITIONS)[number]): string {
  return `${tool.name} ${tool.description} ${JSON.stringify(tool.inputSchema)}`;
}

describe('SS1.4 - the product has nowhere to trade anything', () => {
  it('offers exactly the memory tools of SS4.1, plus usage reporting, and nothing else', () => {
    expect([...TOOL_NAMES].sort()).toEqual([
      'offcut_memory_add',
      'offcut_memory_export',
      'offcut_memory_forget',
      'offcut_memory_import',
      'offcut_memory_inspect',
      'offcut_memory_merge',
      'offcut_memory_recall',
      'offcut_memory_resolve',
      'offcut_usage_report',
    ]);
  });

  it('names every tool for memory or for usage, never for a market', () => {
    for (const name of TOOL_NAMES) {
      expect(name).toMatch(/^offcut_(memory|usage)_/);
    }
  });

  it('carries no trading vocabulary in any name, description or parameter', () => {
    // "без торговли арбузами" as a grep. These are the words SS1.4 lists, plus
    // the ones a trading surface cannot be built without.
    const forbidden =
      /\b(swap|swaps|trade|trades|trading|arbitrage|portfolio|portfolios|apy|order\s?book|buy|sell|market|markets|ticker|slippage|liquidity|sign\s+a?\s*transaction)\b/i;

    const offenders = TOOL_DEFINITIONS.filter((tool) => forbidden.test(fullText(tool))).map(
      (tool) => tool.name
    );

    expect(offenders).toEqual([]);
  });

  it('asks for no wallet, key or chain anywhere in its parameters', () => {
    // SS5: "memory operations require no wallet, gas, or token purchase". A
    // parameter is where that promise would break first.
    const money = /\b(wallet|walletAddress|privateKey|signature|chainId|gas|contractAddress)\b/i;

    for (const tool of TOOL_DEFINITIONS) {
      const properties = Object.keys(tool.inputSchema.properties ?? {});
      expect(properties.filter((property) => money.test(property))).toEqual([]);
    }
  });
});

describe('SS3.1 - no tool can be pointed at something to ingest', () => {
  it('takes no path, file, folder, url or chat export as a parameter', () => {
    const ingestion = /\b(path|file|files|filename|folder|directory|dir|url|uri|glob|chat|chats|conversation|transcript|history|watch|sync|scan|crawl|import\s?from)\b/i;

    const offenders: string[] = [];
    for (const tool of TOOL_DEFINITIONS) {
      for (const property of Object.keys(tool.inputSchema.properties ?? {})) {
        if (ingestion.test(property)) offenders.push(`${tool.name}.${property}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('makes the import carry its own records, so nothing is fetched on its behalf', () => {
    const importTool = TOOL_DEFINITIONS.find((tool) => tool.name === 'offcut_memory_import');
    expect(importTool).toBeDefined();

    // records is required, and it is an array of literal record objects: the
    // payload IS the import, which is what "explicitly supplied JSON" means.
    expect(importTool!.inputSchema.required).toContain('records');
    const records = importTool!.inputSchema.properties.records as {
      type: string;
      items: { type: string; required: string[] };
    };
    expect(records.type).toBe('array');
    expect(records.items.type).toBe('object');
    expect(records.items.required).toEqual(['type', 'text', 'topic']);
  });

  it('tells the agent, in the description it reads, that connecting reads nothing', () => {
    // The sentence is instruction text a model acts on, so it is pinned as
    // text: an agent must not be left believing OFFCUT can see its history.
    const importTool = TOOL_DEFINITIONS.find((tool) => tool.name === 'offcut_memory_import');
    expect(importTool!.description).toContain(
      'connecting does not give OFFCUT access to your chat history'
    );
  });
});
