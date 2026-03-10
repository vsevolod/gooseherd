import type { NewRunInput, RunRecord } from "../types.js";

/**
 * Interface for enqueuing pipeline runs.
 *
 * The observer depends on this interface instead of the full RunManager,
 * allowing the orchestrator or other components to intercept and add
 * intelligence to the run creation path.
 */
export interface RunEnqueuer {
  enqueueRun(input: NewRunInput): Promise<RunRecord>;
  onRunTerminal(cb: (runId: string, status: string) => void): void;
  /** Look up a run by ID (used by the learning store to gather outcome details). */
  findRun?(id: string): Promise<RunRecord | undefined>;
}
