import { describe, expect, test } from "vitest";

import { getErrorMessage, getErrorMessageOr } from "./error-utils.js";

describe("getErrorMessage", () => {
  test("returns Error.message for Error instances", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  test("returns string errors as-is", () => {
    expect(getErrorMessage("plain string")).toBe("plain string");
  });

  test("extracts message from plain RPC objects instead of [object Object]", () => {
    expect(
      getErrorMessage({
        type: "Object",
        message: '"Method not found": session/set_mode',
        code: -32601,
        data: { method: "session/set_mode" },
      }),
    ).toBe('"Method not found": session/set_mode');
  });

  test("extracts nested error.message from plain objects", () => {
    expect(getErrorMessage({ error: { message: "nested failure" } })).toBe("nested failure");
  });

  test("falls back to String() for unknown values", () => {
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage(null)).toBe("null");
  });
});

describe("getErrorMessageOr", () => {
  test("uses fallback when message cannot be extracted", () => {
    expect(getErrorMessageOr({}, "fallback")).toBe("fallback");
    expect(getErrorMessageOr(null, "fallback")).toBe("fallback");
  });

  test("prefers plain-object message over fallback", () => {
    expect(getErrorMessageOr({ message: "rpc failed" }, "fallback")).toBe("rpc failed");
  });
});
