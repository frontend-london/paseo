export type McpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      alwaysLoad?: boolean;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
      alwaysLoad?: boolean;
    };

export type McpServersConfig = Record<string, McpServerConfig>;

/** Resolve Agents/Apify MCP config path from environment. */
export function resolveAgentsMcpConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw =
    env.AGENTS_MCP_CONFIG?.trim() ||
    env.APIFY_MCP_CONFIG?.trim() ||
    env.PASEO_MCP_CONFIG?.trim() ||
    "";
  return raw.length > 0 ? raw : undefined;
}

export function parseMcpServersConfig(parsed: unknown, sourceLabel: string): McpServersConfig {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`MCP config must be a JSON object: ${sourceLabel}`);
  }
  const out: McpServersConfig = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`MCP server '${name}' must be an object`);
    }
    const cfg = value as Record<string, unknown>;
    const type = cfg.type;
    if (type !== "stdio" && type !== "http" && type !== "sse") {
      throw new Error(`MCP server '${name}' has invalid type`);
    }
    out[name] = value as McpServerConfig;
  }
  return out;
}

export function mergeMcpServers(
  existing: McpServersConfig | undefined,
  incoming: McpServersConfig,
): McpServersConfig {
  return { ...(existing ?? {}), ...incoming };
}
