# Agents Command Code plugin (Paseo 0.8)

Migrates `agents/command-code` core files into a Paseo 0.8 plugin using
`server.registerProvider(runAcpProvider(...))`.

## Requirements
- Paseo >= 0.8.0-beta.1
- `COMMAND_CODE_CLI_PATH` set in the daemon environment
- `tsx` available for the ACP agent script (dev) or compile to .mjs for prod

## Install
```bash
paseo plugin install /absolute/path/to/plugins/agents-command-code
paseo reload --json
```

## Apify / Agents MCP injection

Set one of:

- `AGENTS_MCP_CONFIG`
- `APIFY_MCP_CONFIG`
- `PASEO_MCP_CONFIG`

to a JSON file mapping MCP server names to configs (`stdio` / `http` / `sse`).
The plugin merges them into every `agent.create` via `server.before("agent.create")`.
No core CLI `--mcp-config` flag is required.
