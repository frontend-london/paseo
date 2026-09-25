import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceCommand } from "./index.js";

const daemon = vi.hoisted(() => ({
  removeWorkspace: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => daemon),
  getDaemonHost: vi.fn(() => "mock-daemon:6767"),
}));

async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

describe("workspace remove arguments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function parseRemove(argv: string[]): Promise<unknown> {
    const workspace = createWorkspaceCommand()
      .exitOverride()
      .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    workspace.commands.find((command) => command.name() === "remove")?.exitOverride();
    return catchError(() => workspace.parseAsync(["remove", ...argv], { from: "user" }));
  }

  it("requires a workspace id argument", async () => {
    await expect(parseRemove([])).resolves.toMatchObject({ code: "commander.missingArgument" });
    expect(daemon.removeWorkspace).not.toHaveBeenCalled();
  });

  it("accepts a workspace id argument", async () => {
    await expect(parseRemove(["ws-1"])).resolves.toBeNull();
    expect(daemon.removeWorkspace).toHaveBeenCalledWith("ws-1");
    expect(daemon.close).toHaveBeenCalledOnce();
  });
});
