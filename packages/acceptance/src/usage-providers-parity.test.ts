/**
 * The MCP server's copy of the provider list, held to the core's.
 *
 * apps/mcp-server used to name SUPPORTED_USAGE_PROVIDERS by importing it, and
 * that import was a runtime one: reaching into @offcut/core loads the generated
 * Prisma client, which is the database the remote mode (OFFCUT_API_URL) exists
 * to never open. So the list is written out in apps/mcp-server/src/
 * usage-providers.ts and the copy is checked here rather than trusted.
 *
 * It lives in this package because this is where the surfaces are compared -
 * the same reason spec-surface-inventory.test.ts reads the MCP server's source
 * from here.
 */

import { describe, expect, it } from 'vitest';
import { SUPPORTED_USAGE_PROVIDERS } from '@offcut/core';
import { USAGE_PROVIDERS } from '../../../apps/mcp-server/src/usage-providers';
import { TOOL_DEFINITIONS } from '../../../apps/mcp-server/src/tools';

describe('the usage providers the MCP surface offers', () => {
  it('are exactly the ones the core can confirm', () => {
    expect([...USAGE_PROVIDERS]).toEqual([...SUPPORTED_USAGE_PROVIDERS]);
  });

  it('are what the tool schema shows an agent', () => {
    const usageTool = TOOL_DEFINITIONS.find((tool) => tool.name === 'offcut_usage_report');
    const provider = (
      usageTool?.inputSchema.properties.reports as {
        items?: { properties?: { provider?: { enum?: string[] } } };
      }
    )?.items?.properties?.provider;

    expect(provider?.enum).toEqual([...SUPPORTED_USAGE_PROVIDERS]);
  });
});
