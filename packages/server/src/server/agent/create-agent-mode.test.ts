import { describe, expect, it } from "vitest";
import { resolveAndValidateCreateAgentMode } from "./create-agent-mode.js";

const CLAUDE_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];
const OPENCODE_MODES = ["build", "plan"];
const CODEX_MODES = ["auto", "full-access"];

function agentParent(provider: string, modeId: string | null, isUnattended = false) {
  return { provider, modeId, isUnattended };
}

describe("resolveAndValidateCreateAgentMode", () => {
  it("returns the requested mode when it is valid for the target provider", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "plan",
      targetProvider: "opencode",
      parent: null,
      unattended: false,
      availableModes: OPENCODE_MODES,
    });
    expect(resolved).toBe("plan");
  });

  it("throws when the requested mode is invalid for the target provider", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: "bypassPermissions",
        targetProvider: "opencode",
        parent: null,
        unattended: false,
        availableModes: OPENCODE_MODES,
      }),
    ).toThrow(
      "Invalid mode 'bypassPermissions' for provider 'opencode'. Available modes: build, plan",
    );
  });

  it("defaults top-level Claude to its unattended bypassPermissions mode", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "claude",
      parent: null,
      unattended: false,
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBe("bypassPermissions");
  });

  it("defaults top-level Codex to its unattended full-access mode", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "codex",
      parent: null,
      unattended: false,
      availableModes: CODEX_MODES,
    });
    expect(resolved).toBe("full-access");
  });

  it("rejects top-level providers with no unattended/no-prompts mode", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "opencode",
        parent: null,
        unattended: false,
        availableModes: OPENCODE_MODES,
      }),
    ).toThrow(
      "Provider 'opencode' has no unattended/no-prompts mode and cannot be started without an explicit mode. Available modes: build, plan",
    );
  });

  it("allows providers with no mode concept to use their own default", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "pi",
      parent: null,
      unattended: false,
      availableModes: [],
      targetUnattendedMode: undefined,
    });
    expect(resolved).toBeUndefined();
  });

  it("respects an explicit non-unattended mode over the default", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "plan",
      targetProvider: "claude",
      parent: null,
      unattended: false,
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBe("plan");
  });

  it("inherits the caller mode when caller and target share a provider", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "claude",
      parent: agentParent("claude", "bypassPermissions"),
      unattended: false,
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBe("bypassPermissions");
  });

  it("inherits target's unattended mode when caller is unattended cross-provider", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "codex",
      parent: agentParent("claude", "bypassPermissions", true),
      unattended: false,
      availableModes: CODEX_MODES,
      targetUnattendedMode: "full-access",
    });
    expect(resolved).toBe("full-access");
  });

  it("defaults to target's unattended mode when unattended and no parent", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "codex",
      parent: null,
      unattended: true,
      availableModes: CODEX_MODES,
      targetUnattendedMode: "full-access",
    });
    expect(resolved).toBe("full-access");
  });

  it("still refuses cross-provider inheritance when caller is not unattended", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "codex",
        parent: agentParent("claude", "default"),
        unattended: false,
        availableModes: CODEX_MODES,
        targetUnattendedMode: "full-access",
      }),
    ).toThrow(
      "cannot inherit mode 'default' from caller (provider 'claude') for new agent (provider 'codex'). Pass an explicit mode. Available modes for 'codex': auto, full-access",
    );
  });

  it("still refuses cross-provider inheritance when target has no unattended mode", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "zai-custom",
        parent: agentParent("claude", "bypassPermissions", true),
        unattended: false,
        availableModes: undefined,
        targetUnattendedMode: undefined,
      }),
    ).toThrow(
      "cannot inherit mode 'bypassPermissions' from caller (provider 'claude') for new agent (provider 'zai-custom'). Pass an explicit mode. Available modes for 'zai-custom': unknown",
    );
  });

  it("explicit mode wins over unattended inheritance", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "auto",
      targetProvider: "codex",
      parent: agentParent("claude", "bypassPermissions", true),
      unattended: false,
      availableModes: CODEX_MODES,
      targetUnattendedMode: "full-access",
    });
    expect(resolved).toBe("auto");
  });

  it("passes through an explicit mode when the target provider's modes are unknown", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "default",
      targetProvider: "zai-custom",
      parent: null,
      unattended: false,
      availableModes: undefined,
    });
    expect(resolved).toBe("default");
  });

  it("uses the provider default when the cross-provider target has no modes", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "pi",
      parent: agentParent("codex", "auto"),
      unattended: false,
      availableModes: [],
      targetUnattendedMode: undefined,
    });
    expect(resolved).toBeUndefined();
  });

  it("uses the provider default when an unattended parent targets a provider with no modes", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "pi",
      parent: agentParent("claude", "bypassPermissions", true),
      unattended: false,
      availableModes: [],
      targetUnattendedMode: undefined,
    });
    expect(resolved).toBeUndefined();
  });
});
