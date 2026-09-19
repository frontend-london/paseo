import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectToDaemon } from "../../utils/client.js";
import {
  parseRunFeatures,
  resolveExistingRunWorkspace,
  resolveRunCallerAgentId,
  runRunCommand,
  type AgentRunOptions,
} from "./run";

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(),
  getDaemonHost: vi.fn(() => "http://localhost:6768"),
}));

describe("run feature parsing", () => {
  it("parses repeatable feature flags and preserves non-boolean values as strings", () => {
    expect(parseRunFeatures(["auto_accept=true", "fast_mode=false", "profile=careful"])).toEqual({
      auto_accept: true,
      fast_mode: false,
      profile: "careful",
    });
  });

  it("keeps featureValues absent when no features are provided", () => {
    expect(parseRunFeatures(undefined)).toBeUndefined();
    expect(parseRunFeatures([])).toBeUndefined();
  });

  it.each(["auto_accept", "=true"])("rejects malformed feature syntax: %s", (feature) => {
    expect(() => parseRunFeatures([feature])).toThrow();
    try {
      parseRunFeatures([feature]);
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_FEATURE",
        message: `Invalid feature format: ${feature}`,
      });
    }
  });
});

describe("run feature transport", () => {
  const originalAgentId = process.env.PASEO_AGENT_ID;

  afterEach(() => {
    vi.mocked(connectToDaemon).mockReset();
    if (originalAgentId === undefined) {
      delete process.env.PASEO_AGENT_ID;
    } else {
      process.env.PASEO_AGENT_ID = originalAgentId;
    }
  });

  it.each([
    { name: "with features", feature: ["auto_accept=true", "profile=careful"] },
    { name: "without features", feature: undefined },
  ])("creates the agent atomically $name", async ({ feature }) => {
    process.env.PASEO_AGENT_ID = "parent-agent";
    const createAgent = vi.fn().mockResolvedValue({
      id: "agent-1",
      status: "running",
      provider: "cursor",
      cwd: "/workspace",
      title: null,
    });
    const client = {
      createAgent,
      waitForFinish: vi.fn().mockResolvedValue({ status: "idle" }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(connectToDaemon).mockResolvedValue(client as never);

    await runRunCommand(
      "implement the task",
      { provider: "cursor", cwd: "/workspace", feature },
      {} as never,
    );

    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        initialPrompt: "implement the task",
        ...(feature
          ? { featureValues: { auto_accept: true, profile: "careful" } }
          : { featureValues: undefined }),
      }),
    );
  });

  it("passes features to the structured-output agent creation", async () => {
    process.env.PASEO_AGENT_ID = "parent-agent";
    const createAgent = vi.fn().mockResolvedValue({
      id: "agent-1",
      status: "running",
      provider: "cursor",
      cwd: "/workspace",
      title: null,
    });
    const client = {
      createAgent,
      waitForFinish: vi.fn().mockResolvedValue({
        status: "idle",
        lastMessage: '{"result":"done"}',
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(connectToDaemon).mockResolvedValue(client as never);

    await runRunCommand(
      "implement the task",
      {
        provider: "cursor",
        cwd: "/workspace",
        feature: ["auto_accept=true", "profile=careful"],
        outputSchema: '{"type":"object","properties":{"result":{"type":"string"}}}',
      },
      {} as never,
    );

    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureValues: { auto_accept: true, profile: "careful" },
        outputSchema: {
          type: "object",
          properties: { result: { type: "string" } },
        },
      }),
    );
  });
});

describe("managed agent caller context", () => {
  it("propagates a trimmed PASEO_AGENT_ID", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "  parent-agent  " })).toBe("parent-agent");
  });

  it("omits blank caller ids", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "   " })).toBeUndefined();
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });
});

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  async function expectInvalidOptions(options: AgentRunOptions, messageMatch: RegExp) {
    await expect(runRunCommand("do something", options, {} as never)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --new-workspace combined with --workspace", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", workspace: "ws-1" },
      /--new-workspace and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree workspace creation through validation", async () => {
    // Explicit workspace creation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand("do something", { newWorkspace: "worktree", provider: undefined }, {} as never),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown new workspace kinds", async () => {
    await expectInvalidOptions({ newWorkspace: "container" }, /Unsupported new workspace kind/);
  });

  it("rejects two workspace creation flags", async () => {
    await expectInvalidOptions(
      { newWorkspace: "local", worktree: "legacy-slug" },
      /--new-workspace and --worktree cannot be combined/,
    );
  });

  it("rejects an unknown worktree creation mode before connecting", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", worktreeMode: "container" },
      /Unsupported worktree mode/,
    );
  });
});
