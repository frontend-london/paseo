import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import type { JWTPayload } from "jose";

const AUDIENCE = "agents-message-ingress/v1";
const MAX_TTL_SECONDS = 300;
const MAX_TOKEN_BYTES = 16384;

interface Binding {
  identity: string;
  ticket: string;
  host: string;
  native_session_id: string;
  workspace_id: string;
  workspace: string;
  provider_session_id: string;
}

export interface IngressSnapshot {
  id: string;
  cwd?: string;
  workspaceId?: string;
  labels?: Record<string, string>;
  persistence?: { sessionId: string } | null;
  runtimeInfo?: { sessionId?: string | null };
  archivedAt?: string | null;
}

interface Proof {
  source: Binding;
  target: Binding;
  provenance: string;
  request_id: string;
  purpose: string;
}

interface TrustedKey {
  name: string;
  issuer: string;
  public_key: string;
  purposes: string[];
}

export interface IngressRequest {
  authorization?: string;
  target: IngressSnapshot;
  getSource: (id: string) => IngressSnapshot | null;
  callerAgentId?: string;
  channel: string;
  nativeMessageId: string;
  consume: boolean;
}

class IngressError extends Error {
  constructor(readonly reason: string) {
    super(`message ingress refused: ${reason}`);
  }
}

function binding(value: unknown): Binding {
  const fields = [
    "identity",
    "ticket",
    "host",
    "native_session_id",
    "workspace_id",
    "workspace",
    "provider_session_id",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new IngressError("invalid_binding");
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).length !== fields.length ||
    fields.some((field) => typeof object[field] !== "string" || !object[field])
  ) {
    throw new IngressError("invalid_binding");
  }
  return object as unknown as Binding;
}

function checkSnapshot(expected: Binding, actual: IngressSnapshot | null): void {
  if (
    !actual ||
    actual.archivedAt ||
    expected.native_session_id !== actual.id ||
    expected.ticket !== actual.labels?.ticket ||
    expected.workspace !== actual.cwd ||
    expected.workspace_id !== actual.workspaceId ||
    expected.provider_session_id !==
      (actual.persistence?.sessionId ?? actual.runtimeInfo?.sessionId)
  ) {
    throw new IngressError("session_binding_mismatch");
  }
}

function stateRoot(): string {
  return join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "message-ingress");
}

function sourceAuditFields(proof: Proof | null) {
  return {
    source_identity: proof?.source.identity ?? "UNVERIFIED",
    provenance: proof?.provenance ?? "UNVERIFIED",
    source_ticket: proof?.source.ticket ?? null,
    source_host: proof?.source.host ?? null,
    source_native_session_id: proof?.source.native_session_id ?? null,
    source_workspace: proof?.source.workspace ?? null,
  };
}

function targetAuditFields(request: IngressRequest, proof: Proof | null) {
  return {
    host: proof?.target.host ?? process.env.AGENTS_INGRESS_HOST ?? "UNVERIFIED",
    target_ticket: proof?.target.ticket ?? null,
    acp_agent_id: proof?.target.identity ?? null,
    native_session_id: request.target.id,
    provider_session_id: proof?.target.provider_session_id ?? null,
    workspace: request.target.cwd ?? null,
    workspace_id: request.target.workspaceId ?? null,
    request_id: proof?.request_id ?? null,
    native_message_id: request.nativeMessageId,
    purpose: proof?.purpose ?? null,
  };
}

function audit(
  request: IngressRequest,
  proof: Proof | null,
  decision: string,
  reason: string,
): void {
  const root = stateRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const row = {
    at: new Date().toISOString(),
    channel: request.channel,
    decision,
    reason,
    ...sourceAuditFields(proof),
    ...targetAuditFields(request, proof),
  };
  const fd = openSync(join(root, "audit.jsonl"), "a", 0o600);
  try {
    writeSync(fd, JSON.stringify(row) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function claim(requestId: string): void {
  const directory = join(stateRoot(), "claims");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(requestId).digest("hex");
  let fd: number;
  try {
    fd = openSync(join(directory, name), "wx", 0o600);
  } catch {
    throw new IngressError("request_already_claimed_or_store_unavailable");
  }
  try {
    writeSync(fd, requestId);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function checkAuthorizationScope(
  payload: JWTPayload,
  source: Binding,
  target: Binding,
  key: TrustedKey,
): { requestId: string; purpose: string } {
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    payload.iat! > now ||
    payload.exp! - payload.iat! <= 0 ||
    payload.exp! - payload.iat! > MAX_TTL_SECONDS ||
    source.identity !== payload.sub ||
    typeof payload.jti !== "string" ||
    !payload.jti ||
    payload.jti.length > 128 ||
    typeof payload.purpose !== "string" ||
    !["message", "bootstrap", "retarget"].includes(payload.purpose) ||
    !key.purposes.includes(payload.purpose) ||
    (source.ticket !== target.ticket && payload.purpose !== "retarget")
  ) {
    throw new IngressError("invalid_authorization_scope");
  }
  return { requestId: payload.jti as string, purpose: payload.purpose as string };
}

async function verify(authorization: string): Promise<Proof> {
  const trustFile = process.env.AGENTS_INGRESS_TRUST_FILE;
  if (!trustFile || !authorization || authorization.length > MAX_TOKEN_BYTES)
    throw new IngressError("source_authorization_missing");
  try {
    const trust = JSON.parse(readFileSync(trustFile, "utf8")) as Record<string, TrustedKey>;
    const header = decodeProtectedHeader(authorization);
    if (header.alg !== "EdDSA" || !header.kid || !Object.hasOwn(trust, header.kid))
      throw new IngressError("untrusted_key");
    const key = trust[header.kid]!;
    const { payload } = await jwtVerify(authorization, await importSPKI(key.public_key, "EdDSA"), {
      algorithms: ["EdDSA"],
      issuer: key.issuer,
      audience: AUDIENCE,
      requiredClaims: ["sub", "iat", "exp", "jti"],
    });
    const source = binding(payload.source);
    const target = binding(payload.target);
    const scope = checkAuthorizationScope(payload, source, target, key);
    if (!process.env.AGENTS_INGRESS_HOST || process.env.AGENTS_INGRESS_HOST !== target.host)
      throw new IngressError("wrong_daemon_host");
    return {
      source,
      target,
      provenance: `${key.issuer}#${key.name}`,
      request_id: scope.requestId,
      purpose: scope.purpose,
    };
  } catch (error) {
    if (error instanceof IngressError) throw error;
    throw new IngressError("source_authorization_invalid");
  }
}

/** Bramka jest niezależna od ACP i działa przed providerem oraz poleceniami out-of-band. */
export async function authorizeMessageIngress(request: IngressRequest): Promise<Proof | null> {
  if (
    !request.target.labels?.ticket &&
    !process.env.AGENTS_INGRESS_TRUST_FILE &&
    !request.authorization
  )
    return null;
  let proof: Proof | null = null;
  try {
    proof = await verify(request.authorization ?? "");
    checkSnapshot(proof.target, request.target);
    if (request.callerAgentId && request.callerAgentId !== proof.source.native_session_id)
      throw new IngressError("source_identity_mismatch");
    if (proof.source.identity.startsWith("agent:"))
      checkSnapshot(proof.source, request.getSource(proof.source.native_session_id));
    if (request.consume) claim(proof.request_id);
    audit(request, proof, request.consume ? "intent" : "validated", "verified");
    return proof;
  } catch (error) {
    const reason = error instanceof IngressError ? error.reason : "verification_unavailable";
    audit(request, proof, "deny", reason);
    throw new IngressError(reason);
  }
}

export function recordMessageIngressReceipt(
  request: IngressRequest,
  proof: Proof | null,
  outcome: string,
): void {
  if (proof || outcome === "trusted_system_allow") audit(request, proof, "receipt", outcome);
}
