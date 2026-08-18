import { describe, expect, test } from "vitest";
import { PASEO_DEFAULT_MODE, resolvePaseoModeDefault } from "./paseo-yolo-guard.js";

describe("Paseo YOLO-by-default guard", () => {
  test("returns yolo for missing mode when provider supports it", () => {
    expect(resolvePaseoModeDefault(undefined, ["yolo", "plan"])).toBe(PASEO_DEFAULT_MODE);
  });

  test("returns yolo for legacy default aliases when provider supports it", () => {
    for (const alias of ["", "default", "smart"]) {
      expect(resolvePaseoModeDefault(alias, ["yolo", "plan"])).toBe(PASEO_DEFAULT_MODE);
    }
  });

  test("preserves explicit concrete mode", () => {
    expect(resolvePaseoModeDefault("plan", ["yolo", "plan"])).toBe("plan");
    expect(resolvePaseoModeDefault("auto", ["yolo", "auto"])).toBe("auto");
  });

  test("passes through missing mode when provider does not support yolo", () => {
    expect(resolvePaseoModeDefault(undefined, ["plan", "bypassPermissions"])).toBeUndefined();
  });

  test("passes through legacy alias when provider does not support yolo", () => {
    expect(resolvePaseoModeDefault("default", ["plan", "bypassPermissions"])).toBe("default");
  });
});
