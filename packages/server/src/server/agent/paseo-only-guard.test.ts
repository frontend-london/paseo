import { describe, expect, test } from "vitest";
import {
  assertPaseoOnlySession,
  PASEO_BACKEND,
  PASEO_ONLY_CATEGORIES,
  PaseoOnlyGuardError,
} from "./paseo-only-guard.js";

describe("Paseo-only session guard", () => {
  test("accepts Paseo backend for all session categories", () => {
    for (const category of PASEO_ONLY_CATEGORIES) {
      expect(() => assertPaseoOnlySession(PASEO_BACKEND, category)).not.toThrow();
    }
  });

  test("rejects non-Paseo backend for all session categories", () => {
    for (const category of PASEO_ONLY_CATEGORIES) {
      expect(() => assertPaseoOnlySession("tmux", category)).toThrow(PaseoOnlyGuardError);
      expect(() => assertPaseoOnlySession("other", category)).toThrow(
        expect.objectContaining({ category, backend: "other" }),
      );
    }
  });

  test("defaults missing backend to Paseo", () => {
    expect(() => assertPaseoOnlySession()).not.toThrow();
    expect(() => assertPaseoOnlySession(undefined, "mission")).not.toThrow();
  });

  test("error message identifies the rejected backend and category", () => {
    let message = "";
    try {
      assertPaseoOnlySession("tmux", "delivery");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain('backend must be "paseo"');
    expect(message).toContain("delivery");
    expect(message).toContain("tmux");
  });
});
