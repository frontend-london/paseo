export const PASEO_DEFAULT_MODE = "yolo";

const PASEO_LEGACY_DEFAULT_MODES = new Set(["", "default", "smart"]);

/**
 * Central YOLO-by-default contract.
 *
 * Any new session that does not explicitly request a concrete mode, or that
 * uses a legacy default alias such as "default" or "smart", starts in Paseo
 * "yolo" mode when the provider exposes it. If the provider does not support
 * "yolo", the caller's explicit mode or the provider's own default is preserved.
 */
export function resolvePaseoModeDefault(
  requestedMode: string | undefined | null,
  availableModes: string[] | undefined,
): string | undefined {
  if (!availableModes?.includes(PASEO_DEFAULT_MODE)) {
    return requestedMode ?? undefined;
  }

  if (requestedMode === undefined || requestedMode === null) {
    return PASEO_DEFAULT_MODE;
  }

  const trimmed = requestedMode.trim().toLowerCase();
  if (PASEO_LEGACY_DEFAULT_MODES.has(trimmed)) {
    return PASEO_DEFAULT_MODE;
  }

  return requestedMode;
}
