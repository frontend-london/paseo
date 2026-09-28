import { createServer, type Server, type ServerResponse } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createMcpOAuthTokenVerifier,
  createProtectedResourceMetadata,
  deriveProtectedResourceMetadataUrl,
  normalizeMcpOAuthConfig,
  type McpOAuthConfigInput,
} from "./mcp-oauth.js";

interface OversizeJwksState {
  chunksWritten: number;
  responseClosed: boolean;
}

function sendSlowJwks(res: ServerResponse, jwksJson: string): void {
  const timer = setTimeout(() => {
    if (res.destroyed) return;
    res.setHeader("content-type", "application/json");
    res.end(jwksJson);
  }, 5_500);
  res.on("close", () => clearTimeout(timer));
}

function sendOversizeChunkedJwks(res: ServerResponse, state: OversizeJwksState): void {
  state.chunksWritten = 0;
  state.responseClosed = false;
  res.setHeader("content-type", "application/json");
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const timer = setInterval(() => {
    if (res.destroyed) {
      clearInterval(timer);
      return;
    }
    state.chunksWritten += 1;
    res.write(chunk);
    if (state.chunksWritten >= 32) {
      clearInterval(timer);
      res.end();
    }
  }, 2);
  res.on("close", () => {
    state.responseClosed = true;
    clearInterval(timer);
  });
}

describe("MCP OAuth verifier", () => {
  let server: Server;
  let issuer: string;
  let privateKey: CryptoKey;
  let jwksJson = "";
  const oversizeState: OversizeJwksState = { chunksWritten: 0, responseClosed: false };
  const resource = "https://example.test/v1/mcp/tunnel_agt627";
  const scopes = ["paseo.mcp"];

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    Object.assign(jwk, { kid: "agt627-test", alg: "RS256", use: "sig" });
    jwksJson = JSON.stringify({ keys: [jwk] });

    server = createServer((req, res) => {
      if (req.url === "/keys/custom-jwks.json") {
        res.setHeader("content-type", "application/json");
        res.end(jwksJson);
        return;
      }
      if (req.url === "/keys/redirect-jwks.json") {
        res.statusCode = 302;
        res.setHeader("location", "/keys/custom-jwks.json");
        res.end();
        return;
      }
      if (req.url === "/keys/slow-jwks.json") {
        sendSlowJwks(res, jwksJson);
        return;
      }
      if (req.url === "/keys/oversize-jwks.json") {
        sendOversizeChunkedJwks(res, oversizeState);
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

  function config(overrides?: { resource?: string; jwksPath?: string }): McpOAuthConfigInput {
    return {
      issuer,
      resource: overrides?.resource ?? resource,
      jwksUrl: new URL(overrides?.jwksPath ?? "keys/custom-jwks.json", issuer).toString(),
      scopes,
    };
  }

  async function token(overrides?: {
    audience?: string;
    issuer?: string;
    scope?: string;
    expiresIn?: string;
    omitExpiration?: boolean;
    notBefore?: string;
  }): Promise<string> {
    let jwt = new SignJWT({ scope: overrides?.scope ?? "paseo.mcp openid" })
      .setProtectedHeader({ alg: "RS256", kid: "agt627-test" })
      .setIssuer(overrides?.issuer ?? issuer)
      .setAudience(overrides?.audience ?? resource)
      .setIssuedAt();
    if (!overrides?.omitExpiration) jwt = jwt.setExpirationTime(overrides?.expiresIn ?? "5m");
    if (overrides?.notBefore) jwt = jwt.setNotBefore(overrides.notBefore);
    return jwt.sign(privateKey);
  }

  test("accepts a valid RS256 token with matching issuer, audience, scope, and exp", async () => {
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

  test("rejects a token without exp", async () => {
    const verify = createMcpOAuthTokenVerifier(config());
    expect(await verify(await token({ omitExpiration: true }))).toBe(false);
  });

  test("rejects an expired token", async () => {
    const verify = createMcpOAuthTokenVerifier(config());
    expect(await verify(await token({ expiresIn: "-1m" }))).toBe(false);
  });

  test("rejects a token with a future nbf", async () => {
    const verify = createMcpOAuthTokenVerifier(config());
    expect(await verify(await token({ notBefore: "5m" }))).toBe(false);
  });

  test("uses an explicitly configured JWKS URL instead of assuming an issuer-relative path", async () => {
    const verify = createMcpOAuthTokenVerifier(config({ jwksPath: "keys/custom-jwks.json" }));
    expect(await verify(await token())).toBe(true);
  });

  test("rejects a JWKS redirect", async () => {
    const verify = createMcpOAuthTokenVerifier(config({ jwksPath: "keys/redirect-jwks.json" }));
    expect(await verify(await token())).toBe(false);
  });

  test("times out a slow JWKS response", async () => {
    const verify = createMcpOAuthTokenVerifier(config({ jwksPath: "keys/slow-jwks.json" }));
    expect(await verify(await token())).toBe(false);
  }, 7_000);

  test("stops reading an oversized chunked JWKS response", async () => {
    const verify = createMcpOAuthTokenVerifier(config({ jwksPath: "keys/oversize-jwks.json" }));
    expect(await verify(await token())).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(oversizeState.responseClosed).toBe(true);
    expect(oversizeState.chunksWritten).toBeLessThan(32);
  });

  test("accepts bracketed IPv6 loopback HTTP for local issuer and JWKS tests", () => {
    expect(
      normalizeMcpOAuthConfig({
        issuer: "http://[::1]:65534",
        resource,
        jwksUrl: "http://[::1]:65534/keys/custom.json",
        scopes,
      }),
    ).toEqual({
      issuer: "http://[::1]:65534/",
      resource,
      jwksUrl: "http://[::1]:65534/keys/custom.json",
      resourceMetadataUrl:
        "https://example.test/.well-known/oauth-protected-resource/v1/mcp/tunnel_agt627",
      scopes,
    });
  });

  test("rejects non-loopback plaintext HTTP for JWKS", () => {
    expect(() =>
      normalizeMcpOAuthConfig({
        issuer: "https://tenant.example/",
        resource,
        jwksUrl: "http://tenant.example/keys.json",
        scopes,
      }),
    ).toThrow(/must use HTTPS/u);
  });

  test("rejects a JWKS URL on a different origin than the issuer", () => {
    expect(() =>
      normalizeMcpOAuthConfig({
        issuer: "https://tenant.example/",
        resource,
        jwksUrl: "https://keys.example/jwks.json",
        scopes,
      }),
    ).toThrow(/same origin/u);
  });

  test("derives the RFC 9728 protected-resource metadata URL from the resource identifier", () => {
    expect(deriveProtectedResourceMetadataUrl(resource)).toBe(
      "https://example.test/.well-known/oauth-protected-resource/v1/mcp/tunnel_agt627",
    );
  });

  test("preserves a resource query across repeated normalization", () => {
    const resourceWithQuery = `${resource}?tenant=agt627&mode=strict`;
    const normalized = normalizeMcpOAuthConfig(config({ resource: resourceWithQuery }));
    const renormalized = normalizeMcpOAuthConfig(normalized);
    expect(renormalized.resource).toBe(resourceWithQuery);
    expect(renormalized.resourceMetadataUrl).toBe(
      "https://example.test/.well-known/oauth-protected-resource/v1/mcp/tunnel_agt627?tenant=agt627&mode=strict",
    );
  });

  test("rejects a configured resource metadata URL that is not authoritative for the resource", () => {
    expect(() =>
      normalizeMcpOAuthConfig({
        issuer: "https://tenant.example/",
        resource,
        jwksUrl: "https://tenant.example/keys.json",
        resourceMetadataUrl: "https://example.test/.well-known/oauth-protected-resource/wrong",
        scopes,
      }),
    ).toThrow(/must equal the RFC 9728 URL/u);
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
