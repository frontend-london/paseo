#!/usr/bin/env npx tsx

import assert from "node:assert";
import { getErrorMessage } from "../src/utils/errors.js";

console.log("=== Error Utils ===\n");

{
  console.log("Test 1: returns Error.message for Error instances");
  assert.strictEqual(getErrorMessage(new Error("boom")), "boom");
  console.log("✓ returns Error.message\n");
}

{
  console.log("Test 2: stringifies non-Error values");
  assert.strictEqual(getErrorMessage("plain string"), "plain string");
  assert.strictEqual(getErrorMessage(42), "42");
  assert.strictEqual(getErrorMessage(null), "null");
  console.log("✓ stringifies non-Error values\n");
}

{
  console.log("Test 3: extracts message from plain RPC objects");
  assert.strictEqual(
    getErrorMessage({
      type: "Object",
      message: '"Method not found": session/set_mode',
      code: -32601,
    }),
    '"Method not found": session/set_mode',
  );
  assert.notStrictEqual(
    getErrorMessage({ message: "rpc failed" }),
    "[object Object]",
  );
  console.log("✓ extracts plain-object message\n");
}

console.log("=== All error utility tests passed ===");
