import { describe, expect, test } from "vitest";

import { configurationEnvironment, daemonLaunchEnvironment } from "./config-environment.js";

const OAUTH_ENV = {
  PASEO_MCP_OAUTH_ISSUER: "https://tenant.example/",
  PASEO_MCP_OAUTH_RESOURCE: "https://resource.example/paseo",
  PASEO_MCP_OAUTH_RESOURCE_METADATA_URL:
    "http://127.0.0.1:6767/.well-known/oauth-protected-resource/mcp/agents",
  PASEO_MCP_OAUTH_SCOPES: "paseo.mcp",
};

describe("daemon launch environment", () => {
  test("preserves MCP OAuth settings for managed daemon launches", () => {
    const launched = daemonLaunchEnvironment({
      env: { ...OAUTH_ENV, PASEO_LISTEN: "127.0.0.1:9999" },
      home: "/tmp/paseo-home",
      mode: "managed",
    });

    expect(launched).toMatchObject(OAUTH_ENV);
    expect(launched.PASEO_LISTEN).toBeUndefined();
    expect(configurationEnvironment(launched)).toMatchObject(OAUTH_ENV);
  });
});
