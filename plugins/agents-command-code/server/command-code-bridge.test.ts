import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildCommandCodeArgs,
  parseCommandCodeModels,
  unwrapCommandCodeEvent,
} from "./command-code-bridge.ts";

describe("Command Code ACP bridge", () => {
  test("parses the dynamic model catalog without headings and examples", () => {
    const catalog = [
      "Available models  ·  2 models",
      "",
      "OpenAI",
      "",
      "gpt-5.6-sol                            frontier model",
      "deepseek/deepseek-v4-flash             fast reasoning (default)",
      "",
      "Docs: https://example.test",
    ].join("\n");
    assert.deepEqual(parseCommandCodeModels(catalog), [
      { id: "gpt-5.6-sol", description: "frontier model" },
      { id: "deepseek/deepseek-v4-flash", description: "fast reasoning (default)" },
    ]);
  });

  for (const [mode, expected] of [
    ["standard", []],
    ["auto-accept", ["--auto-accept"]],
    ["bypass", ["--yolo"]],
  ] as const) {
    test(`maps ${mode} to exact unattended CLI flags`, () => {
      const args = buildCommandCodeArgs({ model: "gpt-5.6-sol", mode, prompt: "hello" });
      assert.ok(args.includes("--tools-all"));
      assert.ok(args.includes("--skip-onboarding"));
      assert.ok(args.includes("--no-auto-update"));
      for (const flag of expected) assert.ok(args.includes(flag));
    });
  }

  test("adds the native session id only on follow-up turns", () => {
    const args = buildCommandCodeArgs({
      model: "gpt-5.6-sol",
      mode: "bypass",
      prompt: "next",
      nativeSessionId: "native-1",
    });
    assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), [
      "--session",
      "native-1",
    ]);
  });

  test("unwraps NDJSON events used for model verification and persistence", () => {
    assert.deepEqual(
      unwrapCommandCodeEvent(
        JSON.stringify({
          type: "event",
          event: { type: "model_request_start", model: "gpt-5.6-sol" },
        }),
      ),
      { type: "model_request_start", model: "gpt-5.6-sol" },
    );
    assert.equal(unwrapCommandCodeEvent("not-json"), null);
  });
});
