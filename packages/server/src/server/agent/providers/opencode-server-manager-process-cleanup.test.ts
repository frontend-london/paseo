import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { spawnProcess } from "../../../utils/spawn.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";
import { OpenCodeServerManager } from "./opencode/server-manager.js";

describe.runIf(process.platform !== "win32")("OpenCodeServerManager process-group cleanup", () => {
  test("daemon shutdown leaves no helper descendants that ignore SIGTERM", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-opencode-cleanup-"));
    const opencodeHomeDir = path.join(tempDir, "opencode-home");
    const parentPidPath = path.join(tempDir, "parent.pid");
    const childPidPath = path.join(tempDir, "child.pid");
    const fakeOpenCodePath = writeFakeOpenCode(tempDir);

    let manager: OpenCodeServerManager | undefined;
    let parentPid: number | undefined;
    let childPid: number | undefined;

    try {
      manager = new OpenCodeServerManager({
        logger: createTestLogger(),
        resolveHomeDir: () => opencodeHomeDir,
        resolveCommandPrefix: async () => ({
          command: process.execPath,
          args: [fakeOpenCodePath, parentPidPath, childPidPath],
        }),
        spawnServerProcess: spawnProcess,
        terminateProcess: terminateWithTreeKill,
      });

      await manager.acquireCurrent();

      parentPid = await waitForPid(parentPidPath);
      expect(parentPid).toBeGreaterThan(0);
      expect(isProcessRunning(parentPid)).toBe(true);

      childPid = await waitForPid(childPidPath);
      expect(childPid).toBeGreaterThan(0);
      expect(isProcessRunning(childPid)).toBe(true);

      await manager.shutdown();

      await waitForProcessExit(childPid);
      expect(isProcessRunning(childPid)).toBe(false);
    } finally {
      try {
        if (parentPid !== undefined) {
          // Kill any remaining processes in the helper's process group.
          try {
            process.kill(-parentPid, "SIGKILL");
          } catch {
            // Ignore if the process group is already gone.
          }
        }
        if (childPid !== undefined) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup races.
      }
    }
  }, 15_000);
});

function writeFakeOpenCode(tempDir: string): string {
  const script = `const { spawn } = require("node:child_process");
const fs = require("node:fs");

const parentPidPath = process.argv[2];
const childPidPath = process.argv[3];
const port = process.argv[process.argv.indexOf("--port") + 1];

fs.writeFileSync(parentPidPath, String(process.pid));

// Spawn a long-lived child that stays in the same process group and ignores SIGTERM.
spawn(process.execPath, [
  "-e",
  \`
    const fs = require("node:fs");
    process.on("SIGTERM", () => {});
    fs.writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  \`,
  childPidPath,
], { stdio: ["ignore", "ignore", "ignore"] });

process.on("SIGTERM", () => {
  process.exit(0);
});

console.log("listening on http://127.0.0.1:" + port);
setInterval(() => {}, 1000);
`;

  const scriptPath = path.join(tempDir, "fake-opencode.js");
  writeFileSync(scriptPath, script);
  return scriptPath;
}

async function waitForPid(pidPath: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(pidPath, "utf-8")).trim());
      if (pid > 0) return pid;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`PID file ${pidPath} was not written in time`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (isProcessRunning(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Process ${pid} did not exit in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
