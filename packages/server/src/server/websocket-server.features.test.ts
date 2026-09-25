import { expect, test } from "vitest";

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";

test("server_info advertises workspaceRemove support", () => {
  const buildServerInfo = Reflect.get(
    VoiceAssistantWebSocketServer.prototype,
    "buildServerInfoStatusPayload",
  );
  expect(typeof buildServerInfo).toBe("function");
  if (typeof buildServerInfo !== "function") {
    throw new Error("Expected buildServerInfoStatusPayload");
  }

  const payload = Reflect.apply(
    buildServerInfo,
    {
      serverId: "srv-test",
      daemonVersion: "0.9.2",
      daemonRuntimeConfig: undefined,
      serverCapabilities: undefined,
      workspaceLabelService: null,
      advertiseDaemonStatusRpc: true,
      advertiseRelayConfig: true,
    },
    [{ getPermissions: () => [] }],
  ) as { features?: { workspaceRemove?: boolean } };

  expect(payload.features?.workspaceRemove).toBe(true);
});
