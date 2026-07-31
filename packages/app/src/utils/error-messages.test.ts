import { describe, expect, test } from "vitest";

import { toErrorMessage } from "./error-messages";

describe("toErrorMessage", () => {
  test("returns Error.message for Error instances", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
  });

  test("returns string errors as-is", () => {
    expect(toErrorMessage("plain string")).toBe("plain string");
  });

  test("extracts message from plain RPC objects instead of [object Object]", () => {
    expect(
      toErrorMessage({
        type: "Object",
        message: '"Method not found": session/set_mode',
        code: -32601,
        data: { method: "session/set_mode" },
      }),
    ).toBe('"Method not found": session/set_mode');
  });

  test("extracts nested error.message from plain objects", () => {
    expect(toErrorMessage({ error: { message: "nested failure" } })).toBe("nested failure");
  });

  test("falls back to String() for unknown values", () => {
    expect(toErrorMessage(42)).toBe("42");
    expect(toErrorMessage(null)).toBe("null");
  });
});
