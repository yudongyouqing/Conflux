import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MIGRATION_MARKER_FILENAME = ".conflux-migration.json";
export const MIGRATION_TEMP_PREFIX = ".conflux-migration-";

// Keep migration bounded to files owned by the current SQLite store. Config
// values live in the app_settings table, so there is no config sidecar to copy.
export const MIGRATION_FILE_NAMES = [
  "data.db",
  "data.db-wal",
  "data.db-shm",
] as const;

export interface DataHomeOptions {
  /** Explicit --data-dir/override value. */
  override?: string;
  /** Process-like environment used by callers and tests. */
  env?: NodeJS.ProcessEnv;
  /** Optional project root; otherwise CLAUDE_PROJECT_DIR is read from env. */
  projectDir?: string;
  /** Injectable home directory for deterministic resolution tests. */
  homeDir?: string;
  /** Preserve the existing explicit project-scope behavior. */
  scope?: "project" | "global";
}

export interface MigrationMarker {
  version: 1;
  source: string;
  destination: string;
  copied_at: string;
  source_preserved: true;
}

export interface MigrationDependencies {
  /** Checkpoint the source database before files are copied. */
  checkpoint?: (dbPath: string) => void;
  /** Injectable file copy used while staging a migration. */
  copyFile?: (source: string, destination: string) => void;
  /** Injectable marker writer used while staging a migration. */
  writeMarker?: (markerPath: string, marker: MigrationMarker) => void;
}

export interface MigrateDataDirOptions extends MigrationDependencies {
  from: string;
  to: string;
  now?: () => string;
}

export interface MigrationResult {
  status: "migrated" | "conflict";
  source: string;
  destination: string;
  copied: string[];
  conflicts: string[];
  sourcePreserved: true;
  marker?: MigrationMarker;
}

export interface MigrationStatus {
  status: "migrated" | "not-migrated" | "invalid";
  destination: string;
  marker: MigrationMarker | null;
}

/**
 * Resolve a data directory without creating it.
 *
 * The legacy ~/.muiltchat fallback is intentional: merely upgrading the CLI
 * must not create ~/.conflux or move the user's existing data.
 */
export function resolveDataHome(options: DataHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const explicit = nonEmpty(options.override);
  if (explicit) return resolve(explicit);

  const confluxHome = nonEmpty(env.CONFLUX_HOME);
  if (confluxHome) return resolve(confluxHome);

  const legacyHome = nonEmpty(env.MUILTCHAT_HOME);
  if (legacyHome) return resolve(legacyHome);

  const projectDir = nonEmpty(options.projectDir) ?? nonEmpty(env.CLAUDE_PROJECT_DIR);
  if (projectDir) {
    const projectHome = resolve(join(projectDir, ".muiltchat"));
    if (options.scope === "project" || existsSync(projectHome)) return projectHome;
  }

  return resolve(join(options.homeDir ?? homedir(), ".muiltchat"));
}

/**
 * Copy a legacy data directory into a new location without deleting or
 * overwriting either side. The destination is staged before it is committed.
 */
export function migrateDataDir(options: MigrateDataDirOptions): MigrationResult {
  const source = resolveRequiredPath(options.from, "source");
  const destination = resolveRequiredPath(options.to, "destination");
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`migration source is not a directory: ${source}`);
  }
  if (isSameOrChild(source, destination)) {
    throw new Error(`migration destination must not be inside the source: ${destination}`);
  }
  if (existsSync(destination) && !statSync(destination).isDirectory()) {
    throw new Error(`migration destination is not a directory: ${destination}`);
  }

  const initialFiles = listMigrationFiles(source);
  if (initialFiles.length === 0) {
    throw new Error(`migration source contains no supported data files: ${source}`);
  }

  const destinationExists = existsSync(destination);
  const conflicts = initialFiles.filter((file) =>
    existsSync(join(destination, file))
  );
  if (existsSync(join(destination, MIGRATION_MARKER_FILENAME))) {
    conflicts.push(MIGRATION_MARKER_FILENAME);
  }
  if (conflicts.length > 0) {
    return {
      status: "conflict",
      source,
      destination,
      copied: [],
      conflicts,
      sourcePreserved: true,
    };
  }

  const checkpoint = options.checkpoint ?? checkpointSqlite;
  if (existsSync(join(source, "data.db"))) checkpoint(join(source, "data.db"));

  // SQLite may remove an empty WAL/SHM pair while checkpointing. Snapshot the
  // files again after checkpoint so a normal migration does not fail because
  // SQLite cleaned up its own sidecars.
  const files = listMigrationFiles(source);
  if (files.length === 0) {
    throw new Error(`migration source contains no supported data files after checkpoint: ${source}`);
  }

  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const tempDir = mkdtempSync(join(parent, `${MIGRATION_TEMP_PREFIX}${basename(destination)}-`));
  let staged = tempDir;
  const createdDestinationFiles: string[] = [];

  const copy = options.copyFile ?? ((from: string, to: string) => {
    copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
  });
  const writeMarker = options.writeMarker ?? ((markerPath: string, marker: MigrationMarker) => {
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  });

  try {
    for (const file of files) {
      copy(join(source, file), join(tempDir, file));
    }

    const marker: MigrationMarker = {
      version: 1,
      source,
      destination,
      copied_at: options.now?.() ?? new Date().toISOString(),
      source_preserved: true,
    };
    writeMarker(join(tempDir, MIGRATION_MARKER_FILENAME), marker);

    if (!destinationExists) {
      renameSync(tempDir, destination);
      staged = "";
    } else {
      for (const file of files) {
        const target = join(destination, file);
        copyFileSync(join(tempDir, file), target, fsConstants.COPYFILE_EXCL);
        createdDestinationFiles.push(target);
      }
      const markerPath = join(destination, MIGRATION_MARKER_FILENAME);
      copyFileSync(
        join(tempDir, MIGRATION_MARKER_FILENAME),
        markerPath,
        fsConstants.COPYFILE_EXCL
      );
      createdDestinationFiles.push(markerPath);
      rmSync(tempDir, { recursive: true, force: true });
      staged = "";
    }

    return {
      status: "migrated",
      source,
      destination,
      copied: [...files],
      conflicts: [],
      sourcePreserved: true,
      marker,
    };
  } catch (error) {
    if (staged) rmSync(staged, { recursive: true, force: true });
    for (const file of createdDestinationFiles) rmSync(file, { force: true });
    throw error;
  }
}

export function readMigrationStatus(destination: string): MigrationStatus {
  const resolvedDestination = resolveRequiredPath(destination, "destination");
  const markerPath = join(resolvedDestination, MIGRATION_MARKER_FILENAME);
  if (!existsSync(markerPath)) {
    return { status: "not-migrated", destination: resolvedDestination, marker: null };
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
    if (!isMigrationMarker(parsed)) {
      return { status: "invalid", destination: resolvedDestination, marker: null };
    }
    return { status: "migrated", destination: resolvedDestination, marker: parsed };
  } catch {
    return { status: "invalid", destination: resolvedDestination, marker: null };
  }
}

function checkpointSqlite(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function listMigrationFiles(source: string): string[] {
  return MIGRATION_FILE_NAMES.filter((file) => existsSync(join(source, file)));
}

function resolveRequiredPath(value: string, label: string): string {
  if (!value || value.trim().length === 0) throw new Error(`migration ${label} is required`);
  return resolve(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isSameOrChild(parent: string, candidate: string): boolean {
  const childPath = relative(parent, candidate);
  return (
    childPath === "" ||
    (!childPath.startsWith(`..${requirePathSeparator()}`) &&
      childPath !== ".." &&
      !isAbsolute(childPath))
  );
}

function requirePathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function isMigrationMarker(value: unknown): value is MigrationMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return (
    marker.version === 1 &&
    typeof marker.source === "string" &&
    typeof marker.destination === "string" &&
    typeof marker.copied_at === "string" &&
    marker.source_preserved === true
  );
}
