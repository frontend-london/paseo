/**
 * Convert unknown thrown values into a user-safe error string.
 * Plain objects with `message` (common JSON-RPC / wire errors) must not become
 * "[object Object]".
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "errorMessage", "detail", "details", "title"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    const nested = record.error;
    if (typeof nested === "string" && nested.trim().length > 0) {
      return nested.trim();
    }
    if (typeof nested === "object" && nested !== null) {
      const nestedMessage = (nested as Record<string, unknown>).message;
      if (typeof nestedMessage === "string" && nestedMessage.trim().length > 0) {
        return nestedMessage.trim();
      }
    }
  }

  return String(error);
}
