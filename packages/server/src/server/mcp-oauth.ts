import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

const MAX_JWKS_BYTES = 1024 * 1024;

export interface McpOAuthConfigInput {
  issuer: string;
  resource: string;
  jwksUrl: string;
  resourceMetadataUrl?: string;
  scopes: string[];
}

export interface McpOAuthConfig {
  issuer: string;
  resource: string;
  jwksUrl: string;
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
  options: {
    allowLoopbackHttp: boolean;
    trailingSlash: boolean;
    preserveQuery?: boolean;
  },
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
  if (!options.preserveQuery) url.search = "";
  url.hash = "";
  if (options.trailingSlash && !url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

export function deriveProtectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const resourcePath = url.pathname === "/" ? "" : url.pathname;
  url.pathname = `/.well-known/oauth-protected-resource${resourcePath}`;
  return url.toString();
}

export function normalizeMcpOAuthConfig(config: McpOAuthConfigInput): McpOAuthConfig {
  const issuer = normalizeHttpUrl(config.issuer.trim(), "PASEO_MCP_OAUTH_ISSUER", {
    allowLoopbackHttp: true,
    trailingSlash: true,
  });
  const resource = normalizeHttpUrl(config.resource.trim(), "PASEO_MCP_OAUTH_RESOURCE", {
    allowLoopbackHttp: false,
    trailingSlash: false,
    preserveQuery: true,
  });
  const jwksUrl = normalizeHttpUrl(config.jwksUrl.trim(), "PASEO_MCP_OAUTH_JWKS_URL", {
    allowLoopbackHttp: true,
    trailingSlash: false,
  });

  if (new URL(jwksUrl).origin !== new URL(issuer).origin) {
    throw new Error("PASEO_MCP_OAUTH_JWKS_URL must use the same origin as PASEO_MCP_OAUTH_ISSUER");
  }

  const resourceMetadataUrl = deriveProtectedResourceMetadataUrl(resource);
  if (config.resourceMetadataUrl !== undefined) {
    const configuredMetadataUrl = normalizeHttpUrl(
      config.resourceMetadataUrl.trim(),
      "PASEO_MCP_OAUTH_RESOURCE_METADATA_URL",
      { allowLoopbackHttp: false, trailingSlash: false },
    );
    if (configuredMetadataUrl !== resourceMetadataUrl) {
      throw new Error(
        "PASEO_MCP_OAUTH_RESOURCE_METADATA_URL must equal the RFC 9728 URL derived from PASEO_MCP_OAUTH_RESOURCE",
      );
    }
  }

  const scopes = Array.from(new Set(config.scopes.map((scope) => scope.trim()).filter(Boolean)));
  if (scopes.length === 0) {
    throw new Error("PASEO_MCP_OAUTH_SCOPES must contain at least one scope");
  }
  if (scopes.some((scope) => !/^[A-Za-z0-9._:-]+$/u.test(scope))) {
    throw new Error("PASEO_MCP_OAUTH_SCOPES contains an invalid scope token");
  }

  return { issuer, resource, jwksUrl, resourceMetadataUrl, scopes };
}

export function createProtectedResourceMetadata(
  config: McpOAuthConfigInput,
): ProtectedResourceMetadata {
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

async function readResponseBodyWithLimit(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JWKS_BYTES) {
        await reader.cancel("JWKS response exceeds size limit").catch(() => undefined);
        throw new Error("JWKS response exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function fetchJwks(
  url: string,
  options: {
    headers: Headers;
    method: "GET";
    redirect: "manual";
    signal: AbortSignal;
  },
): Promise<Response> {
  const response = await fetch(url, { ...options, redirect: "error" });
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_JWKS_BYTES) {
    await response.body?.cancel("JWKS response exceeds size limit").catch(() => undefined);
    throw new Error("JWKS response exceeds size limit");
  }
  const body = await readResponseBodyWithLimit(response);
  const responseBody = new ArrayBuffer(body.byteLength);
  new Uint8Array(responseBody).set(body);
  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createMcpOAuthTokenVerifier(
  config: McpOAuthConfigInput,
): (token: string) => Promise<boolean> {
  const normalized = normalizeMcpOAuthConfig(config);
  const keySet = createRemoteJWKSet(new URL(normalized.jwksUrl), {
    timeoutDuration: 5_000,
    [customFetch]: fetchJwks,
  });
  return async (token: string): Promise<boolean> => {
    try {
      const { payload } = await jwtVerify(token, keySet, {
        issuer: normalized.issuer,
        audience: normalized.resource,
        algorithms: ["RS256"],
        requiredClaims: ["exp"],
      });
      const scopes = tokenScopes(payload.scope);
      return normalized.scopes.every((scope) => scopes.has(scope));
    } catch {
      return false;
    }
  };
}
