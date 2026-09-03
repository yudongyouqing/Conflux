#!/usr/bin/env node
import { buildCli } from "./cli/commands.js";
import { publicError } from "./core/db.js";
import { logger } from "./log.js";

async function main(): Promise<void> {
  const program = buildCli(process.argv);
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  // stderr only — never stdout (stdio MCP server must not touch stdout)
  const mapped = publicError(err);
  logger.error({ err, code: mapped.code }, "command failed");
  process.stderr.write(`${mapped.code}: ${mapped.message}\n`);
  process.exit(1);
});
