import { describe, expect, it, vi } from "vitest";
import { buildAgentLsFetchOptions, runLsCommand } from "./ls.js";

describe("buildAgentLsFetchOptions", () => {
  it("fetches active agents by default", () => {
    expect(buildAgentLsFetchOptions({})).toEqual({
      scope: "active",
    });
  });

  it("keeps label and thinking filters within the active scope", () => {
    expect(
      buildAgentLsFetchOptions({
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      scope: "active",
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });

  it("fetches global non-archived agents for -g", () => {
    expect(buildAgentLsFetchOptions({ global: true })).toEqual({});
  });

  it("keeps -a within the active scope", () => {
    expect(buildAgentLsFetchOptions({ all: true })).toEqual({
      scope: "active",
      filter: {
        includeArchived: true,
      },
    });
  });

  it("fetches all global agents for -a -g", () => {
    expect(buildAgentLsFetchOptions({ all: true, global: true })).toEqual({
      filter: {
        includeArchived: true,
      },
    });
  });

  it("applies filters to global queries", () => {
    expect(
      buildAgentLsFetchOptions({
        global: true,
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });
});

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    fetchAgents: vi.fn(async () => ({
      entries: [
        {
          agent: {
            id: "agent-123",
            title: "Test Agent",
            provider: "codex",
            model: "gpt-4",
            status: "running",
            cwd: "/repo",
            createdAt: new Date().toISOString(),
            workspaceId: "ws-abc",
            labels: { "test.label": "value1" },
          },
        },
      ],
    })),
    close: vi.fn(async () => undefined),
  })),
}));

describe("runLsCommand structured fields", () => {
  it("includes workspaceId and labels in list item results", async () => {
    const result = await runLsCommand({} as never, {} as never);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.workspaceId).toBe("ws-abc");
    expect(result.data[0]?.labels).toEqual({ "test.label": "value1" });
  });
});
