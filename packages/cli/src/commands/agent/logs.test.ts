import { describe, expect, it, vi } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { runLogsCommand } from "./logs.js";

const timeline = [
  { type: "user_message", text: "one", messageId: "one" },
  { type: "assistant_message", text: "two", messageId: "two" },
] as AgentTimelineItem[];

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    fetchAgent: vi.fn(async () => ({ agent: { id: "agent-1" } })),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock("../../utils/timeline.js", () => ({
  fetchProjectedTimelineItems: vi.fn(async () => timeline),
  LIVE_HISTORY_FETCH_TIMEOUT_MS: 2_000,
}));

vi.mock("@getpaseo/server/agent-activity", () => ({
  curateAgentActivity: vi.fn(() => "TRANSCRIPT"),
}));

function command(globals: Record<string, unknown>) {
  return { optsWithGlobals: () => globals } as never;
}

describe("runLogsCommand structured output", () => {
  it.each([{ json: true }, { format: "json" }])(
    "emits raw timeline JSON for %j",
    async (globals) => {
      const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await runLogsCommand("agent-1", {}, command(globals));
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(timeline);
      output.mockRestore();
    },
  );

  it("honors --tail in structured output", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runLogsCommand("agent-1", { tail: "1" }, command({ json: true }));
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual([timeline[1]]);
    output.mockRestore();
  });

  it("emits an empty array for --tail 0", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runLogsCommand("agent-1", { tail: "0" }, command({ json: true }));
    expect(output).toHaveBeenCalledWith("[]");
    output.mockRestore();
  });
});
