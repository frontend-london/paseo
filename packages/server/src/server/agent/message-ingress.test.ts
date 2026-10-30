import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { authorizeMessageIngress, type IngressSnapshot } from "./message-ingress.js";

const oldEnv = {
  PASEO_HOME: process.env.PASEO_HOME,
  AGENTS_INGRESS_HOST: process.env.AGENTS_INGRESS_HOST,
  AGENTS_INGRESS_TRUST_FILE: process.env.AGENTS_INGRESS_TRUST_FILE,
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it("AGT-880 verifies source and target binding, rejects cross-ticket, wrong host and replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "agt-880-native-"));
  roots.push(root);
  process.env.PASEO_HOME = root;
  process.env.AGENTS_INGRESS_HOST = "agents_worker";
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const issuer = "agt-880-hermetic";
  const trustFile = join(root, "trust.json");
  writeFileSync(
    trustFile,
    JSON.stringify({
      test: {
        name: "test",
        issuer,
        public_key: await exportSPKI(publicKey),
        purposes: ["message"],
      },
    }),
  );
  process.env.AGENTS_INGRESS_TRUST_FILE = trustFile;
  const binding = (ticket: string, host: string, id: string) => ({
    identity: "agent:" + id,
    ticket,
    host,
    native_session_id: id,
    workspace_id: "ws-" + id,
    workspace: "/test/" + id,
    provider_session_id: "provider-" + id,
  });
  const source = binding("AGT-101", "agents_worker", "source-session");
  const target = binding("AGT-101", "agents_worker", "target-session");
  const snapshot = (value: typeof target): IngressSnapshot => ({
    id: value.native_session_id,
    labels: { ticket: value.ticket },
    cwd: value.workspace,
    workspaceId: value.workspace_id,
    persistence: { sessionId: value.provider_session_id },
  });
  const makeToken = async (from: typeof source, to: typeof target, jti: string) =>
    new SignJWT({ source: from, target: to, purpose: "message" })
      .setProtectedHeader({ alg: "EdDSA", kid: "test" })
      .setIssuer(issuer)
      .setAudience("agents-message-ingress/v1")
      .setSubject(from.identity)
      .setIssuedAt()
      .setExpirationTime("2m")
      .setJti(jti)
      .sign(privateKey);
  const req = (authorization: string, to = target, caller = source.native_session_id) => ({
    authorization,
    target: snapshot(to),
    callerAgentId: caller,
    getSource: (id: string) => (id === source.native_session_id ? snapshot(source) : null),
    channel: "cli",
    nativeMessageId: "test-native",
    consume: true,
  });
  const valid = await makeToken(source, target, "valid");
  await expect(authorizeMessageIngress(req(valid))).resolves.toMatchObject({
    source: { ticket: "AGT-101" },
    target: { ticket: "AGT-101" },
  });
  await expect(authorizeMessageIngress(req(valid))).rejects.toThrow(/request_already_claimed/);
  const cross = binding("AGT-202", "agents_worker", target.native_session_id);
  await expect(
    authorizeMessageIngress(req(await makeToken(source, cross, "cross"), cross)),
  ).rejects.toThrow(/invalid_authorization_scope/);
  const remote = binding("AGT-101", "orange_pi", target.native_session_id);
  await expect(
    authorizeMessageIngress(req(await makeToken(source, remote, "remote"), remote)),
  ).rejects.toThrow(/wrong_daemon_host/);
  await expect(
    authorizeMessageIngress(
      req(await makeToken(source, target, "spoof"), target, "not-the-source"),
    ),
  ).rejects.toThrow(/source_identity_mismatch/);
  await expect(authorizeMessageIngress(req(""))).rejects.toThrow(/source_authorization_missing/);
});
