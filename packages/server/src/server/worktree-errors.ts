import { MissingCheckoutTargetError } from "./resolve-worktree-creation-intent.js";
import { BranchAlreadyCheckedOutError, UnknownBranchError } from "../utils/worktree.js";

export type WorktreeWireErrorCode =
  | "branch_already_checked_out"
  | "missing_checkout_target"
  | "unknown_branch"
  | "unknown";

export interface WorktreeWireError {
  code: WorktreeWireErrorCode;
  message: string;
}

export class WorktreeRequestError extends Error {
  readonly code: WorktreeWireErrorCode;

  constructor(error: WorktreeWireError) {
    super(error.message);
    this.name = "WorktreeRequestError";
    this.code = error.code;
  }
}

function messageFromUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
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

export function toWorktreeWireError(error: unknown): WorktreeWireError {
  if (error instanceof BranchAlreadyCheckedOutError) {
    return { code: "branch_already_checked_out", message: error.message };
  }
  if (error instanceof MissingCheckoutTargetError) {
    return { code: "missing_checkout_target", message: error.message };
  }
  if (error instanceof UnknownBranchError) {
    return { code: "unknown_branch", message: error.message };
  }
  if (error instanceof Error) {
    return { code: "unknown", message: error.message };
  }
  return { code: "unknown", message: messageFromUnknown(error) };
}

export function toWorktreeRequestError(error: unknown): WorktreeRequestError {
  return new WorktreeRequestError(toWorktreeWireError(error));
}
