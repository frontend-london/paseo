import { readFileSync } from "node:fs";
import { parseMcpServersConfig, type McpServersConfig } from "../shared/mcp-config.ts";

export function loadMcpServersConfigFile(path: string): McpServersConfig {
  const source = readFileSync(path, "utf8");
  return parseMcpServersConfig(JSON.parse(source), path);
}
