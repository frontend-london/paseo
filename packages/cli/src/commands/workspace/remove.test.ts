import { describe, expect, it } from "vitest";
import { createWorkspaceCommand } from "./index.js";

function catchError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

describe("workspace remove arguments", () => {
  function parseRemove(argv: string[]): unknown {
    const workspace = createWorkspaceCommand()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    workspace.commands.find((command) => command.name() === "remove")?.exitOverride();
    return catchError(() => workspace.parse(["remove", ...argv], { from: "user" }));
  }

  it("requires a workspace id argument", () => {
    expect(parseRemove([])).toMatchObject({ code: "commander.missingArgument" });
  });

  it("accepts a workspace id argument", () => {
    expect(parseRemove(["ws-1"])).toBeNull();
  });
});
