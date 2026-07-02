import { describe, it, expect } from 'vitest';
import { runScripts } from './scheduler.js';
import type { RunOptions } from './types.js';
import type { Project } from '../project/types.js';

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function makeProject(
  name: string,
  deps: string[] = [],
  scripts: Record<string, string> = { test: 'ok' },
): Project {
  return {
    name,
    packageJsonPath: `/fake/${name}/package.json`,
    directory: `/fake/${name}`,
    packageJson: {
      name,
      scripts,
      dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])),
    },
  };
}

type MockExecResult = { exitCode: number; output: string; truncated: boolean };
type MockExecFn = (
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  maxOutputBytes: number,
) => Promise<MockExecResult>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseOptions(
  projects: Project[],
  execFn: MockExecFn,
  overrides: Partial<RunOptions> = {},
): RunOptions {
  return {
    scripts: ['test'],
    _discover: async () => projects,
    _exec: execFn,
    ...overrides,
  };
}

// ----------------------------------------------------------------
// Diamond dependency ordering
// ----------------------------------------------------------------

describe('runScripts: diamond ordering', () => {
  it('D starts only after both B and C have completed', async () => {
    // Graph: A → B → D
    //              ↗
    //        A → C
    const projects = [
      makeProject('pkg-a'),
      makeProject('pkg-b', ['pkg-a']),
      makeProject('pkg-c', ['pkg-a']),
      makeProject('pkg-d', ['pkg-b', 'pkg-c']),
    ];

    const completions: string[] = [];
    const execFn: MockExecFn = async (_script, _cwd, env) => {
      await delay(5);
      completions.push(env.PROJECT_NAME!);
      return { exitCode: 0, output: '', truncated: false };
    };

    const summary = await runScripts(baseOptions(projects, execFn));

    expect(summary.failed).toHaveLength(0);
    expect(summary.passed).toHaveLength(4);

    const dPos = completions.indexOf('pkg-d');
    const bPos = completions.indexOf('pkg-b');
    const cPos = completions.indexOf('pkg-c');
    const aPos = completions.indexOf('pkg-a');

    expect(aPos).toBeLessThan(bPos);
    expect(aPos).toBeLessThan(cPos);
    expect(bPos).toBeLessThan(dPos);
    expect(cPos).toBeLessThan(dPos);
  });
});

// ----------------------------------------------------------------
// Failure → dependent skip propagation
// ----------------------------------------------------------------

describe('runScripts: failure propagation', () => {
  it('skips direct dependents when a task fails', async () => {
    const projects = [
      makeProject('pkg-a'),
      makeProject('pkg-b', ['pkg-a']),
    ];

    const execFn: MockExecFn = async (_script, _cwd, env) => {
      if (env.PROJECT_NAME === 'pkg-a') return { exitCode: 1, output: 'a failed', truncated: false };
      return { exitCode: 0, output: '', truncated: false };
    };

    const summary = await runScripts(baseOptions(projects, execFn));

    expect(summary.failed.map((t) => t.project)).toEqual(['pkg-a']);
    expect(summary.skipped.map((t) => t.project)).toEqual(['pkg-b']);
    expect(summary.passed).toHaveLength(0);
  });

  it('skips transitive dependents (A→B→C, A fails)', async () => {
    const projects = [
      makeProject('pkg-a'),
      makeProject('pkg-b', ['pkg-a']),
      makeProject('pkg-c', ['pkg-b']),
    ];

    const execFn: MockExecFn = async (_script, _cwd, env) => {
      if (env.PROJECT_NAME === 'pkg-a') return { exitCode: 1, output: 'a failed', truncated: false };
      return { exitCode: 0, output: '', truncated: false };
    };

    const summary = await runScripts(baseOptions(projects, execFn));

    expect(summary.failed.map((t) => t.project)).toEqual(['pkg-a']);
    expect(summary.skipped.map((t) => t.project)).toContain('pkg-b');
    expect(summary.skipped.map((t) => t.project)).toContain('pkg-c');
  });

  it('continues running independent tasks after a failure', async () => {
    // A and B are independent. A fails. B should still run.
    const projects = [
      makeProject('pkg-a'),
      makeProject('pkg-b'),
    ];

    const execFn: MockExecFn = async (_script, _cwd, env) => {
      if (env.PROJECT_NAME === 'pkg-a') return { exitCode: 1, output: '', truncated: false };
      return { exitCode: 0, output: '', truncated: false };
    };

    const summary = await runScripts(baseOptions(projects, execFn));

    expect(summary.failed.map((t) => t.project)).toEqual(['pkg-a']);
    expect(summary.passed.map((t) => t.project)).toEqual(['pkg-b']);
  });
});

// ----------------------------------------------------------------
// Fail-fast
// ----------------------------------------------------------------

describe('runScripts: fail-fast', () => {
  it('cancels in-flight tasks and skips pending when a task fails', async () => {
    // A: fails immediately
    // B: depends on A → pending, should be skipped
    // C: no deps, running alongside A, should be cancelled
    const projects = [
      makeProject('pkg-a'),
      makeProject('pkg-b', ['pkg-a']),
      makeProject('pkg-c'),
    ];

    const execFn: MockExecFn = async (_script, _cwd, env, signal) => {
      if (env.PROJECT_NAME === 'pkg-a') {
        return { exitCode: 1, output: 'a failed', truncated: false };
      }
      // pkg-c: long-running, respects abort
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve({ exitCode: 0, output: '', truncated: false }), 500);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve({ exitCode: -1, output: '', truncated: false });
        }, { once: true });
      });
    };

    const summary = await runScripts(baseOptions(projects, execFn, { failFast: true }));

    expect(summary.failed.map((t) => t.project)).toEqual(['pkg-a']);
    expect(summary.skipped.map((t) => t.project)).toContain('pkg-b');
    expect(summary.cancelled.map((t) => t.project)).toContain('pkg-c');
    expect(summary.passed).toHaveLength(0);
  });
});

// ----------------------------------------------------------------
// Concurrency cap
// ----------------------------------------------------------------

describe('runScripts: concurrency', () => {
  it('never exceeds the concurrency limit', async () => {
    const projects = [
      makeProject('pkg-a'),
      makeProject('pkg-b'),
      makeProject('pkg-c'),
      makeProject('pkg-d'),
    ];

    let currentlyRunning = 0;
    let maxObserved = 0;

    const execFn: MockExecFn = async () => {
      currentlyRunning++;
      maxObserved = Math.max(maxObserved, currentlyRunning);
      await delay(20);
      currentlyRunning--;
      return { exitCode: 0, output: '', truncated: false };
    };

    await runScripts(baseOptions(projects, execFn, { concurrency: 2 }));

    expect(maxObserved).toBeLessThanOrEqual(2);
  });

  it('runs all tasks simultaneously when concurrency is unlimited', async () => {
    const projects = [
      makeProject('pkg-a'),
      makeProject('pkg-b'),
      makeProject('pkg-c'),
    ];

    let maxObserved = 0;
    let currentlyRunning = 0;

    const execFn: MockExecFn = async () => {
      currentlyRunning++;
      maxObserved = Math.max(maxObserved, currentlyRunning);
      await delay(20);
      currentlyRunning--;
      return { exitCode: 0, output: '', truncated: false };
    };

    await runScripts(baseOptions(projects, execFn));

    expect(maxObserved).toBe(3);
  });
});

// ----------------------------------------------------------------
// missingScript
// ----------------------------------------------------------------

describe('runScripts: missingScript', () => {
  it('skip (default): projects without the script get no-script state', async () => {
    const projects = [
      makeProject('pkg-a', [], { test: 'ok' }),
      makeProject('pkg-b', [], {}), // no scripts
    ];

    const execFn: MockExecFn = async () => ({ exitCode: 0, output: '', truncated: false });

    const summary = await runScripts(baseOptions(projects, execFn));

    expect(summary.passed.map((t) => t.project)).toContain('pkg-a');
    expect(summary.noScript.map((t) => t.project)).toContain('pkg-b');
    expect(summary.failed).toHaveLength(0);
  });

  it('skip: no-script tasks unblock their dependents', async () => {
    // B depends on A. A has no script → no-script (pass). B should run.
    const projects = [
      makeProject('pkg-a', [], {}),     // no script
      makeProject('pkg-b', ['pkg-a']),  // has script
    ];

    const execFn: MockExecFn = async () => ({ exitCode: 0, output: '', truncated: false });

    const summary = await runScripts(baseOptions(projects, execFn));

    expect(summary.noScript.map((t) => t.project)).toContain('pkg-a');
    expect(summary.passed.map((t) => t.project)).toContain('pkg-b');
  });

  it('error: projects without the script are marked failed', async () => {
    const projects = [
      makeProject('pkg-a', [], { test: 'ok' }),
      makeProject('pkg-b', [], {}), // no scripts
    ];

    const execFn: MockExecFn = async () => ({ exitCode: 0, output: '', truncated: false });

    const summary = await runScripts(
      baseOptions(projects, execFn, { missingScript: 'error' }),
    );

    expect(summary.failed.map((t) => t.project)).toContain('pkg-b');
    expect(summary.passed.map((t) => t.project)).toContain('pkg-a');
  });
});

// ----------------------------------------------------------------
// Output truncation flag propagation
// ----------------------------------------------------------------

describe('runScripts: output truncation', () => {
  it('propagates truncated=true from exec into TaskResult', async () => {
    const projects = [makeProject('pkg-a')];

    const execFn: MockExecFn = async () => ({
      exitCode: 1,
      output: 'x'.repeat(100),
      truncated: true,
    });

    const summary = await runScripts(baseOptions(projects, execFn));

    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].truncated).toBe(true);
    expect(summary.failed[0].output).toBe('x'.repeat(100));
  });

  it('does not set truncated on passed tasks (no output captured)', async () => {
    const projects = [makeProject('pkg-a')];

    const execFn: MockExecFn = async () => ({
      exitCode: 0,
      output: '',
      truncated: false,
    });

    const summary = await runScripts(baseOptions(projects, execFn));

    expect(summary.passed).toHaveLength(1);
    expect(summary.passed[0].truncated).toBeUndefined();
    expect(summary.passed[0].output).toBeUndefined();
  });
});

// ----------------------------------------------------------------
// Empty workspace
// ----------------------------------------------------------------

describe('runScripts: empty workspace', () => {
  it('returns empty summary when no projects are found', async () => {
    const summary = await runScripts({
      scripts: ['test'],
      _discover: async () => [],
      _exec: async () => ({ exitCode: 0, output: '', truncated: false }),
    });

    expect(summary.passed).toHaveLength(0);
    expect(summary.failed).toHaveLength(0);
    expect(summary.skipped).toHaveLength(0);
    expect(summary.cancelled).toHaveLength(0);
    expect(summary.noScript).toHaveLength(0);
  });
});
