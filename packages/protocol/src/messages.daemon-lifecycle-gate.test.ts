import { describe, expect, it } from "vitest";

import {
  DaemonLifecycleApprovalRequestMessageSchema,
  DaemonLifecycleApprovalResponseMessageSchema,
  DaemonLifecycleAuthorizationSchema,
  DaemonLifecycleOperationSchema,
  DaemonLifecycleTokenSchema,
  RestartServerRequestMessageSchema,
  ShutdownServerRequestMessageSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WSHelloMessageSchema,
} from "./messages.js";

describe("daemon lifecycle approval gate schemas", () => {
  it("only accepts stop/restart as gated operations", () => {
    expect(DaemonLifecycleOperationSchema.safeParse("stop").success).toBe(true);
    expect(DaemonLifecycleOperationSchema.safeParse("restart").success).toBe(true);
    expect(DaemonLifecycleOperationSchema.safeParse("start").success).toBe(false);
    expect(DaemonLifecycleOperationSchema.safeParse("reexec").success).toBe(false);
  });

  it("parses a daemon_lifecycle_approval_request and rejects one missing agentId", () => {
    const parsed = DaemonLifecycleApprovalRequestMessageSchema.parse({
      type: "daemon_lifecycle_approval_request",
      requestId: "req-1",
      agentId: "agent-1",
      operation: "restart",
      host: "127.0.0.1:6767",
    });
    expect(parsed.agentId).toBe("agent-1");

    expect(
      DaemonLifecycleApprovalRequestMessageSchema.safeParse({
        type: "daemon_lifecycle_approval_request",
        requestId: "req-1",
        operation: "restart",
        host: "127.0.0.1:6767",
      }).success,
    ).toBe(false);
  });

  it("is registered in the inbound message union", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "daemon_lifecycle_approval_request",
      requestId: "req-1",
      agentId: "agent-1",
      operation: "stop",
      host: "h",
    });
    expect(parsed.type).toBe("daemon_lifecycle_approval_request");
  });

  it("parses a daemon_lifecycle_approval_response for both decisions", () => {
    const approved = DaemonLifecycleApprovalResponseMessageSchema.parse({
      type: "daemon_lifecycle_approval_response",
      payload: {
        requestId: "req-1",
        agentId: "agent-1",
        decision: "approved",
        token: {
          token: "tok-1",
          operationId: "req-1",
          agentId: "agent-1",
          operation: "restart",
          host: "h",
          expiresAt: new Date().toISOString(),
        },
      },
    });
    expect(approved.payload.token?.token).toBe("tok-1");

    const denied = DaemonLifecycleApprovalResponseMessageSchema.parse({
      type: "daemon_lifecycle_approval_response",
      payload: { requestId: "req-1", agentId: "agent-1", decision: "denied", message: "no" },
    });
    expect(denied.payload.decision).toBe("denied");
  });

  it("is registered in the outbound message union", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "daemon_lifecycle_approval_response",
      payload: { requestId: "req-1", agentId: "agent-1", decision: "denied" },
    });
    expect(parsed.type).toBe("daemon_lifecycle_approval_response");
  });

  it("DaemonLifecycleTokenSchema and DaemonLifecycleAuthorizationSchema round-trip", () => {
    const token = DaemonLifecycleTokenSchema.parse({
      token: "tok-1",
      operationId: "op-1",
      agentId: "agent-1",
      operation: "stop",
      host: "h",
      expiresAt: new Date().toISOString(),
    });
    expect(token.operation).toBe("stop");

    const authorization = DaemonLifecycleAuthorizationSchema.parse({
      token: "tok-1",
      operationId: "op-1",
    });
    expect(authorization).toEqual({ token: "tok-1", operationId: "op-1" });
  });

  it("shutdown_server_request and restart_server_request accept an optional authorization", () => {
    const shutdown = ShutdownServerRequestMessageSchema.parse({
      type: "shutdown_server_request",
      requestId: "req-1",
      authorization: { token: "tok-1", operationId: "op-1" },
    });
    expect(shutdown.authorization?.token).toBe("tok-1");

    // Still valid without one — human-terminal / unauthenticated-connection behavior.
    expect(
      ShutdownServerRequestMessageSchema.safeParse({
        type: "shutdown_server_request",
        requestId: "req-1",
      }).success,
    ).toBe(true);

    const restart = RestartServerRequestMessageSchema.parse({
      type: "restart_server_request",
      requestId: "req-1",
      authorization: { token: "tok-1", operationId: "op-1" },
    });
    expect(restart.authorization?.operationId).toBe("op-1");
  });

  it("hello accepts an optional agentId and still parses without one", () => {
    const withAgent = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "cli-1",
      clientType: "cli",
      protocolVersion: 1,
      agentId: "agent-1",
    });
    expect(withAgent.agentId).toBe("agent-1");

    expect(
      WSHelloMessageSchema.safeParse({
        type: "hello",
        clientId: "cli-1",
        clientType: "cli",
        protocolVersion: 1,
      }).success,
    ).toBe(true);
  });
});
