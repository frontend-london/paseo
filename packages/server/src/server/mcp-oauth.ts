import { createRemoteJWKSet, jwtVerify } from "jose";

export interface McpOAuthConfig {
  issuer: string;
  resource: string;
  resourceMetadataUrl: string;
  scopes: string[];
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: ["header"];
  scopes_supported: string[];
}

function normalizeHttpUrl(
  value: string,
  fieldName: string,
  options: { allowLoopbackHttp: boolean; trailingSlash: boolean },
): string {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[(.*)\]$/u, "$1");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(hostname);
  const httpAllowed = options.allowLoopbackHttp && loopback && url.protocol === "http:";
  if (url.protocol !== "https:" && !httpAllowed) {
    throw new Error(
      `${fieldName} must use HTTPS${options.allowLoopbackHttp ? " (except loopback HTTP)" : ""}`,
    );
  }
  url.search = "";
  url.hash = "";
  if (options.trailingSlash && !url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

export function normalizeMcpOAuthConfig(config: McpOAuthConfig): McpOAuthConfig {
  const issuer = normalizeHttpUrl(config.issuer.trim(), "PASEO_MCP_OAUTH_ISSUER", {
    allowLoopbackHttp: true,
    trailingSlash: true,
  });
  const resource = normalizeHttpUrl(config.resource.trim(), "PASEO_MCP_OAUTH_RESOURCE", {
    allowLoopbackHttp: false,
    trailingSlash: false,
  });
  const resourceMetadataUrl = normalizeHttpUrl(
    config.resourceMetadataUrl.trim(),
    "PASEO_MCP_OAUTH_RESOURCE_METADATA_URL",
    { allowLoopbackHttp: true, trailingSlash: false },
  );

  const scopes = Array.from(new Set(config.scopes.map((scope) => scope.trim()).filter(Boolean)));
  if (scopes.length === 0) {
    throw new Error("PASEO_MCP_OAUTH_SCOPES must contain at least one scope");
  }
  if (scopes.some((scope) => !/^[A-Za-z0-9._:-]+$/u.test(scope))) {
    throw new Error("PASEO_MCP_OAUTH_SCOPES contains an invalid scope token");
  }

  return { issuer, resource, resourceMetadataUrl, scopes };
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
