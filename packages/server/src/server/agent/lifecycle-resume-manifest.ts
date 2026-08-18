import { promises as fs } from "node:fs";
import path from "node:path";

import { writeJsonFileAtomic } from "../atomic-file.js";

const MANIFEST_SUBDIR = "daemon-lifecycle";
const ARCHIVE_SUBDIR = "archived";

export type LifecycleResumeEntryStatus = "pending" | "resumed" | "failed_to_resume";

/**
 * One session that was `running` (had an active turn) at the moment a daemon shutdown
 * began. Deliberately thin: full session config already lives durably in
 * StoredAgentRecord (agent-storage.ts), re-read by agentId at resume time — this only
 * needs enough to find the record and know what to do with it.
 */
export interface LifecycleResumeManifestEntry {
  agentId: string;
  cwd: string;
  workspaceId?: string;
  priorStatus: "running";
  capturedAt: string;
  status: LifecycleResumeEntryStatus;
}

export interface LifecycleResumeManifest {
  operationId: string;
  createdAt: string;
  entries: LifecycleResumeManifestEntry[];
}

export function lifecycleManifestDir(paseoHome: string): string {
  return path.join(paseoHome, MANIFEST_SUBDIR);
}

function manifestPath(paseoHome: string, operationId: string): string {
  return path.join(lifecycleManifestDir(paseoHome), `${operationId}.json`);
}

function archivedManifestPath(paseoHome: string, operationId: string): string {
  return path.join(lifecycleManifestDir(paseoHome), ARCHIVE_SUBDIR, `${operationId}.json`);
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function writeLifecycleResumeManifest(
  paseoHome: string,
  manifest: LifecycleResumeManifest,
): Promise<void> {
  await writeJsonFileAtomic(manifestPath(paseoHome, manifest.operationId), manifest);
}

export async function readLifecycleResumeManifest(
  paseoHome: string,
  operationId: string,
): Promise<LifecycleResumeManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(paseoHome, operationId), "utf8");
    return JSON.parse(raw) as LifecycleResumeManifest;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/** Read-modify-atomic-write. Safe to call repeatedly / after a crash mid-resume-loop. */
export async function updateLifecycleResumeEntryStatus(
  paseoHome: string,
  operationId: string,
  agentId: string,
  status: LifecycleResumeEntryStatus,
): Promise<void> {
  const manifest = await readLifecycleResumeManifest(paseoHome, operationId);
  if (!manifest) return;
  let changed = false;
  for (const entry of manifest.entries) {
    if (entry.agentId === agentId && entry.status !== status) {
      entry.status = status;
      changed = true;
    }
  }
  if (changed) {
    await writeLifecycleResumeManifest(paseoHome, manifest);
  }
}

/** Manifests with at least one still-`pending` entry — what startup resume drains. */
export async function listPendingLifecycleManifests(
  paseoHome: string,
): Promise<LifecycleResumeManifest[]> {
  const dir = lifecycleManifestDir(paseoHome);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  const manifests: LifecycleResumeManifest[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const operationId = file.slice(0, -".json".length);
    const manifest = await readLifecycleResumeManifest(paseoHome, operationId);
    if (manifest?.entries.some((entry) => entry.status === "pending")) {
      manifests.push(manifest);
    }
  }
  return manifests;
}

/**
 * Once every entry in a manifest is terminal (resumed or failed_to_resume), move it out
 * of the active directory so the next startup doesn't re-scan it, while keeping it on
 * disk under `archived/` for troubleshooting (see docs on inspecting failed resumes).
 * No-op if the manifest still has pending entries or no longer exists.
 */
export async function archiveLifecycleManifestIfComplete(
  paseoHome: string,
  operationId: string,
): Promise<void> {
  const manifest = await readLifecycleResumeManifest(paseoHome, operationId);
  if (!manifest || manifest.entries.some((entry) => entry.status === "pending")) {
    return;
  }
  const dest = archivedManifestPath(paseoHome, operationId);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(manifestPath(paseoHome, operationId), dest);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}
