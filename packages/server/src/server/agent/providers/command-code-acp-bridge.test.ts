import { describe, expect, test } from "vitest";
import {
  buildCommandCodeArgs,
  parseCommandCodeModels,
  unwrapCommandCodeEvent,
} from "./command-code-acp-bridge.js";

describe("Command Code ACP bridge", () => {
  test("parses the dynamic model catalog without headings and examples", () => {
    expect(
      parseCommandCodeModels(`Available models  ·  2 models

OpenAI

gpt-5.6-sol                            frontier model
deepseek/deepseek-v4-flash             fast reasoning (default)

Docs: https://example.test`),
    ).toEqual([
      { id: "gpt-5.6-sol", description: "frontier model" },
      { id: "deepseek/deepseek-v4-flash", description: "fast reasoning (default)" },
    ]);
  });

  test.each([
    ["standard", []],
    ["auto-accept", ["--auto-accept"]],
    ["bypass", ["--yolo"]],
  ] as const)("maps %s to exact unattended CLI flags", (mode, expected) => {
    const args = buildCommandCodeArgs({ model: "gpt-5.6-sol", mode, prompt: "hello" });
    expect(args).toContain("--tools-all");
    expect(args).toContain("--skip-onboarding");
    expect(args).toContain("--no-auto-update");
    for (const flag of expected) expect(args).toContain(flag);
  });

  test("adds the native session id only on follow-up turns", () => {
    const args = buildCommandCodeArgs({
        model: "gpt-5.6-sol",
        mode: "bypass",
        prompt: "next",
        nativeSessionId: "native-1",
      });
    expect(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2)).toEqual([
      "--session",
      "native-1",
    ]);
  });

  test("unwraps NDJSON events used for model verification and persistence", () => {
    expect(
      unwrapCommandCodeEvent(
        JSON.stringify({ type: "event", event: { type: "model_request_start", model: "gpt-5.6-sol" } }),
      ),
    ).toEqual({ type: "model_request_start", model: "gpt-5.6-sol" });
    expect(unwrapCommandCodeEvent("not-json")).toBeNull();
  });
});
