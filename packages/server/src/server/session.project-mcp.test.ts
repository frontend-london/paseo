import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { readPaseoConfig } from "../utils/worktree.js";

test("paseo.json mcpServers integration & env token replacement", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "project-mcp-test-"));
  try {
    const paseoConfig = {
      mcpServers: {
        testServer: {
          type: "stdio",
          command: "some-command",
          args: [],
          env: {
            SOME_TOKEN: "$TEST_ENV_TOKEN",
            PLAIN_VAL: "hello"
          }
        }
      }
    };
    writeFileSync(join(tempDir, "paseo.json"), JSON.stringify(paseoConfig, null, 2));

    process.env.TEST_ENV_TOKEN = "secret-token-123";

    const result = readPaseoConfig(tempDir);
    expect(result.ok).toBe(true);
    expect(result.config).toBeDefined();
    
    const mcp = (result.config as any).mcpServers;
    expect(mcp).toBeDefined();
    expect(mcp.testServer.env.SOME_TOKEN).toBe("$TEST_ENV_TOKEN");

    const projectMcpServers = JSON.parse(JSON.stringify(mcp));
    for (const server of Object.values(projectMcpServers)) {
      if (server && typeof server === "object" && (server as any).env && typeof (server as any).env === "object") {
        for (const [envKey, envVal] of Object.entries((server as any).env)) {
          if (typeof envVal === "string" && envVal.startsWith("$")) {
            const varName = envVal.slice(1);
            const resolvedVal = process.env[varName];
            if (resolvedVal) {
              (server as any).env[envKey] = resolvedVal;
            }
          }
        }
      }
    }

    expect(projectMcpServers.testServer.env.SOME_TOKEN).toBe("secret-token-123");
    expect(projectMcpServers.testServer.env.PLAIN_VAL).toBe("hello");

  } finally {
    delete process.env.TEST_ENV_TOKEN;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
