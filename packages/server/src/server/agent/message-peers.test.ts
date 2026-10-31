import { generateKeyPair, exportSPKI, exportPKCS8, SignJWT } from "jose";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import pino from "pino";
import { authorizeMessageIngress, type Binding, type IngressSnapshot } from "./message-ingress.js";
import { messageDigest, sendPeerMessage } from "./message-peers.js";

const env = { ...process.env };
let root: string;
let authority: Awaited<ReturnType<typeof generateKeyPair>>;
let daemon: Awaited<ReturnType<typeof generateKeyPair>>;
let from: Binding;
let to: Binding;
const text = "AGT-880 peer regression";

function snapshot(b: Binding): IngressSnapshot {
  return {
    id: b.native_session_id,
    cwd: b.workspace,
    workspaceId: b.workspace_id,
    labels: { ticket: b.ticket },
    provider: b.provider,
    persistence: { sessionId: b.provider_session_id },
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "agt880-peers-"));
  authority = await generateKeyPair("EdDSA", { extractable: true });
  daemon = await generateKeyPair("EdDSA", { extractable: true });
  process.env.PASEO_HOME = root;
  process.env.AGENTS_INGRESS_HOST = "orange_pi";
  process.env.AGENTS_INGRESS_TRUST_FILE = join(root, "trust.json");
  process.env.AGENTS_PEERS_FILE = join(root, "peers.json");
  writeFileSync(
    process.env.AGENTS_INGRESS_TRUST_FILE,
    JSON.stringify({
      authority: {
        name: "authority",
        issuer: "fixture-authority",
        purposes: ["message"],
        public_key: await exportSPKI(authority.publicKey),
      },
    }),
  );
  const remote = {
    host: "agents_worker",
    daemonId: "worker-test",
    keyId: "worker-key",
    issuer: "fixture-worker",
    publicKey: await exportSPKI(daemon.publicKey),
    url: "wss://relay.paseo.sh/v2/ws?serverId=fixture&role=client",
    daemonPublicKeyB64: "fixture",
  };
  writeFileSync(
    process.env.AGENTS_PEERS_FILE,
    JSON.stringify({
      local: {
        host: "orange_pi",
        daemonId: "orange-test",
        keyId: "orange-key",
        issuer: "fixture-orange",
      },
      peers: { agents_worker: remote },
    }),
  );
  from = {
    identity: "agent:source",
    ticket: "AGT-880",
    host: "agents_worker",
    native_session_id: "source",
    workspace_id: "source-ws",
    workspace: "/test/source",
    provider_session_id: "source-provider",
    provider: "codex",
  };
  to = {
    ...from,
    identity: "agent:target",
    host: "orange_pi",
    native_session_id: "target",
    workspace_id: "target-ws",
    workspace: "/test/target",
    provider_session_id: "target-provider",
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const key of [
    "PASEO_HOME",
    "AGENTS_INGRESS_HOST",
    "AGENTS_INGRESS_TRUST_FILE",
    "AGENTS_PEERS_FILE",
  ]) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
});

async function envelope(
  options: {
    target?: Binding;
    source?: Binding;
    expired?: boolean;
    daemonId?: string;
    spoof?: boolean;
    jti?: string;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const jti = options.jti ?? "peer-request";
  const grant = await new SignJWT({
    source: options.source ?? from,
    target: options.target ?? to,
    purpose: "message",
    message_sha256: messageDigest(text),
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "authority" })
    .setIssuer("fixture-authority")
    .setSubject((options.source ?? from).identity)
    .setAudience("agents-message-ingress/v1")
    .setIssuedAt(now - (options.expired ? 100 : 0))
    .setExpirationTime(now + (options.expired ? -1 : 120))
    .setJti(jti)
    .sign(authority.privateKey);
  const signer = options.spoof ? authority.privateKey : daemon.privateKey;
  const attestation = await new SignJWT({
    source_host: "agents_worker",
    target_host: "orange_pi",
    target_daemon: options.daemonId ?? "orange-test",
    grant_sha256: messageDigest(grant),
    message_sha256: messageDigest(text),
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "worker-key" })
    .setIssuer("fixture-worker")
    .setSubject("worker-test")
    .setAudience("paseo-daemon-message/v1")
    .setIssuedAt(now)
    .setExpirationTime(now + 30)
    .setJti(jti)
    .sign(signer);
  return { grant, authorization: `peer.v1:${grant}:${attestation}` };
}

function request(authorization: string, target = snapshot(to), message = text) {
  return {
    authorization,
    target,
    text: message,
    getSource: () => null,
    channel: "ws",
    nativeMessageId: "message",
    consume: true,
  };
}

it("dostarcza zdalny grant bez lokalnej kopii nadawcy, blokuje replay i zapisuje audyt", async () => {
  const { authorization } = await envelope();
  await expect(authorizeMessageIngress(request(authorization))).resolves.toMatchObject({
    request_id: "peer-request",
  });
  await expect(authorizeMessageIngress(request(authorization))).rejects.toThrow(/already_claimed/);
  const rows = readFileSync(join(root, "message-ingress/audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  expect(rows.map((r) => r.decision)).toEqual(["intent", "deny"]);
  expect(rows[0]).toMatchObject({
    channel: "daemon_peer",
    source_host: "agents_worker",
    host: "orange_pi",
  });
});

it.each([
  ["cross-ticket", { target: () => ({ ...to, ticket: "AGT-881" }) }, /invalid_authorization_scope/],
  ["wrong host", { target: () => ({ ...to, host: "other" }) }, /wrong_daemon_host/],
  ["wrong daemon", { daemonId: "other-daemon" }, /verification_unavailable/],
  ["expired", { expired: true }, /source_authorization_invalid/],
  ["spoof", { spoof: true }, /verification_unavailable/],
] as const)("odmawia %s przed dostarczeniem", async (_name, variant, error) => {
  const options = "target" in variant ? { target: variant.target() } : variant;
  const { authorization } = await envelope(options);
  await expect(authorizeMessageIngress(request(authorization))).rejects.toThrow(error);
});

it("odmawia brak podpisu daemona, brak grantu i zmienioną treść", async () => {
  const { grant, authorization } = await envelope();
  await expect(authorizeMessageIngress(request(grant))).rejects.toThrow(/verification_unavailable/);
  await expect(authorizeMessageIngress(request(""))).rejects.toThrow(
    /source_authorization_missing/,
  );
  await expect(
    authorizeMessageIngress(request(authorization, snapshot(to), "changed")),
  ).rejects.toThrow(/message_binding_mismatch/);
});

it.each(["id", "cwd", "workspaceId", "provider"] as const)(
  "odmawia nieaktualne powiązanie %s",
  async (field) => {
    const { authorization } = await envelope();
    await expect(
      authorizeMessageIngress(request(authorization, { ...snapshot(to), [field]: "changed" })),
    ).rejects.toThrow(/session_binding_mismatch/);
  },
);

it("odmawia nieaktualną sesję providera", async () => {
  const { authorization } = await envelope();
  await expect(
    authorizeMessageIngress(
      request(authorization, { ...snapshot(to), persistence: { sessionId: "changed" } }),
    ),
  ).rejects.toThrow(/session_binding_mismatch/);
});

it("egress odmawia podszytego i nieaktualnego nadawcę przed siecią", async () => {
  const { grant } = await envelope();
  process.env.AGENTS_INGRESS_HOST = "agents_worker";
  const cfg = JSON.parse(readFileSync(process.env.AGENTS_PEERS_FILE!, "utf8"));
  cfg.local = { ...cfg.peers.agents_worker, privateKey: await exportPKCS8(daemon.privateKey) };
  cfg.peers.orange_pi = { ...cfg.local, host: "orange_pi", daemonId: "orange-test" };
  writeFileSync(process.env.AGENTS_PEERS_FILE!, JSON.stringify(cfg));
  const input = {
    authorization: grant,
    text,
    getSource: () => snapshot(from),
    logger: pino({ level: "silent" }),
  };
  await expect(sendPeerMessage({ ...input, callerAgentId: "other" })).rejects.toThrow(
    /source_identity_mismatch/,
  );
  await expect(sendPeerMessage({ ...input, getSource: () => null })).rejects.toThrow(
    /session_binding_mismatch/,
  );
});
