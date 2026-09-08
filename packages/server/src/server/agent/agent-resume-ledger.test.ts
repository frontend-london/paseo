import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  getAgentResumeLedgerPath,
  readAgentResumeLedger,
  writeAgentResumeLedger,
} from "./agent-resume-ledger.js";

describe("agent resume ledger", () => {
  test("writes and reads a list of agent ids", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-resume-ledger-"));

    try {
      const agentIds = ["agent-a", "agent-b", "agent-c"];
      await writeAgentResumeLedger(paseoHome, agentIds);

      const read = await readAgentResumeLedger(paseoHome);
      expect(read).toEqual(agentIds);

      const ledgerPath = getAgentResumeLedgerPath(paseoHome);
      await expect(stat(ledgerPath)).rejects.toThrow();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("returns null when no ledger exists", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-resume-ledger-missing-"));

    try {
      const read = await readAgentResumeLedger(paseoHome);
      expect(read).toBeNull();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("ignores unknown extra fields in the ledger file", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-resume-ledger-extra-"));

    try {
      const ledgerPath = getAgentResumeLedgerPath(paseoHome);
      const ledger = { agentIds: ["agent-x"], extra: true };
      await rm(ledgerPath, { force: true }).catch(() => undefined);
      await writeAgentResumeLedger(paseoHome, ledger.agentIds);

      const read = await readAgentResumeLedger(paseoHome);
      expect(read).toEqual(["agent-x"]);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });
});
