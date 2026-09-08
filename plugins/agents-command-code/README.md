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
