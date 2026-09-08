import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  loadMcpServersConfigFile,
  mergeMcpServers,
  resolveAgentsMcpConfigPath,
} from "./mcp-config.ts";

describe("Agents MCP config helpers", () => {
  test("resolveAgentsMcpConfigPath prefers AGENTS_MCP_CONFIG", () => {
    assert.equal(
      resolveAgentsMcpConfigPath({
        AGENTS_MCP_CONFIG: "/a.json",
        APIFY_MCP_CONFIG: "/b.json",
      }),
      "/a.json",
    );
    assert.equal(resolveAgentsMcpConfigPath({ APIFY_MCP_CONFIG: "/b.json" }), "/b.json");
    assert.equal(resolveAgentsMcpConfigPath({}), undefined);
  });

  test("loadMcpServersConfigFile parses stdio/http entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-mcp-"));
    const path = join(dir, "mcp.json");
    writeFileSync(
      path,
      JSON.stringify({
        apify: { type: "stdio", command: "npx", args: ["-y", "@apify/actors-mcp-server"] },
        docs: { type: "http", url: "https://example.test/mcp" },
      }),
    );
    const cfg = loadMcpServersConfigFile(path);
    assert.equal(cfg.apify.type, "stdio");
    assert.equal(cfg.docs.type, "http");
  });

  test("mergeMcpServers lets incoming override existing keys", () => {
    const merged = mergeMcpServers(
      { keep: { type: "http", url: "https://keep.test" }, overlap: { type: "http", url: "https://old.test" } },
      { overlap: { type: "http", url: "https://new.test" }, extra: { type: "sse", url: "https://extra.test" } },
    );
    assert.deepEqual(Object.keys(merged).sort(), ["extra", "keep", "overlap"]);
    assert.equal((merged.overlap as { url: string }).url, "https://new.test");
  });
});
