function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Pull a human-readable message from plain RPC/JSON error objects.
 * Avoids `String({ message: "..." })` becoming `"[object Object]"`.
 */
function messageFromPlainObject(error: Record<string, unknown>): string | null {
  for (const key of ["message", "errorMessage", "detail", "details", "title"] as const) {
    const value = error[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  const nested = error.error;
  if (isRecord(nested)) {
    return messageFromPlainObject(nested);
  }
  if (typeof nested === "string" && nested.trim().length > 0) {
    return nested.trim();
  }
  return null;
}

/**
 * Extracts a human-readable error message from an unknown error value.
 * Handles Error instances, string errors, plain RPC objects, and other types safely.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error)) {
    const fromObject = messageFromPlainObject(error);
    if (fromObject) {
      return fromObject;
    }
  }
  return String(error);
}

/**
 * Extracts an error message from an unknown error value, with a fallback
 * for when no message can be extracted.
 */
export function getErrorMessageOr(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  if (isRecord(error)) {
    const fromObject = messageFromPlainObject(error);
    if (fromObject) {
      return fromObject;
    }
  }
  return fallback;
}
