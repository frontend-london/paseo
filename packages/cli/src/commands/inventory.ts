import { Command } from "commander";
import { connectToDaemon } from "../utils/client.js";
import type { CommandError, CommandOptions, OutputSchema, SingleResult } from "../output/index.js";
import { addJsonAndDaemonHostOptions } from "../utils/command-options.js";
import { withOutput } from "../output/index.js";

interface InventorySessionsOptions extends CommandOptions {
  host?: string;
  snapshotId?: string;
  cursor?: string;
  limit?: number;
}

interface InventoryPageOutput {
  schema_version: string;
  snapshot_id: string;
  entries: Array<Record<string, unknown>>;
  next_cursor: string | null;
  has_more: boolean;
}

const inventoryPageSchema: OutputSchema<InventoryPageOutput> = {
  idField: "snapshot_id",
  columns: [
    { header: "SNAPSHOT", field: "snapshot_id" },
    { header: "ENTRIES", field: (page) => page.entries.length },
    { header: "HAS MORE", field: "has_more" },
  ],
  serialize: (page) => page,
};

export function createInventoryCommand(): Command {
  const inventory = new Command("inventory").description("Read-only daemon inventory operations");
  addJsonAndDaemonHostOptions(
    inventory
      .command("sessions")
      .description("Read one immutable page of the complete Paseo session inventory")
      .option("--snapshot-id <snapshot_id>", "Snapshot id returned by the preceding page")
      .option("--cursor <cursor>", "Cursor returned by the preceding page")
      .option("--limit <count>", "Page size (1-200)", Number.parseInt),
  ).action(withOutput(runInventorySessionsCommand));
  return inventory;
}

export async function runInventorySessionsCommand(
  options: InventorySessionsOptions,
  _command: Command,
): Promise<SingleResult<InventoryPageOutput>> {
  const client = await connectToDaemon({ host: options.host });
  try {
    const page = await client.inventorySessions({
      ...(options.snapshotId !== undefined ? { snapshot_id: options.snapshotId } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
    await client.close();
    const { requestId: _requestId, ...data } = page;
    return { type: "single", data, schema: inventoryPageSchema };
  } catch (error) {
    await client.close().catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    const commandError: CommandError = {
      code: "INVENTORY_SESSIONS_FAILED",
      message: `Failed to read Paseo inventory: ${message}`,
    };
    throw commandError;
  }
}
