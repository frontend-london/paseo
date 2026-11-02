import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { SignJWT, importPKCS8, importSPKI, jwtVerify, decodeProtectedHeader } from "jose";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { isRelayClientWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import type { Logger } from "pino";
import { checkSnapshot, verifyIngressGrant, type IngressSnapshot } from "./message-ingress.js";

const identitySchema = z.object({
  host: z.string().min(1),
  daemonId: z.string().min(1),
  keyId: z.string().min(1),
  issuer: z.string().min(1),
});
const peerSchema = identitySchema.extend({
  publicKey: z.string().min(1),
  url: z.string().url(),
  daemonPublicKeyB64: z.string().min(1),
});
const configSchema = z.object({
  local: identitySchema.extend({ privateKey: z.string().optional() }),
  peers: z.record(z.string(), peerSchema),
});
const PEER_AUDIENCE = "paseo-daemon-message/v1";
const PREFIX = "peer.v1:";

export class PeerMessageError extends Error {
  constructor(readonly reason: string) {
    super(`peer message refused: ${reason}`);
  }
}

export function messageDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function configuration() {
  const file = process.env.AGENTS_PEERS_FILE;
  if (!file) throw new PeerMessageError("peers_not_configured");
  const config = configSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (config.local.host !== process.env.AGENTS_INGRESS_HOST)
    throw new PeerMessageError("local_host_mismatch");
  return config;
}

export function splitPeerAuthorization(authorization: string) {
  if (!authorization.startsWith(PREFIX)) return null;
  const parts = authorization.slice(PREFIX.length).split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1])
    throw new PeerMessageError("invalid_peer_envelope");
  return { grant: parts[0], attestation: parts[1] };
}

export async function verifyPeerAttestation(input: {
  authorization: string;
  sourceHost: string;
  targetHost: string;
  requestId: string;
  text: string;
}): Promise<void> {
  const envelope = splitPeerAuthorization(input.authorization);
  if (!envelope) throw new PeerMessageError("peer_attestation_missing");
  const config = configuration();
  const peer = config.peers[input.sourceHost];
  if (!peer || peer.host !== input.sourceHost || config.local.host !== input.targetHost)
    throw new PeerMessageError("untrusted_source_daemon");
  const header = decodeProtectedHeader(envelope.attestation);
  if (header.alg !== "EdDSA" || header.kid !== peer.keyId)
    throw new PeerMessageError("untrusted_source_daemon");
  const { payload } = await jwtVerify(
    envelope.attestation,
    await importSPKI(peer.publicKey, "EdDSA"),
    {
      algorithms: ["EdDSA"],
      issuer: peer.issuer,
      audience: PEER_AUDIENCE,
      requiredClaims: ["iat", "exp", "jti", "sub"],
    },
  );
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    payload.iat! > now ||
    payload.exp! - payload.iat! > 30 ||
    payload.exp! <= payload.iat! ||
    payload.sub !== peer.daemonId ||
    payload.jti !== input.requestId ||
    payload.source_host !== input.sourceHost ||
    payload.target_host !== config.local.host ||
    payload.target_daemon !== config.local.daemonId ||
    payload.grant_sha256 !== messageDigest(envelope.grant) ||
    payload.message_sha256 !== messageDigest(input.text)
  )
    throw new PeerMessageError("peer_binding_mismatch");
}

async function deliverPeerMessage(input: {
  authorization: string;
  text: string;
  getSource: (id: string) => IngressSnapshot | null;
  callerAgentId?: string;
  logger: Logger;
}): Promise<{ requestId: string; targetHost: string; targetSession: string }> {
  // Grant emitenta i świeży lokalny snapshot są sprawdzane przed połączeniem z siecią.
  if (input.authorization.startsWith(PREFIX)) throw new PeerMessageError("nested_peer_envelope");
  const proof = await verifyIngressGrant(input.authorization);
  const config = configuration();
  const peer = config.peers[proof.target.host];
  if (
    proof.purpose !== "message" ||
    proof.source.ticket !== proof.target.ticket ||
    proof.source.host !== config.local.host ||
    proof.target.host === config.local.host ||
    !proof.source.identity.startsWith("agent:") ||
    !proof.target.identity.startsWith("agent:") ||
    !proof.source.provider ||
    !proof.target.provider ||
    proof.message_sha256 !== messageDigest(input.text)
  )
    throw new PeerMessageError("invalid_peer_scope");
  if (input.callerAgentId && input.callerAgentId !== proof.source.native_session_id)
    throw new PeerMessageError("source_identity_mismatch");
  checkSnapshot(proof.source, input.getSource(proof.source.native_session_id));
  if (
    !peer ||
    peer.host !== proof.target.host ||
    !config.local.privateKey ||
    !isRelayClientWebSocketUrl(peer.url) ||
    new URL(peer.url).protocol !== "wss:"
  )
    throw new PeerMessageError("encrypted_peer_route_required");
  const signingKey = await importPKCS8(config.local.privateKey, "EdDSA");
  const fields = {
    requestId: proof.request_id,
    sourceHost: config.local.host,
    sourceDaemon: config.local.daemonId,
    targetHost: peer.host,
    targetDaemon: peer.daemonId,
    targetSession: proof.target.native_session_id,
    sourceSession: proof.source.native_session_id,
    ticket: proof.source.ticket,
    messageSha256: proof.message_sha256,
    pid: process.pid,
    transport: "paseo-relay-e2ee",
  };
  const client = new DaemonClient({
    url: peer.url,
    clientId: `peer_${config.local.daemonId}`,
    clientType: "mcp",
    appVersion: "0.5.2",
    connectTimeoutMs: 5000,
    reconnect: { enabled: false },
    e2ee: { enabled: true, daemonPublicKeyB64: peer.daemonPublicKeyB64 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  input.logger.info(fields, "message.peer.egress.intent");
  try {
    await Promise.race([
      (async () => {
        await client.connect();
        if (expired) throw new PeerMessageError("delivery_timeout_outcome_unknown");
        await client.fetchAgents();
        if (expired) throw new PeerMessageError("delivery_timeout_outcome_unknown");
        await verifyIngressGrant(input.authorization);
        checkSnapshot(proof.source, input.getSource(proof.source.native_session_id));
        const attestation = await new SignJWT({
          source_host: config.local.host,
          target_host: peer.host,
          target_daemon: peer.daemonId,
          grant_sha256: messageDigest(input.authorization),
          message_sha256: proof.message_sha256,
        })
          .setProtectedHeader({ alg: "EdDSA", kid: config.local.keyId })
          .setIssuer(config.local.issuer)
          .setAudience(PEER_AUDIENCE)
          .setSubject(config.local.daemonId)
          .setIssuedAt()
          .setExpirationTime("30s")
          .setJti(proof.request_id)
          .sign(signingKey);
        if (expired) throw new PeerMessageError("delivery_timeout_outcome_unknown");
        checkSnapshot(proof.source, input.getSource(proof.source.native_session_id));
        await client.sendMessage(proof.target.native_session_id, input.text, {
          ingressAuthorization: `${PREFIX}${input.authorization}:${attestation}`,
        });
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new PeerMessageError("delivery_timeout_outcome_unknown"));
        }, 10000);
      }),
    ]);
    input.logger.info(fields, "message.peer.egress.allow");
    return {
      requestId: proof.request_id,
      targetHost: peer.host,
      targetSession: proof.target.native_session_id,
    };
  } catch (error) {
    input.logger.warn({ ...fields, err: error }, "message.peer.egress.deny_or_unknown");
    throw error;
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}

export async function sendPeerMessage(input: Parameters<typeof deliverPeerMessage>[0]) {
  try {
    return await deliverPeerMessage(input);
  } catch (error) {
    input.logger.warn(
      { err: error, pid: process.pid, grantSha256: messageDigest(input.authorization) },
      "message.peer.egress.deny",
    );
    throw error;
  }
}
