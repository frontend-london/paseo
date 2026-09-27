import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createMcpOAuthTokenVerifier,
  createProtectedResourceMetadata,
  type McpOAuthConfig,
} from "./mcp-oauth.js";

describe("MCP OAuth verifier", () => {
  let server: Server;
  let issuer: string;
  let privateKey: CryptoKey;
  const resource = "https://example.test/paseo-worker";
  const scopes = ["paseo.mcp"];

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    Object.assign(jwk, { kid: "agt627-test", alg: "RS256", use: "sig" });

    server = createServer((req, res) => {
      if (req.url === "/.well-known/jwks.json") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    issuer = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  function config(): McpOAuthConfig {
    return {
      issuer,
      resource,
      resourceMetadataUrl: "http://127.0.0.1:6767/.well-known/oauth-protected-resource/mcp/agents",
      scopes,
    };
  }

  async function token(overrides?: {
    audience?: string;
    issuer?: string;
    scope?: string;
    expiresIn?: string;
  }): Promise<string> {
    return new SignJWT({ scope: overrides?.scope ?? "paseo.mcp openid" })
      .setProtectedHeader({ alg: "RS256", kid: "agt627-test" })
      .setIssuer(overrides?.issuer ?? issuer)
      .setAudience(overrides?.audience ?? resource)
      .setIssuedAt()
      .setExpirationTime(overrides?.expiresIn ?? "5m")
      .sign(privateKey);
  }
  test("accepts a valid RS256 token with matching issuer, audience, and scope", async () => {
    const verify = createMcpOAuthTokenVerifier(config());
    expect(await verify(await token())).toBe(true);
  });

  test("rejects the wrong audience", async () => {
    const verify = createMcpOAuthTokenVerifier(config());
    expect(await verify(await token({ audience: "https://wrong.example/resource" }))).toBe(false);
  });

  test("rejects a token missing the required scope", async () => {
    const verify = createMcpOAuthTokenVerifier(config());
    expect(await verify(await token({ scope: "openid profile" }))).toBe(false);
  });

  test("rejects the wrong issuer", async () => {
    const verify = createMcpOAuthTokenVerifier(config());
    expect(await verify(await token({ issuer: "https://wrong.example/" }))).toBe(false);
  });

  test("publishes RFC protected-resource metadata", () => {
    expect(createProtectedResourceMetadata(config())).toEqual({
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: scopes,
    });
  });
});
