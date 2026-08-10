import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { runInventorySessionsCommand } from "./inventory.js";

describe("runInventorySessionsCommand", () => {
  it.each([0, Number.NaN, 1.5, 201])(
    "rejects invalid --limit %s before connecting",
    async (limit) => {
      await expect(
        runInventorySessionsCommand({ limit, json: true }, new Command()),
      ).rejects.toMatchObject({
        code: "INVALID_INVENTORY_LIMIT",
        message: "--limit must be an integer between 1 and 200",
      });
    },
  );
});
