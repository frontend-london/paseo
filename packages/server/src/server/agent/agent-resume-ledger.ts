import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const RESUME_LEDGER_FILE = "resume-agents.json";

const AgentResumeLedgerSchema = z.object({
  agentIds: z.array(z.string()),
});

export interface AgentResumeLedger {
  agentIds: string[];
}

export function getAgentResumeLedgerPath(paseoHome: string): string {
  return path.join(paseoHome, RESUME_LEDGER_FILE);
}

export async function writeAgentResumeLedger(paseoHome: string, agentIds: string[]): Promise<void> {
  const ledger: AgentResumeLedger = { agentIds };
  await writeJsonFileAtomic(getAgentResumeLedgerPath(paseoHome), ledger);
}

export async function readAgentResumeLedger(paseoHome: string): Promise<string[] | null> {
  const ledgerPath = getAgentResumeLedgerPath(paseoHome);
  try {
    const content = await readFile(ledgerPath, "utf8");
    const parsed = JSON.parse(content);
    const ledger = AgentResumeLedgerSchema.parse(parsed);
    await unlink(ledgerPath).catch(() => undefined);
    return ledger.agentIds;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
