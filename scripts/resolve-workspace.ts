import { connectToDaemon } from "../packages/cli/src/utils/client.js";

async function main() {
  const cwd = process.argv[2] || process.cwd();
  const client = await connectToDaemon();
  const result = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
  if (result.workspace) {
    console.log(result.workspace.id);
  } else {
    console.error(result.error || "Failed to create workspace");
    process.exit(1);
  }
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
