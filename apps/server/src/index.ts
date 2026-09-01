#!/usr/bin/env node
import { buildCli } from "./cli/commands.js";

async function main(): Promise<void> {
  const program = buildCli(process.argv);
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  // stderr only — never stdout (stdio MCP server must not touch stdout)
  process.stderr.write(
    err instanceof Error ? `${err.stack ?? err.message}\n` : `${String(err)}\n`
  );
  process.exit(1);
});
