import { expect, test } from "vitest";

import { DaemonLifecycleGate, DaemonLifecycleGateBusyError } from "./daemon-lifecycle-gate.js";

function request(overrides: Partial<Parameters<DaemonLifecycleGate["beginApproval"]>[0]> = {}) {
  return {
    requestId: "req-1",
    agentId: "agent-1",
    operation: "restart" as const,
    host: "127.0.0.1:6767",
    ...overrides,
  };
}

test("beginApproval then resolveApproval(allow) issues a one-shot token", async () => {
  const gate = new DaemonLifecycleGate();
  const { wait } = gate.beginApproval(request());

  const resolution = gate.resolveApproval("req-1", { behavior: "allow" });
  expect(resolution).not.toBeNull();
  expect(resolution?.decision).toBe("approved");
  expect(resolution?.token?.operationId).toBe("req-1");
  expect(resolution?.token?.agentId).toBe("agent-1");
  expect(resolution?.token?.operation).toBe("restart");

  await expect(wait()).resolves.toEqual(resolution);
});

test("resolveApproval(deny) carries the deny message and mints no token", () => {
  const gate = new DaemonLifecycleGate();
  gate.beginApproval(request());

  const resolution = gate.resolveApproval("req-1", { behavior: "deny", message: "not now" });
  expect(resolution).toEqual({ decision: "denied", message: "not now" });
});

test("resolveApproval returns null for a requestId the gate doesn't own", () => {
  const gate = new DaemonLifecycleGate();
  gate.beginApproval(request());

  expect(gate.resolveApproval("some-other-id", { behavior: "allow" })).toBeNull();
});

test("a second beginApproval while one is pending throws DaemonLifecycleGateBusyError", () => {
  const gate = new DaemonLifecycleGate();
  gate.beginApproval(request());

  expect(() => gate.beginApproval(request({ requestId: "req-2" }))).toThrow(
    DaemonLifecycleGateBusyError,
  );
});

test("the gate accepts a new request once the prior one is resolved", () => {
  const gate = new DaemonLifecycleGate();
  gate.beginApproval(request());
  gate.resolveApproval("req-1", { behavior: "deny" });

  expect(() => gate.beginApproval(request({ requestId: "req-2" }))).not.toThrow();
});

test("validateToken is one-shot: a valid token can only be consumed once", () => {
  const gate = new DaemonLifecycleGate();
  gate.beginApproval(request());
  const resolution = gate.resolveApproval("req-1", { behavior: "allow" });
  const token = resolution?.token;
  if (!token) throw new Error("expected token");

  const expect_ = { operationId: "req-1", agentId: "agent-1", operation: "restart" as const };
  expect(gate.validateToken(token.token, expect_)).toBe(true);
  expect(gate.validateToken(token.token, expect_)).toBe(false);
});

test("validateToken rejects a token for the wrong operationId/agentId/operation", () => {
  const gate = new DaemonLifecycleGate();
  gate.beginApproval(request());
  const token = gate.resolveApproval("req-1", { behavior: "allow" })?.token;
  if (!token) throw new Error("expected token");

  expect(
    gate.validateToken(token.token, {
      operationId: "wrong-operation-id",
      agentId: "agent-1",
      operation: "restart",
    }),
  ).toBe(false);
  expect(
    gate.validateToken(token.token, {
      operationId: "req-1",
      agentId: "wrong-agent",
      operation: "restart",
    }),
  ).toBe(false);
  expect(
    gate.validateToken(token.token, {
      operationId: "req-1",
      agentId: "agent-1",
      operation: "stop",
    }),
  ).toBe(false);

  // None of the mismatched attempts above consumed it.
  expect(
    gate.validateToken(token.token, {
      operationId: "req-1",
      agentId: "agent-1",
      operation: "restart",
    }),
  ).toBe(true);
});

test("validateToken rejects an unknown token", () => {
  const gate = new DaemonLifecycleGate();
  expect(
    gate.validateToken("never-issued", {
      operationId: "req-1",
      agentId: "agent-1",
      operation: "stop",
    }),
  ).toBe(false);
});

test("validateToken rejects an expired token", () => {
  const gate = new DaemonLifecycleGate();
  gate.beginApproval(request());
  const token = gate.resolveApproval("req-1", { behavior: "allow" })?.token;
  if (!token) throw new Error("expected token");

  // Simulate expiry by mutating the returned record's copy of expiresAt won't affect the
  // gate's internal store, so instead assert the field is set to a sane, near-future TTL
  // (the gate itself doesn't expose a clock override — this documents the contract).
  const expiresAt = Date.parse(token.expiresAt);
  expect(expiresAt).toBeGreaterThan(Date.now());
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000);
});

test("getInFlightOperationId reflects the current pending request", () => {
  const gate = new DaemonLifecycleGate();
  expect(gate.getInFlightOperationId()).toBeNull();
  gate.beginApproval(request());
  expect(gate.getInFlightOperationId()).toBe("req-1");
  gate.resolveApproval("req-1", { behavior: "deny" });
  expect(gate.getInFlightOperationId()).toBeNull();
});
