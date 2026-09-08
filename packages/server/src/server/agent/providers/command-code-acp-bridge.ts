import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type CommandCodeMode = "standard" | "auto-accept" | "bypass";

export interface CommandCodeModel {
  id: string;
  description: string;
}

export interface CommandCodeRunOptions {
  cliPath: string;
  cwd: string;
  model: string;
  mode: CommandCodeMode;
  prompt: string;
  nativeSessionId?: string;
}

export interface CommandCodeRunResult {
  actualModel: string;
  finalText: string;
  nativeSessionId: string;
}

export interface CommandCodeEvent {
  type: string;
  [key: string]: unknown;
}

export function parseCommandCodeModels(output: string): CommandCodeModel[] {
  const models: CommandCodeModel[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._:/-]*)\s{2,}(.+)$/);
    if (!match || match[1] === "Available") continue;
    models.push({ id: match[1], description: match[2].trim() });
  }
  return models;
}

export function buildCommandCodeArgs(options: Omit<CommandCodeRunOptions, "cliPath" | "cwd">): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--tools-all",
    "-t",
    "--skip-onboarding",
    "--no-auto-update",
    "-m",
    options.model,
  ];
  if (options.mode === "auto-accept") args.push("--auto-accept");
  if (options.mode === "bypass") args.push("--yolo");
  if (options.nativeSessionId) args.push("--session", options.nativeSessionId);
  args.push(options.prompt);
  return args;
}

export function unwrapCommandCodeEvent(line: string): CommandCodeEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const event = record.type === "event" ? record.event : record;
  if (!event || typeof event !== "object" || typeof (event as Record<string, unknown>).type !== "string") {
    return null;
  }
  return event as CommandCodeEvent;
}

export class CommandCodeRunner {
  private child: ChildProcessWithoutNullStreams | null = null;

  async listModels(cliPath: string): Promise<CommandCodeModel[]> {
    const output = await this.capture(cliPath, ["--list-models"]);
    const models = parseCommandCodeModels(output);
    if (models.length === 0) throw new Error("Command Code returned no parseable models");
    return models;
  }

  async run(
    options: CommandCodeRunOptions,
    onEvent: (event: CommandCodeEvent) => void | Promise<void>,
  ): Promise<CommandCodeRunResult> {
    if (this.child) throw new Error("Command Code session already has an active turn");
    const child = spawn(process.execPath, [options.cliPath, ...buildCommandCodeArgs(options)], {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const exitPromise = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    let stderr = "";
    let nativeSessionId: string | undefined;
    let actualModel: string | undefined;
    let finalText = "";
    let runError: string | undefined;
    let modelMismatch: string | undefined;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      const event = unwrapCommandCodeEvent(line);
      if (!event) continue;
      if (event.type === "run_start" && typeof event.sessionId === "string") nativeSessionId = event.sessionId;
      if (event.type === "model_request_start" && typeof event.model === "string") {
        actualModel = event.model;
        if (actualModel !== options.model) {
          modelMismatch = `Command Code model mismatch: requested ${options.model}, runtime selected ${actualModel}`;
          child.kill("SIGTERM");
        }
      }
      if (event.type === "run_error") runError = extractError(event.error);
      if (event.type === "run_end" && event.result && typeof event.result === "object") {
        const text = (event.result as Record<string, unknown>).finalText;
        if (typeof text === "string") finalText = text;
      }
      await onEvent(event);
    }
    const exitCode = await exitPromise;
    this.child = null;
    if (modelMismatch) throw new Error(modelMismatch);
    if (exitCode !== 0 || runError) {
      throw new Error(runError ?? (stderr.trim() || `Command Code exited with code ${exitCode}`));
    }
    if (!nativeSessionId) throw new Error("Command Code did not report run_start.sessionId");
    if (!actualModel) throw new Error("Command Code did not report model_request_start.model");
    return { actualModel, finalText, nativeSessionId };
  }

  cancel(): void {
    this.child?.kill("SIGTERM");
  }

  private capture(cliPath: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], { env: process.env });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `Command Code exited with code ${code}`));
      });
    });
  }
}

function extractError(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as Record<string, unknown>).message === "string") {
    return (value as Record<string, string>).message;
  }
  return typeof value === "string" ? value : "Command Code run failed";
}
