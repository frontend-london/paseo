import { describe, expect, it, vi } from "vitest";
import { assertAvailableOmniRouteModel, preflightOmniRouteModel } from "./model-preflight.js";

const models = [{ id: "omniroute/omni-opus-4.6-1m", aliases: ["antigravity-opus"] }];

describe("OmniRoute model preflight", () => {
  it("accepts a current model and its alias", () => {
    expect(() => assertAvailableOmniRouteModel("omniroute/omni-opus-4.6-1m", models)).not.toThrow();
    expect(() => assertAvailableOmniRouteModel("antigravity-opus", models)).not.toThrow();
  });

  it("blocks the removed 4.8 model before agent creation", () => {
    expect(() => assertAvailableOmniRouteModel("omniroute/omni-opus-4.8-1m", models)).toThrow(
      "Unknown OmniRoute model 'omniroute/omni-opus-4.8-1m'",
    );
  });

  it("consults the provider catalog before allowing explicit OpenCode models", async () => {
    const listModels = vi.fn(async () => [
      { provider: "opencode" as const, id: "omniroute/omni-opus-4.6-1m", label: "Opus 4.6" },
    ]);
    const snapshotManager = { listModels };
    await expect(
      preflightOmniRouteModel({
        provider: "opencode",
        model: "omniroute/omni-opus-4.8-1m",
        cwd: "/project",
        snapshotManager,
      }),
    ).rejects.toThrow("Unknown OmniRoute model");
    expect(listModels).toHaveBeenCalledWith({
      provider: "opencode",
      cwd: "/project",
      wait: true,
    });
  });

  it("does not query OmniRoute for other providers", async () => {
    const listModels = vi.fn(async () => []);
    await preflightOmniRouteModel({
      provider: "codex",
      model: "gpt-5.6-sol",
      snapshotManager: { listModels },
    });
    expect(listModels).not.toHaveBeenCalled();
  });

  it("fails closed on an empty catalog", () => {
    expect(() => assertAvailableOmniRouteModel("omniroute/omni-opus-4.6-1m", [])).toThrow(
      "Unknown OmniRoute model",
    );
  });
});
