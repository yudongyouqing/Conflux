import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Package metadata is beside both src/ and dist/. */
export const APP_VERSION = (JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string }).version;
