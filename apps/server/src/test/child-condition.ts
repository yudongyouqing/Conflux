import type { ChildProcess } from "node:child_process";

/** Startup includes loading the CLI; subsequent updates can use a shorter deadline. */
export function waitForChildCondition(
  child: ChildProcess,
  ready: () => boolean,
  { timeoutMs = 15_000, describe = () => "" }: { timeoutMs?: number; describe?: () => string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", check);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      try {
        if (ready()) finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (error: Error) => finish(error);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(`child exited before readiness (code=${code}, signal=${signal}): ${describe()}`),
      );
    const timer = setTimeout(
      () => finish(new Error(`child readiness timed out after ${timeoutMs}ms: ${describe()}`)),
      timeoutMs,
    );
    child.stdout?.on("data", check);
    child.once("error", onError);
    child.once("close", onClose);
    if (child.exitCode !== null || child.signalCode !== null)
      onClose(child.exitCode, child.signalCode);
    else check();
  });
}
