import { expect, test, vi } from "vitest";

import { detectCallingAgentId, requestApprovalIfAgentInvoked } from "./lifecycle-approval.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

test("detectCallingAgentId reads PASEO_AGENT_ID and trims it", () => {
  expect(detectCallingAgentId({ PASEO_AGENT_ID: "  agent-42  " })).toBe("agent-42");
});

test("detectCallingAgentId returns undefined when unset or blank", () => {
  expect(detectCallingAgentId({})).toBeUndefined();
  expect(detectCallingAgentId({ PASEO_AGENT_ID: "   " })).toBeUndefined();
});

function fakeClient(
  requestDaemonLifecycleApproval: DaemonClient["requestDaemonLifecycleApproval"],
) {
  return { requestDaemonLifecycleApproval } as unknown as DaemonClient;
}

test("skips approval entirely when not invoked from an agent (human terminal)", async () => {
  const requestDaemonLifecycleApproval = vi.fn();
  const outcome = await requestApprovalIfAgentInvoked({
    client: fakeClient(requestDaemonLifecycleApproval),
    agentId: undefined,
    operation: "stop",
    host: "h",
  });
  expect(outcome).toEqual({ skip: true });
  expect(requestDaemonLifecycleApproval).not.toHaveBeenCalled();
});

test("returns the authorization token on approval", async () => {
  const token = { token: "tok-1", operationId: "op-1" };
  const requestDaemonLifecycleApproval = vi.fn().mockResolvedValue({
    decision: "approved",
    token,
  });
  const outcome = await requestApprovalIfAgentInvoked({
    client: fakeClient(requestDaemonLifecycleApproval),
    agentId: "agent-1",
    operation: "restart",
    host: "h",
  });
  expect(outcome).toEqual({ approved: true, authorization: token });
  expect(requestDaemonLifecycleApproval).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: "agent-1", operation: "restart", host: "h" }),
  );
});

test("denial is surfaced with the operator's message", async () => {
  const requestDaemonLifecycleApproval = vi.fn().mockResolvedValue({
    decision: "denied",
    message: "no thanks",
  });
  const outcome = await requestApprovalIfAgentInvoked({
    client: fakeClient(requestDaemonLifecycleApproval),
    agentId: "agent-1",
    operation: "stop",
    host: "h",
  });
  expect(outcome).toEqual({ denied: true, message: "no thanks" });
});

test("an 'approved' decision with no token is treated as a denial (fail closed)", async () => {
  const requestDaemonLifecycleApproval = vi.fn().mockResolvedValue({ decision: "approved" });
  const outcome = await requestApprovalIfAgentInvoked({
    client: fakeClient(requestDaemonLifecycleApproval),
    agentId: "agent-1",
    operation: "stop",
    host: "h",
  });
  expect(outcome).toMatchObject({ denied: true });
});
