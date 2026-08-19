import { randomUUID } from "node:crypto";

import type { DaemonLifecycleOperation, DaemonLifecycleToken } from "../messages.js";
import type { AgentPermissionResponse } from "./agent-sdk-types.js";

const TOKEN_TTL_MS = 5 * 60 * 1000;

export class DaemonLifecycleGateBusyError extends Error {
  constructor(public readonly inFlightOperationId: string) {
    super(`A daemon lifecycle approval (${inFlightOperationId}) is already pending`);
    this.name = "DaemonLifecycleGateBusyError";
  }
}

export interface DaemonLifecycleApprovalRequestParams {
  requestId: string;
  agentId: string;
  operation: DaemonLifecycleOperation;
  host: string;
}

export interface DaemonLifecycleResolution {
  decision: "approved" | "denied";
  token?: DaemonLifecycleToken;
  message?: string;
}

interface PendingLifecycleApproval {
  requestId: string;
  agentId: string;
  operation: DaemonLifecycleOperation;
  host: string;
  resolve: (result: DaemonLifecycleResolution) => void;
}

interface IssuedToken {
  record: DaemonLifecycleToken;
  consumed: boolean;
}

/**
 * Server-side gate for agent-initiated daemon lifecycle operations (stop/restart).
 *
 * Owns exactly one thing at a time: a single in-flight approval request (so two agents
 * can't race two overlapping lifecycle operations) and the one-shot authorization tokens
 * minted once an operator approves. Kept independent of AgentManager/provider sessions
 * on purpose — the pending request it tracks isn't associated with any real tool call or
 * provider session, it's synthesized by the daemon itself and resolved through the same
 * respond-to-permission plumbing as any other permission request (see
 * AgentManager.requestDaemonLifecycleApproval / AgentManager.respondToPermission).
 */
export class DaemonLifecycleGate {
  private inFlight: PendingLifecycleApproval | null = null;
  private readonly tokens = new Map<string, IssuedToken>();
  private lastValidatedAgentId: string | null = null;

  getInFlightOperationId(): string | null {
    return this.inFlight?.requestId ?? null;
  }

  beginApproval(params: DaemonLifecycleApprovalRequestParams): {
    wait: () => Promise<DaemonLifecycleResolution>;
  } {
    if (this.inFlight) {
      throw new DaemonLifecycleGateBusyError(this.inFlight.requestId);
    }
    let resolveFn!: (result: DaemonLifecycleResolution) => void;
    const promise = new Promise<DaemonLifecycleResolution>((resolve) => {
      resolveFn = resolve;
    });
    this.inFlight = {
      requestId: params.requestId,
      agentId: params.agentId,
      operation: params.operation,
      host: params.host,
      resolve: resolveFn,
    };
    return { wait: () => promise };
  }

  /**
   * Resolves a gate-owned pending request (called from AgentManager.respondToPermission
   * before it would otherwise delegate to the provider session). Returns null when
   * `requestId` isn't owned by this gate, so the caller can fall through to normal
   * tool/plan/question/mode permission handling unchanged.
   */
  resolveApproval(
    requestId: string,
    response: AgentPermissionResponse,
  ): DaemonLifecycleResolution | null {
    if (!this.inFlight || this.inFlight.requestId !== requestId) {
      return null;
    }
    const pending = this.inFlight;
    this.inFlight = null;

    if (response.behavior !== "allow") {
      const resolution: DaemonLifecycleResolution = {
        decision: "denied",
        message: response.behavior === "deny" ? response.message : undefined,
      };
      pending.resolve(resolution);
      return resolution;
    }

    this.pruneExpiredTokens();
    const token: DaemonLifecycleToken = {
      token: randomUUID(),
      operationId: pending.requestId,
      agentId: pending.agentId,
      operation: pending.operation,
      host: pending.host,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
    };
    this.tokens.set(token.token, { record: token, consumed: false });
    const resolution: DaemonLifecycleResolution = { decision: "approved", token };
    pending.resolve(resolution);
    return resolution;
  }

  /**
   * One-shot, consume-on-success validation. A token is only ever good for the exact
   * operation/agent it was issued for, and only once. `operationId` is a fresh random
   * UUID per approval, so it alone already rules out cross-operation replay; `agentId`/
   * `operation` are checked too so a token can't be presented for a different connection
   * or a different lifecycle command than the operator actually approved. `host` is kept
   * on the token for audit/display only — the gate is in-memory and scoped to this exact
   * daemon process, so there's no meaningful second host value to cross-check it against.
   */
  validateToken(
    token: string,
    expect: { operationId: string; agentId: string; operation: DaemonLifecycleOperation },
  ): boolean {
    const issued = this.tokens.get(token);
    if (!issued || issued.consumed) {
      return false;
    }
    const { record } = issued;
    if (
      record.operationId !== expect.operationId ||
      record.agentId !== expect.agentId ||
      record.operation !== expect.operation ||
      Date.parse(record.expiresAt) < Date.now()
    ) {
      return false;
    }
    issued.consumed = true;
    this.lastValidatedAgentId = expect.agentId;
    return true;
  }

  /**
   * The agentId whose token most recently passed validateToken(), consumed on read.
   *
   * Why this exists: the initiating agent's own Shell-tool subprocess (running
   * `paseo daemon stop/restart`) is a descendant of that agent's own provider process.
   * If the daemon's shutdown sequence gracefully-interrupts-and-closes that same agent
   * as part of "every running session," it tree-kills its own in-flight CLI subprocess
   * before that subprocess can finish spawning the replacement daemon — proven by a
   * real-process E2E (session B's own `daemon restart` was killed by its own approved
   * restart). bootstrap.ts's stop() reads this once, right after RPC validation, to
   * exclude that one agent from the interrupt/close pass — it's still captured in the
   * resume manifest like every other running session, just not torn down by *this*
   * process's shutdown; it's left to exit on its own (or get reaped on next resume).
   */
  consumeLastValidatedAgentId(): string | null {
    const id = this.lastValidatedAgentId;
    this.lastValidatedAgentId = null;
    return id;
  }

  private pruneExpiredTokens(): void {
    const now = Date.now();
    for (const [key, issued] of this.tokens) {
      if (issued.consumed || Date.parse(issued.record.expiresAt) < now) {
        this.tokens.delete(key);
      }
    }
  }
}
