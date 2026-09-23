import type { Logger } from "pino";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";

export type CreateAgentDedupeState = "in-progress" | "success" | "failed";

export interface CreateAgentDedupeSuccessRecord<T> {
  state: "success";
  agentId: string;
  workspaceId?: string;
  result: T;
  completedAt: number;
}

export interface CreateAgentDedupeFailedRecord {
  state: "failed";
  error: unknown;
  failedAt: number;
  agentId?: string;
  workspaceId?: string;
}

export interface CreateAgentDedupeInProgressRecord<T> {
  state: "in-progress";
  startedAt: number;
  promise: Promise<{ agentId: string; workspaceId?: string; result: T }>;
  agentId?: string;
  workspaceId?: string;
}

export type CreateAgentDedupeRecord<T> =
  | CreateAgentDedupeInProgressRecord<T>
  | CreateAgentDedupeSuccessRecord<T>
  | CreateAgentDedupeFailedRecord;

export interface CreateAgentDedupeRegistryDependencies {
  agentManager: AgentManager;
  agentStorage?: AgentStorage;
  logger: Logger;
  maxEntries?: number;
  ttlMs?: number;
}

export interface ExecuteWithDedupeContext {
  provisionedWorkspaceId?: string;
  setProvisionedWorkspaceId: (workspaceId: string) => void;
  setCreatedAgentId: (agentId: string) => void;
}

export interface ExecuteWithDedupeOptions<T> {
  idempotencyKey: string;
  execute: (
    context: ExecuteWithDedupeContext,
  ) => Promise<{ agentId: string; workspaceId?: string; result: T }>;
  onSuccessReturnExisting?: (agentId: string) => Promise<T | null>;
  cleanupFailedAgent?: (agentId: string) => Promise<void>;
}

export interface ExecuteWithDedupeResult<T> {
  agentId: string;
  workspaceId?: string;
  result: T;
  reused: boolean;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

export class CreateAgentDedupeRegistry {
  private readonly entries = new Map<string, CreateAgentDedupeRecord<unknown>>();
  private readonly agentManager: AgentManager;
  private readonly logger: Logger;
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(dependencies: CreateAgentDedupeRegistryDependencies) {
    this.agentManager = dependencies.agentManager;
    this.logger = dependencies.logger.child({ component: "create-agent-dedupe-registry" });
    this.maxEntries = dependencies.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = dependencies.ttlMs ?? DEFAULT_TTL_MS;
  }

  getEntry(idempotencyKey: string): CreateAgentDedupeRecord<unknown> | undefined {
    this.pruneExpiredEntries();
    return this.entries.get(idempotencyKey);
  }

  async execute<T>(options: ExecuteWithDedupeOptions<T>): Promise<ExecuteWithDedupeResult<T>> {
    const key = options.idempotencyKey.trim();
    if (!key) {
      const { agentId, workspaceId, result } = await options.execute({
        setProvisionedWorkspaceId: () => {},
        setCreatedAgentId: () => {},
      });
      return { agentId, workspaceId, result, reused: false };
    }

    this.pruneExpiredEntries();

    let priorWorkspaceId: string | undefined;
    const existing = this.entries.get(key) as CreateAgentDedupeRecord<T> | undefined;

    if (existing) {
      if (existing.state === "in-progress") {
        this.logger.debug({ idempotencyKey: key }, "Joining in-progress agent creation");
        const joined = await existing.promise;
        return {
          agentId: joined.agentId,
          workspaceId: joined.workspaceId,
          result: joined.result,
          reused: true,
        };
      }

      if (existing.state === "success") {
        if (options.onSuccessReturnExisting) {
          const payload = await options.onSuccessReturnExisting(existing.agentId);
          if (payload !== null) {
            this.logger.debug(
              { idempotencyKey: key, agentId: existing.agentId },
              "Reusing existing agent for idempotency key",
            );
            return {
              agentId: existing.agentId,
              workspaceId: existing.workspaceId,
              result: payload,
              reused: true,
            };
          }
        } else {
          const liveAgent = this.agentManager.getAgent(existing.agentId);
          if (liveAgent) {
            this.logger.debug(
              { idempotencyKey: key, agentId: existing.agentId },
              "Reusing existing live agent for idempotency key",
            );
            return {
              agentId: existing.agentId,
              workspaceId: existing.workspaceId,
              result: existing.result,
              reused: true,
            };
          }
        }

        // If the agent record no longer exists or was pruned, drop the stale success entry
        this.entries.delete(key);
      } else if (existing.state === "failed") {
        // Prior terminal failure: clean up any residual failed agent state before retry
        if (existing.agentId) {
          await this.cleanupResidualFailedAgent(existing.agentId, key, options.cleanupFailedAgent);
        }
        // Remember any provisioned workspace ID so retry can reuse it without creating duplicate workspaces
        priorWorkspaceId = existing.workspaceId;
        this.entries.delete(key);
      }
    }

    // Set in-progress synchronously before any async work to prevent races
    let resolvePromise!: (val: { agentId: string; workspaceId?: string; result: T }) => void;
    let rejectPromise!: (err: unknown) => void;
    const inProgressPromise = new Promise<{ agentId: string; workspaceId?: string; result: T }>(
      (resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      },
    );
    // Suppress unhandled rejection if no concurrent callers join this promise
    inProgressPromise.catch(() => {});

    this.evictOldestIfNecessary();
    const inProgressRecord: CreateAgentDedupeInProgressRecord<T> = {
      state: "in-progress",
      startedAt: Date.now(),
      promise: inProgressPromise,
      workspaceId: priorWorkspaceId,
    };
    this.entries.set(key, inProgressRecord as CreateAgentDedupeRecord<unknown>);

    const context: ExecuteWithDedupeContext = {
      provisionedWorkspaceId: priorWorkspaceId,
      setProvisionedWorkspaceId: (workspaceId: string) => {
        inProgressRecord.workspaceId = workspaceId;
      },
      setCreatedAgentId: (agentId: string) => {
        inProgressRecord.agentId = agentId;
      },
    };

    try {
      const outcome = await options.execute(context);
      const finalWorkspaceId = outcome.workspaceId ?? inProgressRecord.workspaceId;

      this.entries.set(key, {
        state: "success",
        agentId: outcome.agentId,
        workspaceId: finalWorkspaceId,
        result: outcome.result,
        completedAt: Date.now(),
      });

      resolvePromise({ ...outcome, workspaceId: finalWorkspaceId });
      return {
        agentId: outcome.agentId,
        workspaceId: finalWorkspaceId,
        result: outcome.result,
        reused: false,
      };
    } catch (error) {
      this.entries.set(key, {
        state: "failed",
        error,
        failedAt: Date.now(),
        agentId: inProgressRecord.agentId,
        workspaceId: inProgressRecord.workspaceId,
      });

      rejectPromise(error);
      throw error;
    }
  }

  clear(): void {
    this.entries.clear();
  }

  private pruneExpiredEntries(): void {
    const now = Date.now();
    for (const [key, record] of this.entries.entries()) {
      if (record.state === "in-progress") {
        continue;
      }
      const timestamp = record.state === "success" ? record.completedAt : record.failedAt;
      if (now - timestamp > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  private evictOldestIfNecessary(): void {
    if (this.entries.size < this.maxEntries) {
      return;
    }

    // Evict oldest completed or failed entry
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, record] of this.entries.entries()) {
      if (record.state === "in-progress") {
        continue;
      }
      const time = record.state === "success" ? record.completedAt : record.failedAt;
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.entries.delete(oldestKey);
    }
  }

  private async cleanupResidualFailedAgent(
    agentId: string,
    idempotencyKey: string,
    cleanupFailedAgent?: (agentId: string) => Promise<void>,
  ): Promise<void> {
    try {
      if (cleanupFailedAgent) {
        await cleanupFailedAgent(agentId);
      } else {
        await this.agentManager.deleteAgentState(agentId).catch(() => undefined);
      }
    } catch (cleanupErr) {
      this.logger.warn(
        { err: cleanupErr, agentId, idempotencyKey },
        "Failed to clean up residual agent from prior failed attempt",
      );
    }
  }
}
