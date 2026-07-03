import type { Project, ProjectDiscoveryOptions } from '../project/types.js';

export type TaskState =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'no-script';

export interface RunOptions {
  /** Scripts to run on each project (e.g. ['github.actions.build', 'github.actions.test']) */
  scripts: string[];
  /** Maximum concurrent tasks. Defaults to unlimited. */
  concurrency?: number;
  /** Stop on first failure, cancelling in-flight tasks. Defaults to false (keep-going). */
  failFast?: boolean;
  /** Working directory to discover projects from. Defaults to process.cwd(). */
  cwd?: string;
  /** Additional environment variables injected into spawned processes. */
  env?: Record<string, string>;
  /**
   * What to do when a project defines none of the target scripts.
   * 'skip' (default): treat as a no-op pass, unblocking dependents.
   * 'error': treat as a failure, skipping dependents.
   */
  missingScript?: 'skip' | 'error';
  /** Maximum bytes of combined stdout+stderr to capture per task. Defaults to 1_000_000 (1 MB). */
  maxOutputBytes?: number;

  /**
   * Called with each chunk of combined stdout+stderr as it is produced by a
   * task, enabling live streaming of output. Independent of the capture limit.
   * When omitted, output is only buffered (and shown for failures).
   */
  onOutput?: (project: Project, chunk: string) => void;

  /**
   * Called after a project becomes ready (all its workspace dependencies have
   * passed) and before its script(s) are run.
   * If this hook throws, the project is marked as failed and afterTask is NOT called.
   */
  beforeTask?: (project: Project) => Promise<void> | void;

  /**
   * Called after the project's script(s) have finished (passed, failed, or
   * cancelled) and its final result has been recorded.
   * Not called when the task had no matching scripts, or was skipped/cancelled
   * before starting.
   * If this hook throws, the result is overridden to 'failed'.
   */
  afterTask?: (project: Project, result: TaskResult) => Promise<void> | void;

  // ----------------------------------------------------------------
  // Test hooks — not for production use
  // ----------------------------------------------------------------
  /** Override project discovery. Injected in unit tests. */
  _discover?: (options: ProjectDiscoveryOptions) => Promise<Project[]>;
  /** Override script execution. Injected in unit tests. */
  _exec?: (
    script: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
    maxOutputBytes: number,
    onChunk?: (chunk: string) => void,
  ) => Promise<{ exitCode: number; output: string; truncated: boolean }>;
}

export interface TaskResult {
  /** Project name (from package.json) */
  project: string;
  /** Absolute path to the project directory */
  projectDir: string;
  /** Scripts that were targeted for this project */
  scripts: string[];
  /** Final state of this task */
  state: TaskState;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** Captured stdout+stderr. Present for all executed tasks (passed, failed, cancelled). */
  output?: string;
  /** True when output was truncated to maxOutputBytes */
  truncated?: boolean;
}

export interface RunSummary {
  passed: TaskResult[];
  failed: TaskResult[];
  skipped: TaskResult[];
  cancelled: TaskResult[];
  noScript: TaskResult[];
}
