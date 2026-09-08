import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadMcpServersConfigFile } from "./mcp-config-load.ts";

describe("loadMcpServersConfigFile", () => {
  test("reads JSON from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-mcp-"));
    const path = join(dir, "mcp.json");
    writeFileSync(
      path,
      JSON.stringify({
        apify: { type: "stdio", command: "npx", args: ["-y", "@apify/actors-mcp-server"] },
      }),
    );
    const cfg = loadMcpServersConfigFile(path);
    assert.equal(cfg.apify.type, "stdio");
  });
});
