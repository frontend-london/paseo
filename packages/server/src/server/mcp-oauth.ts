import { createRemoteJWKSet, jwtVerify } from "jose";

export interface McpOAuthConfig {
  issuer: string;
  resource: string;
  scopes: string[];
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: ["header"];
  scopes_supported: string[];
}

function normalizeIssuer(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("PASEO_MCP_OAUTH_ISSUER must use HTTPS (except loopback tests)");
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

export function normalizeMcpOAuthConfig(config: McpOAuthConfig): McpOAuthConfig {
  const issuer = normalizeIssuer(config.issuer.trim());
  const resource = config.resource.trim();
  if (!resource) throw new Error("PASEO_MCP_OAUTH_RESOURCE must not be empty");

  const scopes = Array.from(new Set(config.scopes.map((scope) => scope.trim()).filter(Boolean)));
  if (scopes.length === 0) {
    throw new Error("PASEO_MCP_OAUTH_SCOPES must contain at least one scope");
  }

  return { issuer, resource, scopes };
}

export function createProtectedResourceMetadata(config: McpOAuthConfig): ProtectedResourceMetadata {
  const normalized = normalizeMcpOAuthConfig(config);
  return {
    resource: normalized.resource,
    authorization_servers: [normalized.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: normalized.scopes,
  };
}

function tokenScopes(scopeClaim: unknown): Set<string> {
  if (typeof scopeClaim !== "string") return new Set();
  return new Set(
    scopeClaim
      .split(/\s+/u)
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
}

export function createMcpOAuthTokenVerifier(
  config: McpOAuthConfig,
): (token: string) => Promise<boolean> {
  const normalized = normalizeMcpOAuthConfig(config);
  const jwksUrl = new URL(".well-known/jwks.json", normalized.issuer);
  const keySet = createRemoteJWKSet(jwksUrl);
  return async (token: string): Promise<boolean> => {
    try {
      const { payload } = await jwtVerify(token, keySet, {
        issuer: normalized.issuer,
        audience: normalized.resource,
        algorithms: ["RS256"],
      });
      const scopes = tokenScopes(payload.scope);
      return normalized.scopes.every((scope) => scopes.has(scope));
    } catch {
      return false;
    }
  };
}
