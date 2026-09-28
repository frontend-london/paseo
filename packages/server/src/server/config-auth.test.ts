import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";
import { isBearerTokenValid } from "./auth.js";

const roots: string[] = [];
const CONFIG_PASSWORD_HASH = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-auth-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("daemon auth config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("loads optional auth password hash from config.json", async () => {
    const paseoHome = await createPaseoHome({
      version: 1,
      daemon: {
        auth: { password: CONFIG_PASSWORD_HASH },
      },
    });

    const config = loadConfig(paseoHome, { env: {} });

    expect(config.auth?.password).toBe(CONFIG_PASSWORD_HASH);
    expect(isBearerTokenValid({ password: config.auth?.password, token: "correct-password" })).toBe(
      true,
    );
  });

  test("lets PASEO_PASSWORD override config.json auth password hash", async () => {
    const paseoHome = await createPaseoHome({
      version: 1,
      daemon: {
        auth: { password: CONFIG_PASSWORD_HASH },
      },
    });

    const config = loadConfig(paseoHome, {
      env: { PASEO_PASSWORD: "from-env" },
    });

    expect(config.auth?.password).not.toBe(CONFIG_PASSWORD_HASH);
    expect(config.auth?.password).toMatch(/^\$2[aby]\$12\$/);
    expect(isBearerTokenValid({ password: config.auth?.password, token: "from-env" })).toBe(true);
  });

  test("loads MCP OAuth only from a complete env contract", async () => {
    const paseoHome = await createPaseoHome({});

    const config = loadConfig(paseoHome, {
      env: {
        PASEO_MCP_OAUTH_ISSUER: "https://tenant.example/",
        PASEO_MCP_OAUTH_RESOURCE: "https://resource.example/paseo",
        PASEO_MCP_OAUTH_JWKS_URL: "https://tenant.example/keys/jwks.json",
        PASEO_MCP_OAUTH_SCOPES: "paseo.mcp, paseo.read",
      },
    });

    expect(config.mcpOAuth).toEqual({
      issuer: "https://tenant.example/",
      resource: "https://resource.example/paseo",
      jwksUrl: "https://tenant.example/keys/jwks.json",
      resourceMetadataUrl: "https://resource.example/.well-known/oauth-protected-resource/paseo",
      scopes: ["paseo.mcp", "paseo.read"],
    });
  });

  test("rejects partial MCP OAuth configuration", async () => {
    const paseoHome = await createPaseoHome({});

    expect(() =>
      loadConfig(paseoHome, {
        env: { PASEO_MCP_OAUTH_ISSUER: "https://tenant.example/" },
      }),
    ).toThrow(/PASEO MCP OAuth requires/u);
  });
});
