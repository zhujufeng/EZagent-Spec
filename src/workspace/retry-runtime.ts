import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

export interface WorkspaceInitializeRetryRuntime {
  now(): number;
  wait(durationMs: number, signal: AbortSignal | undefined): Promise<void>;
}

// Internal seam: production uses monotonic time; repository tests replace only these two operations.
export const workspaceInitializeRetryRuntime: WorkspaceInitializeRetryRuntime = {
  now: () => performance.now(),
  wait: async (durationMs, signal) => {
    if (signal === undefined) {
      await delay(durationMs);
    } else {
      await delay(durationMs, undefined, { signal });
    }
  },
};
