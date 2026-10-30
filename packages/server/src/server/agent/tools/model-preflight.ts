import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { AgentModelDefinition } from "../agent-sdk-types.js";

// Check the live, selectable provider catalog; never trust stale saved favorites.
export function assertAvailableOmniRouteModel(
  requested: string,
  available: ReadonlyArray<Pick<AgentModelDefinition, "id" | "aliases">>,
): void {
  if (available.some((model) => model.id === requested || model.aliases?.includes(requested))) {
    return;
  }
  throw new Error(
    "Unknown OmniRoute model '" +
      requested +
      "'. Select a model returned by list_models(opencode).",
  );
}

// Validate explicit OpenCode OmniRoute models against the live selectable catalog,
// not against saved favorites, before the agent is created.
export async function preflightOmniRouteModel(input: {
  provider: string;
  model?: string;
  cwd?: string;
  snapshotManager: Pick<ProviderSnapshotManager, "listModels">;
}): Promise<void> {
  if (input.provider !== "opencode" || !input.model?.startsWith("omniroute/")) {
    return;
  }
  const available = await input.snapshotManager.listModels({
    provider: "opencode",
    cwd: input.cwd,
    wait: true,
  });
  assertAvailableOmniRouteModel(input.model, available);
}
