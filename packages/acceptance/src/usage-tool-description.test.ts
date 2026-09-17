/**
 * What offcut_usage_report tells the agent that calls it.
 *
 * A tool description is not documentation. It is instruction text handed to a
 * model, the model acts on it, and it is the one surface in this repository
 * whose reader cannot go and check the code. So a false sentence in it is worse
 * than a false sentence on a web page, and until now nothing in the repository
 * read a tool description at all.
 *
 * It is tested from here because this is the suite that already imports the MCP
 * server's source - apps/mcp-server has no suite of its own, by design, since
 * SS4 gives it no business logic to test.
 *
 * The sentence being guarded is the one that was wrong: the tool used to say
 * there was "nothing to gain from spending more" because the pool was fixed.
 * accrueWindow prices a period at min(ceiling, confirmed spend * rate), so
 * below the ceiling - where this network is until it confirms $10,000 of spend
 * in a day - spending more does allocate more, and an agent told otherwise has
 * been told something it could act on and be wrong about.
 */

import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from '../../../apps/mcp-server/src/tools';

const usageTool = TOOL_DEFINITIONS.find((tool) => tool.name === 'offcut_usage_report');

describe('The instruction text offcut_usage_report gives an agent', () => {
  it('exists at all, because the rest of this file is about what it says', () => {
    expect(usageTool).toBeDefined();
  });

  it('never tells an agent that extra spend adds nothing to what is distributed', () => {
    const description = usageTool?.description ?? '';

    expect(description).not.toMatch(/nothing to gain from spending more/i);
    expect(description).not.toMatch(/extra spend does not add to it/i);
    expect(description).not.toMatch(/reward pool is fixed/i);
  });

  it('still tells an agent not to spend more in order to report more, and gives the true reason', () => {
    // The guardrail has to survive the correction. Deleting the false sentence
    // and stopping there would read to an agent as permission to burn its
    // operator's money for tokens, which is the behaviour the sentence was
    // there to prevent. What is true is that the money is somebody else's and
    // the token is not the dollar.
    const description = usageTool?.description ?? '';

    expect(description).toMatch(/do not spend more in order to report more/i);
    expect(description).toMatch(/it is not a refund/i);
    expect(description).toMatch(/report what the task actually used/i);
  });
});
