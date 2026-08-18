export const PASEO_BACKEND = "paseo";

export const PASEO_ONLY_CATEGORIES = ["agent", "delivery", "delegate", "mission"] as const;

export type PaseoOnlyCategory = (typeof PASEO_ONLY_CATEGORIES)[number];

export class PaseoOnlyGuardError extends Error {
  constructor(
    readonly category: PaseoOnlyCategory,
    readonly backend: string,
  ) {
    super(
      `Session category ${category} rejected: backend must be "${PASEO_BACKEND}", got "${backend}"`,
    );
    this.name = "PaseoOnlyGuardError";
  }
}

/**
 * Central guard for the Paseo-only runtime contract.
 *
 * All new sessions (agents, delivery, delegate, mission) must be created
 * through the Paseo backend. A missing backend is treated as Paseo for
 * backward compatibility with older clients; any other value is rejected
 * with no silent fallback to tmux or other runtimes.
 */
export function assertPaseoOnlySession(
  backend = PASEO_BACKEND,
  category: PaseoOnlyCategory = "agent",
): void {
  if (backend !== PASEO_BACKEND) {
    throw new PaseoOnlyGuardError(category, backend);
  }
}
