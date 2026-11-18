/**
 * Regression tests for supabase/mcp#318: cost confirmations must not be
 * forgeable (legacy path) or replayable (form/MRTR path).
 */
import { isInputRequiredResult } from '@modelcontextprotocol/client';
import type {
  CallToolResult,
  ClientCapabilities,
  InputRequiredResult,
} from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createOrganization,
  createProject,
  mockProjects,
} from '../test/mocks.js';
import { expectTerminalResult } from '../test/confirmation-results.js';
import { callModernTool, createServerHarness } from '../test/server-harness.js';
import { PROJECT_COST_MONTHLY } from './pricing.js';
import type { SupabaseMcpServerOptions } from './server.js';
import { hashObject } from './util.js';

const harness = createServerHarness();
beforeEach(() => harness.reset());
afterEach(() => harness.close());

const ELICITATION: NonNullable<SupabaseMcpServerOptions['elicitation']> = {
  requestState: { key: 'a'.repeat(32), principal: 'test-user' },
  confirmation: { enabledTools: ['create_project', 'create_branch'] },
};

const FORM_CAPABLE: ClientCapabilities = { elicitation: { form: {} } };

async function billableOrg() {
  const org = await createOrganization({
    name: 'Paid Org',
    plan: 'pro',
    allowed_release_channels: ['ga'],
  });
  const existing = await createProject({
    name: 'Existing Project',
    region: 'us-east-1',
    organization_id: org.id,
  });
  existing.status = 'ACTIVE_HEALTHY';
  return org;
}

const projectCost = {
  type: 'project',
  recurrence: 'monthly',
  amount: PROJECT_COST_MONTHLY,
} as const;

describe('legacy path: confirm_cost_id cannot be precomputed', () => {
  test('a self-computed hash of public pricing is rejected', async () => {
    const { callTool } = await harness.setup();
    const org = await billableOrg();

    // What an agent can do without ever calling confirm_cost: hash the
    // publicly known cost object itself.
    const forged = await hashObject(projectCost);

    await expect(
      callTool({
        name: 'create_project',
        arguments: {
          name: 'Forged',
          region: 'us-east-1',
          organization_id: org.id,
          confirm_cost_id: forged,
        },
      })
    ).rejects.toThrow(/does not match/);
    expect(mockProjects.size).toBe(1);
  });

  test('an ID from confirm_cost still works (no regression for legacy clients)', async () => {
    const { callTool } = await harness.setup();
    const org = await billableOrg();

    const { confirmation_id } = await callTool({
      name: 'confirm_cost',
      arguments: projectCost,
    });

    const result = await callTool({
      name: 'create_project',
      arguments: {
        name: 'Legit',
        region: 'us-east-1',
        organization_id: org.id,
        confirm_cost_id: confirmation_id,
      },
    });
    expect(result).toMatchObject({ name: 'Legit' });
    expect(mockProjects.size).toBe(2);
  });

  test('an ID for a different cost is rejected', async () => {
    const { callTool } = await harness.setup();
    const org = await billableOrg();

    const { confirmation_id } = await callTool({
      name: 'confirm_cost',
      arguments: { type: 'project', recurrence: 'monthly', amount: 0 },
    });

    await expect(
      callTool({
        name: 'create_project',
        arguments: {
          name: 'Cheap quote',
          region: 'us-east-1',
          organization_id: org.id,
          confirm_cost_id: confirmation_id,
        },
      })
    ).rejects.toThrow(/does not match/);
    expect(mockProjects.size).toBe(1);
  });
});

describe('form path: an accepted confirmation is single-use', () => {
  async function confirmOnce() {
    const { client } = await harness.setupModern({
      clientCapabilities: FORM_CAPABLE,
      elicitation: ELICITATION,
    });
    const org = await billableOrg();
    const args = {
      name: 'New Project',
      region: 'us-east-1',
      organization_id: org.id,
    };

    const first = (await callModernTool(client, {
      name: 'create_project',
      arguments: args,
    })) as CallToolResult | InputRequiredResult;
    if (!isInputRequiredResult(first)) {
      throw new Error('expected input_required');
    }

    const accepted = {
      name: 'create_project',
      arguments: args,
      inputResponses: { confirm_cost: { action: 'accept', content: {} } },
      requestState: first.requestState,
    };
    const second = (await callModernTool(client, accepted)) as CallToolResult;
    return { client, accepted, second };
  }

  test('replaying the same accepted state does not create a second project', async () => {
    const { client, accepted, second } = await confirmOnce();
    expect(second.isError).toBeFalsy();
    expect(mockProjects.size).toBe(2);

    const replay = (await callModernTool(client, accepted)) as
      | CallToolResult
      | InputRequiredResult;
    if (isInputRequiredResult(replay)) {
      throw new Error('expected a terminal result');
    }
    expectTerminalResult(
      replay,
      'error',
      'This confirmation was already used. Call `create_project` again to get a new confirmation.'
    );
    expect(mockProjects.size).toBe(2);
  });

  test('concurrent replays create exactly one project', async () => {
    const { client } = await harness.setupModern({
      clientCapabilities: FORM_CAPABLE,
      elicitation: ELICITATION,
    });
    const org = await billableOrg();
    const args = {
      name: 'Race',
      region: 'us-east-1',
      organization_id: org.id,
    };
    const first = (await callModernTool(client, {
      name: 'create_project',
      arguments: args,
    })) as InputRequiredResult;

    const accepted = {
      name: 'create_project',
      arguments: args,
      inputResponses: { confirm_cost: { action: 'accept', content: {} } },
      requestState: first.requestState,
    };
    await Promise.all(
      Array.from({ length: 5 }, () => callModernTool(client, accepted))
    );
    expect(mockProjects.size).toBe(2);
  });
});
