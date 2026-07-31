import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import {
  EXTERNAL_RUNTIME_LABEL,
  EXTERNAL_SESSION_KEY_LABEL,
  getExternalSessionKeyFromLabels,
  isExternalRuntimeAgent,
} from "@getpaseo/protocol/agent-labels";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import { buildStoredAgentPayload } from "./agent-projections.js";
import type { AgentProvider } from "./agent-sdk-types.js";

export interface ExternalRegisterInput {
  externalSessionKey: string;
  provider: AgentProvider;
  cwd: string;
  title?: string;
  model?: string | null;
  workspaceId?: string;
  labels?: Record<string, string>;
  sessionHandle?: string;
}

export interface ExternalRegisterResult {
  accepted: boolean;
  created: boolean;
  agentId: string | null;
  record: StoredAgentRecord | null;
  error: string | null;
}

export interface ExternalRegisterDependencies {
  agentStorage: Pick<AgentStorage, "list" | "get" | "upsert">;
  /** Optional explicit agent id factory; defaults to randomUUID. */
  idFactory?: () => string;
  logger?: Logger;
  /** Provider ids treated as available for projection (passed to buildStoredAgentPayload). */
  validProviders?: Iterable<AgentProvider>;
}

function normalizeLabels(labels: Record<string, string> | undefined): Record<string, string> {
  if (!labels) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (typeof key === "string" && key.trim() && typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function buildExternalLabels(input: ExternalRegisterInput): Record<string, string> {
  return {
    ...normalizeLabels(input.labels),
    [EXTERNAL_RUNTIME_LABEL]: "true",
    [EXTERNAL_SESSION_KEY_LABEL]: input.externalSessionKey,
  };
}

async function findByExternalSessionKey(
  agentStorage: Pick<AgentStorage, "list">,
  externalSessionKey: string,
): Promise<StoredAgentRecord | null> {
  const records = await agentStorage.list();
  let archivedMatch: StoredAgentRecord | null = null;
  for (const record of records) {
    if (record.internal) {
      continue;
    }
    const key = getExternalSessionKeyFromLabels(record.labels);
    if (key !== externalSessionKey) {
      continue;
    }
    if (!record.archivedAt) {
      return record;
    }
    archivedMatch = record;
  }
  return archivedMatch;
}

function buildPersistence(
  provider: AgentProvider,
  cwd: string,
  sessionHandle: string | undefined,
  externalSessionKey: string,
): StoredAgentRecord["persistence"] {
  const sessionId = sessionHandle?.trim() || externalSessionKey;
  return {
    provider,
    sessionId,
    nativeHandle: sessionId,
    metadata: {
      provider,
      cwd,
      externalRuntime: true,
      externalSessionKey,
    },
  };
}

/**
 * Register (or update) a storage-only agent that represents an externally
 * managed session. Does not start a provider process.
 *
 * Idempotent on `externalSessionKey`: repeated calls update metadata and
 * clear archivedAt instead of creating duplicates.
 */
export async function registerExternalAgent(
  dependencies: ExternalRegisterDependencies,
  input: ExternalRegisterInput,
): Promise<ExternalRegisterResult> {
  const externalSessionKey = input.externalSessionKey.trim();
  if (!externalSessionKey) {
    return {
      accepted: false,
      created: false,
      agentId: null,
      record: null,
      error: "externalSessionKey is required",
    };
  }

  const cwd = input.cwd.trim();
  if (!cwd) {
    return {
      accepted: false,
      created: false,
      agentId: null,
      record: null,
      error: "cwd is required",
    };
  }

  const provider = input.provider;
  if (!provider || typeof provider !== "string" || !provider.trim()) {
    return {
      accepted: false,
      created: false,
      agentId: null,
      record: null,
      error: "provider is required",
    };
  }

  const now = new Date().toISOString();
  const labels = buildExternalLabels({ ...input, externalSessionKey });
  const title = input.title?.trim() || externalSessionKey;
  const model =
    input.model === undefined ? undefined : input.model === null ? null : input.model.trim() || null;
  const existing = await findByExternalSessionKey(dependencies.agentStorage, externalSessionKey);

  if (existing) {
    const nextRecord: StoredAgentRecord = {
      ...existing,
      provider,
      cwd,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      updatedAt: now,
      lastActivityAt: now,
      title,
      labels: {
        ...existing.labels,
        ...labels,
      },
      lastStatus: "idle",
      archivedAt: null,
      config: {
        ...(existing.config ?? {}),
        ...(model !== undefined ? { model } : {}),
      },
      runtimeInfo: {
        provider,
        sessionId:
          input.sessionHandle?.trim() ||
          existing.runtimeInfo?.sessionId ||
          existing.persistence?.sessionId ||
          externalSessionKey,
        ...(model !== undefined ? { model } : {}),
      },
      persistence: buildPersistence(
        provider,
        cwd,
        input.sessionHandle ?? existing.persistence?.sessionId,
        externalSessionKey,
      ),
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      internal: false,
    };

    await dependencies.agentStorage.upsert(nextRecord);
    dependencies.logger?.info(
      {
        agentId: nextRecord.id,
        externalSessionKey,
        created: false,
        wasArchived: Boolean(existing.archivedAt),
      },
      "external agent registered (updated)",
    );
    return {
      accepted: true,
      created: false,
      agentId: nextRecord.id,
      record: nextRecord,
      error: null,
    };
  }

  const agentId = (dependencies.idFactory ?? randomUUID)();
  const record: StoredAgentRecord = {
    id: agentId,
    provider,
    cwd,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    lastUserMessageAt: null,
    title,
    labels,
    lastStatus: "idle",
    config: {
      ...(model !== undefined ? { model } : {}),
    },
    runtimeInfo: {
      provider,
      sessionId: input.sessionHandle?.trim() || externalSessionKey,
      ...(model !== undefined ? { model } : {}),
    },
    persistence: buildPersistence(provider, cwd, input.sessionHandle, externalSessionKey),
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    internal: false,
    archivedAt: null,
  };

  await dependencies.agentStorage.upsert(record);
  dependencies.logger?.info(
    { agentId, externalSessionKey, created: true },
    "external agent registered (created)",
  );

  return {
    accepted: true,
    created: true,
    agentId,
    record,
    error: null,
  };
}

export function toExternalAgentSnapshot(
  record: StoredAgentRecord,
  validProviders?: Iterable<AgentProvider>,
): AgentSnapshotPayload {
  const providers = validProviders ?? [record.provider];
  return buildStoredAgentPayload(record, providers);
}

export function assertExternalOrThrow(record: StoredAgentRecord): void {
  if (!isExternalRuntimeAgent(record)) {
    throw new Error(`Agent ${record.id} is not an external runtime agent`);
  }
}
