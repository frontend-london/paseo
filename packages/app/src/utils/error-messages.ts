function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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
 * Convert unknown thrown/RPC values into a user-visible string.
 * Plain objects with `message` (common JSON-RPC / wire errors) must not become
 * "[object Object]".
 */
export function toErrorMessage(error: unknown): string {
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
