import type { Logger } from "pino";

import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { formatSystemNotificationPrompt, sendPromptToAgent } from "./agent-prompt.js";
import {
  archiveLifecycleManifestIfComplete,
  listPendingLifecycleManifests,
  updateLifecycleResumeEntryStatus,
} from "./lifecycle-resume-manifest.js";

const LIFECYCLE_RESUME_NOTICE =
  "Your turn was interrupted by an approved Paseo daemon lifecycle operation (stop/restart). " +
  "The daemon has restarted. Continue from your last incomplete step — do not repeat " +
  "already-completed mutating operations without first verifying their effect.";

export interface ResumePendingLifecycleManifestsDeps {
  paseoHome: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}

/**
 * Drains every pending daemon-lifecycle resume manifest on startup: for each session
 * that was genuinely `running` right before the daemon last stopped, reconnects its
 * provider session (via sendPromptToAgent's own ensureAgentLoaded) and delivers a
 * system-injected continuation notice, using the same primitive already used for
 * finish-notifications and schedule fires — not a raw user message. Each entry is
 * marked terminal (resumed/failed_to_resume) individually and atomically, so a crash
 * mid-loop just resumes where it left off on the next boot instead of double-processing
 * already-terminal entries. Errors are logged, never thrown — this must not block daemon
 * startup.
 */
export async function resumePendingLifecycleManifests(
  deps: ResumePendingLifecycleManifestsDeps,
): Promise<void> {
  const manifests = await listPendingLifecycleManifests(deps.paseoHome);

  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      if (entry.status !== "pending") continue;

      try {
        await sendPromptToAgent({
          agentManager: deps.agentManager,
          agentStorage: deps.agentStorage,
          agentId: entry.agentId,
          prompt: formatSystemNotificationPrompt(LIFECYCLE_RESUME_NOTICE),
          unarchive: false,
          logger: deps.logger,
        });
        await updateLifecycleResumeEntryStatus(
          deps.paseoHome,
          manifest.operationId,
          entry.agentId,
          "resumed",
        );
      } catch (error) {
        deps.logger.error(
          { err: error, agentId: entry.agentId, operationId: manifest.operationId },
          "Failed to auto-resume agent after daemon lifecycle operation",
        );
        await updateLifecycleResumeEntryStatus(
          deps.paseoHome,
          manifest.operationId,
          entry.agentId,
          "failed_to_resume",
        );
      }
    }

    await archiveLifecycleManifestIfComplete(deps.paseoHome, manifest.operationId);
  }
}
