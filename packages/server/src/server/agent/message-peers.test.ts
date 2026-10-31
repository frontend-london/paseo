import { generateKeyPair, exportSPKI, exportPKCS8, SignJWT } from "jose";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { AgentRunState } from "./agent-run-state.js";
import { AgentManager } from "./agent-manager.js";
import { startAgentRun } from "./agent-prompt.js";
import pino from "pino";
import {
  authorizeMessageIngress,
  checkSnapshot,
  type Binding,
  type IngressSnapshot,
} from "./message-ingress.js";
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
  vi.restoreAllMocks();
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
  const { provider: sourceProvider, ...sourceBinding } = options.source ?? from;
  const { provider: targetProvider, ...targetBinding } = options.target ?? to;
  const grant = await new SignJWT({
    source: sourceBinding,
    source_provider: sourceProvider,
    target: targetBinding,
    target_provider: targetProvider,
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

it("REV-001 blokuje źródło unieważnione podczas łączenia", async () => {
  const { grant } = await envelope();
  process.env.AGENTS_INGRESS_HOST = "agents_worker";
  const cfg = JSON.parse(readFileSync(process.env.AGENTS_PEERS_FILE!, "utf8"));
  cfg.local = { ...cfg.peers.agents_worker, privateKey: await exportPKCS8(daemon.privateKey) };
  cfg.peers.orange_pi = { ...cfg.local, host: "orange_pi", daemonId: "orange-test" };
  writeFileSync(process.env.AGENTS_PEERS_FILE!, JSON.stringify(cfg));
  let live: IngressSnapshot | null = snapshot(from);
  // Kontrolowany transport pozwala wymusić zmianę sesji dokładnie podczas await.
  vi.spyOn(DaemonClient.prototype, "connect").mockImplementation(async () => {
    live = null;
  });
  vi.spyOn(DaemonClient.prototype, "fetchAgents").mockResolvedValue({
    requestId: "fixture",
    entries: [],
    pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
  });
  vi.spyOn(DaemonClient.prototype, "close").mockResolvedValue();
  const send = vi.spyOn(DaemonClient.prototype, "sendMessage").mockResolvedValue();
  await expect(
    sendPeerMessage({
      authorization: grant,
      text,
      getSource: () => live,
      logger: pino({ level: "silent" }),
    }),
  ).rejects.toThrow(/session_binding_mismatch/);
  expect(send).not.toHaveBeenCalled();
});

it.each(["ticket", "provider-session"] as const)(
  "REV-002 blokuje zmieniony cel %s podczas kryptografii",
  async (field) => {
    const { authorization } = await envelope();
    const logger = pino({ level: "silent" });
    const manager = new AgentManager({ clients: {}, logger });
    const live = snapshot(to);
    Reflect.set(manager, "getAgent", () => ({ ...live }));
    const outOfBand = vi.fn(() => true);
    Reflect.set(manager, "tryRunOutOfBand", outOfBand);
    const pending = startAgentRun(manager, to.native_session_id, text, logger, {
      ingressAuthorization: authorization,
    });
    if (field === "ticket") live.labels = { ticket: "AGT-OTHER" };
    else live.persistence = { sessionId: "changed" };
    await expect(pending).rejects.toThrow(/session_binding_mismatch/);
    expect(outOfBand).not.toHaveBeenCalled();
  },
);

it("REV-003 blokuje retarget podczas anulowania aktywnego turnu", async () => {
  const { authorization } = await envelope();
  const logger = pino({ level: "silent" });
  const manager = new AgentManager({ clients: {}, logger });
  const startTurn = vi.fn();
  const live = {
    ...snapshot(to),
    session: { startTurn },
    lifecycle: "running",
    updatedAt: new Date(),
    activeForegroundTurnId: "old-turn",
  };
  Reflect.set(manager, "agents", new Map([[to.native_session_id, live]]));
  Reflect.set(manager, "getAgent", () => ({ ...live }));
  Reflect.set(manager, "requireAgent", () => live);
  Reflect.set(manager, "requireSessionAgent", () => live);
  Reflect.set(manager, "emitState", () => {});
  Reflect.set(manager, "tryRunOutOfBand", () => false);
  Reflect.set(manager, "hasInFlightRun", () => true);
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  Reflect.set(manager, "cancelAgentRun", async () => {
    entered();
    await releasePromise;
    Reflect.set(live, "activeForegroundTurnId", null);
    return { status: "settled" };
  });
  const pending = startAgentRun(manager, to.native_session_id, text, logger, {
    ingressAuthorization: authorization,
    replaceRunning: true,
  });
  await enteredPromise;
  live.labels = { ticket: "AGT-OTHER" };
  release();
  await expect(pending).rejects.toThrow(/session_binding_mismatch/);
  expect(startTurn).not.toHaveBeenCalled();
  expect(live.lifecycle).toBe("idle");
  expect(Reflect.get(live, "pendingReplacement")).toBe(false);
});

it("guard blokuje zmianę celu po utworzeniu iteratora, bez zapisu historii błędu", async () => {
  const logger = pino({ level: "silent" });
  const manager = new AgentManager({ clients: {}, logger });
  const startTurn = vi.fn();
  const live = {
    ...snapshot(to),
    session: { startTurn },
    lifecycle: "running",
    pendingReplacement: true,
    updatedAt: new Date(),
    activeForegroundTurnId: null,
  };
  Reflect.set(manager, "agents", new Map([[to.native_session_id, live]]));
  Reflect.set(manager, "getAgent", () => ({ ...live }));
  Reflect.set(manager, "requireSessionAgent", () => live);
  const emit = vi.fn();
  Reflect.set(manager, "dispatchStream", emit);
  Reflect.set(manager, "emitState", vi.fn());
  const iterator = manager.streamAgent(to.native_session_id, text, {
    beforeDispatch: () => checkSnapshot(to, manager.getAgent(to.native_session_id)),
  });
  live.labels = { ticket: "AGT-OTHER" };
  await expect(iterator.next()).rejects.toThrow(/session_binding_mismatch/);
  expect(startTurn).not.toHaveBeenCalled();
  expect(live.lifecycle).toBe("idle");
  expect(Reflect.get(live, "pendingReplacement")).toBe(false);
  expect(emit).not.toHaveBeenCalled();
});

it("REV-005 czyści niedoszłą wymianę po odmowie anulowania starego runu", async () => {
  const manager = new AgentManager({ clients: {}, logger: pino({ level: "silent" }) });
  const runs = new AgentRunState();
  const live = {
    ...snapshot(to),
    session: { describePersistence: () => null },
    lifecycle: "running",
    updatedAt: new Date(),
    activeForegroundTurnId: "old-turn",
    activeTurnId: "old-turn",
    pendingReplacement: false,
    finalizedForegroundTurnIds: new Set<string>(),
  };
  Reflect.set(manager, "agents", new Map([[to.native_session_id, live]]));
  Reflect.set(manager, "runs", runs);
  Reflect.set(manager, "requireAgent", () => live);
  Reflect.set(manager, "requireSessionAgent", () => live);
  Reflect.set(manager, "emitState", vi.fn());
  Reflect.set(manager, "cancelAgentRun", async () => ({ status: "refused", reason: "fixture" }));
  runs.trackAutonomousRun(to.native_session_id, "old-turn");
  await expect(manager.replaceAgentRun(to.native_session_id, text)).rejects.toThrow();
  expect(live.pendingReplacement).toBe(false);
  expect(live.lifecycle).toBe("running");
  runs.settleTerminalRun(to.native_session_id, "old-turn");
  Reflect.set(live, "activeForegroundTurnId", null);
  Reflect.get(manager, "finalizeForegroundTurn").call(manager, live);
  expect(live.lifecycle).toBe("idle");
  expect(live.pendingReplacement).toBe(false);
});
