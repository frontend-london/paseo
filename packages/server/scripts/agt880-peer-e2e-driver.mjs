import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateKeyPair, exportPKCS8, exportSPKI, importPKCS8, SignJWT } from "jose";
import { createHash } from "node:crypto";
import { DaemonClient } from "../src/server/test-utils/daemon-client.js";
import { generateLocalPairingOffer } from "../src/server/pairing-offer.js";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const home = process.env.PASEO_HOME;
const root = dirname(home);
const host = process.env.AGENTS_INGRESS_HOST;
const port = Number(process.env.AGT880_PORT);
const mode = process.argv[2];
const file = (name) => join(root, name);
const read = (name) => JSON.parse(readFileSync(file(name), "utf8"));
function save(name, value) {
  writeFileSync(file(name), JSON.stringify(value, null, 2), { mode: 384 });
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
if (mode === "prepare") {
  mkdirSync(home, { recursive: true, mode: 448 });
  mkdirSync(file("workspace"), { recursive: true, mode: 448 });
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  const authority = await generateKeyPair("EdDSA", { extractable: true });
  const local = {
    host,
    daemonId: `agt880-test-${host}`,
    keyId: `agt880-${host}`,
    issuer: `agt880-test-${host}`,
  };
  save("identity-private.json", { ...local, privateKey: await exportPKCS8(pair.privateKey) });
  save("authority-private.json", { privateKey: await exportPKCS8(authority.privateKey) });
  save("trust.json", {
    authority: {
      name: "agt880-e2e",
      issuer: "agt880-e2e-authority",
      purposes: ["message"],
      public_key: await exportSPKI(authority.publicKey),
    },
  });
  const offerResult = await generateLocalPairingOffer({
    paseoHome: home,
    relayEnabled: true,
    relayEndpoint: "relay.paseo.sh:443",
    relayUseTls: true,
    includeQr: false,
  });
  const offer = parseConnectionOfferFromUrl(offerResult.url);
  if (!offer) throw new Error("No relay offer");
  save("peer-public.json", {
    ...local,
    publicKey: await exportSPKI(pair.publicKey),
    daemonPublicKeyB64: offer.daemonPublicKeyB64,
    url: buildRelayWebSocketUrl({
      endpoint: offer.relay.endpoint,
      useTls: true,
      serverId: offer.serverId,
      role: "client",
    }),
  });
  save("peers.json", { local: read("identity-private.json"), peers: {} });
  console.log(JSON.stringify({ prepared: true, host, home, daemonId: local.daemonId }));
} else if (mode === "route") {
  const peer = read("remote-public.json");
  save("peers.json", { local: read("identity-private.json"), peers: { [peer.host]: peer } });
  console.log(JSON.stringify({ route: peer.host, transport: "paseo-relay-e2ee" }));
} else if (mode === "send") {
  const input = read(process.argv[3] ?? "send.json");
  const client = new Client({ name: "agt880-e2e-controller", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/agents`)),
  );
  try {
    const result = await client.callTool({ name: "send_peer_message", arguments: input });
    console.log(JSON.stringify(result));
  } finally {
    await client.close();
  }
} else if (mode === "mint") {
  const input = read(process.argv[3] ?? "mint.json");
  const from = read("sessions.json").A;
  const targets = read("remote-sessions.json");
  const to = targets[input.target ?? "A"];
  const binding = (s) => ({
    identity: `agent:${s.id}`,
    ticket: s.labels.ticket,
    host: s.host,
    native_session_id: s.id,
    workspace_id: s.workspaceId,
    workspace: s.cwd,
    provider_session_id: s.persistence?.sessionId ?? s.runtimeInfo?.sessionId,
    provider: s.provider,
  });
  const source = { ...binding(from), ...input.sourceOverride };
  const target = { ...binding(to), ...input.targetOverride };
  const now = Math.floor(Date.now() / 1e3);
  const authorization = await new SignJWT({
    source,
    target,
    purpose: "message",
    message_sha256: digest(input.text),
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "authority" })
    .setIssuer("agt880-e2e-authority")
    .setAudience("agents-message-ingress/v1")
    .setSubject(source.identity)
    .setIssuedAt(now + (input.expired ? -100 : 0))
    .setExpirationTime(now + (input.expired ? -1 : 180))
    .setJti(input.requestId)
    .sign(await importPKCS8(read("authority-private.json").privateKey, "EdDSA"));
  save(input.output ?? "send.json", { authorization, text: input.text });
  console.log(
    JSON.stringify({
      requestId: input.requestId,
      source,
      target,
      messageSha256: digest(input.text),
    }),
  );
} else {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    appVersion: "0.9.2",
    reconnect: { enabled: false },
  });
  await client.connect();
  await client.fetchAgents();
  try {
    if (mode === "init") {
      if (existsSync(file("sessions.json"))) throw new Error("Sessions already initialized");
      const sessions = {};
      for (const name of host === "agents_worker" ? ["A"] : ["A", "B"]) {
        const agent = await client.createAgent({
          provider: "codex",
          cwd: file("workspace"),
          labels: { ticket: name === "B" ? "AGT-880-ISOLATION-B" : "AGT-880" },
          config: { modeId: "full-access" },
          initialPrompt: "Reply exactly: AGT880_FIXTURE_READY. Do not use tools.",
        });
        await client.waitForFinish(agent.id, 12e4);
        const listing = await client.fetchAgents();
        const updated = listing.entries.find((entry) => entry.id === agent.id);
        sessions[name] = { ...agent, ...updated, host };
      }
      save("sessions.json", sessions);
      console.log(JSON.stringify(sessions));
    } else if (mode === "snapshot") {
      const sessions = read("sessions.json");
      const output = {};
      for (const [name, session] of Object.entries(sessions)) {
        const id = session.id;
        const timeline = await client.fetchAgentTimeline(id, {
          direction: "tail",
          limit: 0,
          projection: "canonical",
        });
        const listing = await client.fetchAgents();
        output[name] = { snapshot: listing.entries.find((entry) => entry.id === id), timeline };
      }
      save(process.argv[3] ?? "snapshot.json", output);
      console.log(JSON.stringify(output));
    } else throw new Error(`Unknown mode ${mode}`);
  } finally {
    await client.close();
  }
}
