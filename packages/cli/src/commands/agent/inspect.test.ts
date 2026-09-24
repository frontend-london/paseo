import { describe, expect, it, vi } from "vitest";
import { runInspectCommand } from "./inspect.js";

const mockSnapshot = {
  id: "agent-123",
  title: "Test Agent",
  provider: "codex",
  model: "gpt-4",
  status: "running",
  cwd: "/repo",
  createdAt: new Date().toISOString(),
  workspaceId: "ws-xyz",
  labels: { "env.name": "staging", "user.role": "admin" },
  sessionSettings: {},
};

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    fetchAgent: vi.fn(async () => ({ agent: mockSnapshot })),
    close: vi.fn(async () => undefined),
  })),
}));

describe("runInspectCommand structured output", () => {
  it("includes WorkspaceId in rows and schema serialized object", async () => {
    const result = await runInspectCommand("agent-123", {} as never, {} as never);
    expect(result.data).toContainEqual({ key: "WorkspaceId", value: "ws-xyz" });

    const serialized = result.schema.serialize?.(result.data[0]!) as Record<string, unknown>;
    expect(serialized?.WorkspaceId).toBe("ws-xyz");
    expect(serialized?.Labels).toEqual({ "env.name": "staging", "user.role": "admin" });
  });
});
