import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  mergeMcpServers,
  parseMcpServersConfig,
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

  test("parseMcpServersConfig accepts stdio/http entries", () => {
    const cfg = parseMcpServersConfig(
      {
        apify: { type: "stdio", command: "npx", args: ["-y", "@apify/actors-mcp-server"] },
        docs: { type: "http", url: "https://example.test/mcp" },
      },
      "inline",
    );
    assert.equal(cfg.apify.type, "stdio");
    assert.equal(cfg.docs.type, "http");
  });

  test("mergeMcpServers lets incoming override existing keys", () => {
    const merged = mergeMcpServers(
      {
        keep: { type: "http", url: "https://keep.test" },
        overlap: { type: "http", url: "https://old.test" },
      },
      {
        overlap: { type: "http", url: "https://new.test" },
        extra: { type: "sse", url: "https://extra.test" },
      },
    );
    assert.deepEqual(Object.keys(merged).sort(), ["extra", "keep", "overlap"]);
    assert.equal((merged.overlap as { url: string }).url, "https://new.test");
  });
});
