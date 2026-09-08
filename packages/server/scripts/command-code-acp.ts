#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type ContentBlock,
} from "@agentclientprotocol/sdk";
import {
  CommandCodeRunner,
  type CommandCodeMode,
  type CommandCodeModel,
} from "../src/server/agent/providers/command-code-acp-bridge.js";

interface SessionState {
  cwd: string;
  mode: CommandCodeMode;
  model: string;
  models: CommandCodeModel[];
  nativeSessionId?: string;
  runner: CommandCodeRunner;
}

const cliPath = process.env["COMMAND_CODE_CLI_PATH"];
if (!cliPath) throw new Error("COMMAND_CODE_CLI_PATH must point to command-code dist/index.mjs");

const sessions = new Map<string, SessionState>();
let connection: AgentSideConnection;

const agent: Agent = {
  async initialize(params) {
    return {
      protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
      agentCapabilities: { promptCapabilities: {} },
      agentInfo: { name: "Command Code ACP bridge", version: "1" },
    };
  },

  async newSession(params) {
    if (params.mcpServers.length > 0) {
      throw new Error("Command Code ACP bridge does not support ACP MCP server injection");
    }
    const runner = new CommandCodeRunner();
    const models = await runner.listModels(cliPath);
    const defaultModel = models.find((model) => model.description.includes("(default)")) ?? models[0];
    if (!defaultModel) throw new Error("Command Code model catalog is empty");
    const sessionId = randomUUID();
    sessions.set(sessionId, {
      cwd: params.cwd,
      mode: "standard",
      model: defaultModel.id,
      models,
      runner,
    });
    return {
      sessionId,
      modes: {
        currentModeId: "standard",
        availableModes: [
          { id: "standard", name: "Standard", description: "Prompt before protected actions" },
          { id: "auto-accept", name: "Auto accept", description: "Automatically accept edits" },
          { id: "bypass", name: "Bypass", description: "Run unattended with --yolo" },
        ],
      },
      models: {
        currentModelId: defaultModel.id,
        availableModels: models.map((model) => ({
          modelId: model.id,
          name: model.id,
          description: model.description,
        })),
      },
    };
  },

  async setSessionMode(params) {
    const session = requireSession(params.sessionId);
    if (!isMode(params.modeId)) throw new Error(`Unsupported Command Code mode: ${params.modeId}`);
    session.mode = params.modeId;
  },

  async unstable_setSessionModel(params) {
    const session = requireSession(params.sessionId);
    if (!session.models.some((model) => model.id === params.modelId)) {
      throw new Error(`Model is not in the current Command Code catalog: ${params.modelId}`);
    }
    session.model = params.modelId;
  },

  async prompt(params) {
    const session = requireSession(params.sessionId);
    const prompt = promptText(params.prompt);
    const result = await session.runner.run(
      {
        cliPath,
        cwd: session.cwd,
        model: session.model,
        mode: session.mode,
        prompt,
        nativeSessionId: session.nativeSessionId,
      },
      async () => {},
    );
    session.nativeSessionId = result.nativeSessionId;
    if (result.finalText) {
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result.finalText },
        },
      });
    }
    return { stopReason: "end_turn", userMessageId: params.messageId };
  },

  async cancel(params) {
    requireSession(params.sessionId).runner.cancel();
  },

  async authenticate() {},
};

connection = new AgentSideConnection(
  () => agent,
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
await new Promise<void>((resolve) => connection.signal.addEventListener("abort", () => resolve()));

function requireSession(sessionId: string): SessionState {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown Command Code ACP session: ${sessionId}`);
  return session;
}

function isMode(value: string): value is CommandCodeMode {
  return value === "standard" || value === "auto-accept" || value === "bypass";
}

function promptText(content: ContentBlock[]): string {
  const parts = content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "resource_link") return block.uri;
    throw new Error(`Unsupported Command Code prompt content: ${block.type}`);
  });
  return parts.join("\n");
}
