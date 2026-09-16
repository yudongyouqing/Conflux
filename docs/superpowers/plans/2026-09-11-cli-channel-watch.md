# CLI Channel Show and Watch Implementation Plan

> **For AI agents:** Required sub-skill: use `superpowers:executing-plans` to implement this plan task by task. Track progress with the checkboxes below.

**Goal:** Let the Conflux/muiltchat CLI display one persisted conversation edge and continuously print channel changes while runtimes continue working.

**Architecture:** Keep `~/.muiltchat/data.db` as the source of truth. A small CLI-local watcher owns snapshot comparison and polling, while `commands.ts` supplies a local SQLite reader or the existing HTTP edge-history reader. The command tree exposes `channel show <edge-id>` and `channel watch <edge-id>` without writing to Claude Code transcript files.

**Tech Stack:** TypeScript, Commander, Node `node:test`, better-sqlite3, Fastify HTTP endpoint, `tsx`.

---

## File Map

- Create: `apps/server/src/cli/channel-watch.ts` - channel snapshot types, edge-id and interval parsing, stable snapshot fingerprinting, and abortable polling generator.
- Modify: `apps/server/src/cli/commands.ts` - register `channel show` and `channel watch`; bridge local SQLite and `--http` readers to the helper.
- Create: `apps/server/src/test/channel-watch.test.ts` - unit tests for snapshot updates, unchanged polls, reply updates, invalid input, and cancellation.
- Create: `apps/server/src/test/channel-cli.test.ts` - CLI integration tests for local and HTTP `show`, errors, and watcher startup output.
- Modify: `docs/superpowers/specs/2026-09-11-cli-channel-watch-design.md` only if implementation exposes a material mismatch with the approved specification.

### Task 1: Extract Testable Channel Watch Semantics

**Files:**
- Create: `apps/server/src/cli/channel-watch.ts`
- Test: `apps/server/src/test/channel-watch.test.ts`

- [ ] **Step 1: Write the failing tests for parser and change detection**

```ts
function snapshot(question: string, reply: string | null = null): ChannelSnapshot {
  return {
    edge: { id: 1, from: "from", to: "to" },
    messages: [{ id: 1, edge_id: 1, from_session: "from", to_session: "to", question, reply,
      status: reply ? "replied" : "pending", created_at: "2026-09-11T00:00:00.000Z",
      replied_at: reply ? "2026-09-11T00:00:01.000Z" : null }],
  };
}

async function collectSnapshots(snapshots: ChannelSnapshot[]): Promise<ChannelSnapshot[]> {
  const controller = new AbortController();
  let readIndex = 0;
  let waits = 0;
  const read = async () => snapshots[Math.min(readIndex++, snapshots.length - 1)];
  const wait = async () => { if (++waits >= snapshots.length) controller.abort(); };
  const observed: ChannelSnapshot[] = [];
  for await (const item of watchChannelSnapshots(read, { intervalMs: 1, signal: controller.signal, wait })) {
    observed.push(item);
  }
  return observed;
}

test("watch emits the initial snapshot and ignores an unchanged poll", async () => {
  const snapshots = [snapshot("first"), snapshot("first")];
  const observed = await collectSnapshots(snapshots);
  assert.deepEqual(observed.map((item) => item.messages[0].question), ["first"]);
});

test("watch emits when an existing message gains a reply", async () => {
  const snapshots = [snapshot("question", null), snapshot("question", "answer")];
  const observed = await collectSnapshots(snapshots);
  assert.deepEqual(observed.map((item) => item.messages[0].reply), [null, "answer"]);
});

test("parseWatchInterval rejects zero and non-integer values", () => {
  assert.throws(() => parseWatchInterval("0"), /positive integer/);
  assert.throws(() => parseWatchInterval("250.5"), /positive integer/);
});
```

Pass only the `snapshots` argument to `collectSnapshots`; the helper stops the
generator after it has observed the supplied poll count.

- [ ] **Step 2: Run the focused test file and verify it fails because the helper module does not exist**

Run: `npm test -w apps/server -- channel-watch.test.ts`

Expected: FAIL with an import/module-not-found error for `../cli/channel-watch.js`.

- [ ] **Step 3: Implement the minimum pure watcher module**

```ts
export interface ChannelSnapshot {
  edge: { id: number; from: string; to: string };
  messages: Message[];
}

export function parseEdgeId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("edge id must be a positive integer");
  return id;
}

export function parseWatchInterval(raw: string | undefined): number {
  if (raw === undefined) return 1000;
  const interval = Number(raw);
  if (!Number.isSafeInteger(interval) || interval < 1) {
    throw new Error("interval must be a positive integer in milliseconds");
  }
  return interval;
}
```

Add `snapshotFingerprint(snapshot)` based on edge identity plus every message's
`id`, `status`, `question`, `reply`, and `replied_at`. Add an async generator
`watchChannelSnapshots(read, { intervalMs, signal, wait })` that yields the
first snapshot, yields only changed later snapshots, waits through an injected
abort-aware `wait`, and propagates reader errors.

- [ ] **Step 4: Run the focused test file and verify it passes**

Run: `npm test -w apps/server -- channel-watch.test.ts`

Expected: PASS; a reply changing an existing row produces a second snapshot,
but an identical poll produces none.

- [ ] **Step 5: Commit the isolated watcher helper and tests**

```bash
git add apps/server/src/cli/channel-watch.ts apps/server/src/test/channel-watch.test.ts
git commit -m "feat: add channel watch snapshots"
```

### Task 2: Add CLI `channel show` and `channel watch`

**Files:**
- Modify: `apps/server/src/cli/commands.ts`
- Create: `apps/server/src/test/channel-cli.test.ts`
- Reuse: `apps/server/src/core/messages.ts`
- Reuse: `apps/server/src/http/routes/messages.ts`

- [ ] **Step 1: Write failing CLI integration tests**

```ts
async function captureStdout(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => lines.push(String(value));
  try {
    await run();
    return lines.join("\n");
  } finally {
    console.log = originalLog;
  }
}

async function runCli(dataDir: string, args: string[]): Promise<string> {
  return captureStdout(() =>
    buildCli("muiltchat").parseAsync(["node", "muiltchat", "--data-dir", dataDir, ...args]),
  );
}

function runProgram(args: string[]): Promise<void> {
  return buildCli("muiltchat").parseAsync(["node", "muiltchat", ...args]);
}

test("channel show prints one edge in oldest-first order from a local data directory", async () => {
  const output = await runCli(dataDir, ["channel", "show", String(edgeId)]);
  const result = JSON.parse(output) as ChannelSnapshot;
  assert.equal(result.edge.id, edgeId);
  assert.deepEqual(result.messages.map((message) => message.question), ["first", "second"]);
});

test("channel show uses the existing HTTP edge endpoint when --http is set", async () => {
  const output = await runCli(dataDir, ["--http", baseUrl, "channel", "show", String(edgeId)]);
  assert.equal((JSON.parse(output) as ChannelSnapshot).edge.id, edgeId);
});

test("channel show rejects a missing or invalid edge id", async () => {
  await assert.rejects(runProgram(["channel", "show", "0"]), /positive integer/);
  await assert.rejects(runProgram(["channel", "show", "999999"]), /edge not found/);
});
```

The test fixture must create two registered sessions, send two questions on one
edge, and reply to the first question. It must capture `console.log`, restore
it in `finally`, and use a temporary database directory. The HTTP test starts
the existing Fastify server on port `0`, obtains `app.server.address().port`,
and closes the app in `finally`.

- [ ] **Step 2: Run the CLI test file and verify it fails because `channel` is absent**

Run: `npm test -w apps/server -- channel-cli.test.ts`

Expected: FAIL with Commander reporting `unknown command 'channel'`.

- [ ] **Step 3: Register `channel show` with local and HTTP readers**

In `commands.ts`, import `getEdge` and `listEdgeMessages`, plus the new helper
types and parsers. Add a `channel` command group adjacent to `msg`.

```ts
const readChannel = async (edgeId: number, db?: DB): Promise<ChannelSnapshot> => {
  const result = await runOp(
    program,
    () => {
      const localDb = db ?? openDbFrom(o);
      const edge = getEdge(localDb, edgeId);
      if (!edge) throw new Error("edge not found");
      return {
        edge: { id: edge.id, from: edge.from_session, to: edge.to_session },
        messages: listEdgeMessages(localDb, edgeId),
      };
    },
    "GET",
    `/edges/${edgeId}/messages`,
  );
  return normalizeChannelSnapshot(result);
};
```

For `show`, open one local database, read once, and close it in `finally`.
For `watch`, open one local database before constructing `readChannel`, pass
that same handle to every poll, and close it in the command's outer `finally`.
This prevents one SQLite connection and WAL checkpoint timer from being created
per polling interval. The HTTP normalizer accepts the route's
`{ edge: { id, from, to }, messages }` response and rejects a malformed
response. Print one pretty JSON object to stdout.

- [ ] **Step 4: Add `channel watch` using the generator and SIGINT cleanup**

```ts
const controller = new AbortController();
const stop = () => controller.abort();
const db = o.http ? undefined : openDbFrom(o);
process.once("SIGINT", stop);
try {
  for await (const snapshot of watchChannelSnapshots(() => readChannel(edgeId, db), {
    intervalMs: parseWatchInterval(o.interval),
    signal: controller.signal,
  })) {
    console.log(JSON.stringify(snapshot, null, 2));
  }
} finally {
  process.off("SIGINT", stop);
  db?.close();
}
```

Make the watch command default to 1000 ms and reject zero, fractions, and
non-numeric intervals before it starts. It must preserve the show command's
local-or-HTTP selection and let a later missing-edge or HTTP error reach the
existing top-level CLI error handler.

Add a subprocess test that starts `channel watch` against the temporary data
directory with a 10 ms interval, waits for the initial JSON object on stdout,
sends `SIGINT`, and asserts an exit status of `0`. This validates that command
registration, initial output, and cleanup work without making the test depend
on an unbounded watch loop.

- [ ] **Step 5: Run focused CLI tests and the existing message tests**

Run: `npm test -w apps/server -- channel-cli.test.ts messages.test.ts`

Expected: PASS; `show` has identical local and HTTP JSON shape, and existing
message/edge semantics remain unchanged.

- [ ] **Step 6: Commit the command implementation and integration tests**

```bash
git add apps/server/src/cli/commands.ts apps/server/src/test/channel-cli.test.ts
git commit -m "feat: expose channel show and watch commands"
```

### Task 3: Build and End-to-End CLI Verification

**Files:**
- Verify: `apps/server/src/cli/commands.ts`
- Verify: `apps/server/src/cli/channel-watch.ts`
- Verify: `apps/server/src/test/channel-watch.test.ts`
- Verify: `apps/server/src/test/channel-cli.test.ts`

- [ ] **Step 1: Run the complete server test suite**

Run: `npm test -w apps/server`

Expected: PASS with no test failures.

- [ ] **Step 2: Build the server TypeScript output used by installed CLI and hooks**

Run: `npm run build -w apps/server`

Expected: exit code 0 and refreshed `apps/server/dist` output.

- [ ] **Step 3: Smoke-test the compiled CLI against the current channel #26**

Run: `node apps/server/dist/index.js channel show 26`

Expected: JSON with edge id `26`, both session ids, message id `34`, and its
stored question/reply. This command is read-only and does not alter message
status.

- [ ] **Step 4: Review the final diff and commit verification-only documentation changes if needed**

Run: `git diff --check` and `git status --short`

Expected: no whitespace errors and no unstaged/unintended files. If the
approved specification requires a correction discovered during implementation,
commit that documentation correction separately with
`git commit -m "docs: align channel watch specification"`.
