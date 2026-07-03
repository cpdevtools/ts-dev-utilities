import { spawn } from 'node:child_process';

export interface ExecResult {
  exitCode: number;
  output: string;
  truncated: boolean;
}

/**
 * Run a single npm script in a project directory.
 * Captures combined stdout+stderr up to maxOutputBytes (last N bytes when exceeded).
 * Respects an AbortSignal for fail-fast cancellation.
 */
export async function execScript(
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  maxOutputBytes: number,
): Promise<ExecResult> {
  if (signal.aborted) {
    return { exitCode: -1, output: '', truncated: false };
  }

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;

    try {
      child = spawn('pnpm', ['run', script], {
        cwd,
        env,
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // Thrown synchronously when signal is already aborted (AbortError)
      resolve({ exitCode: -1, output: '', truncated: false });
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;

    function onData(chunk: Buffer): void {
      if (truncated) return;
      const remaining = maxOutputBytes - totalBytes;
      if (chunk.length >= remaining) {
        chunks.push(chunk.subarray(0, remaining));
        totalBytes = maxOutputBytes;
        truncated = true;
      } else {
        chunks.push(chunk);
        totalBytes += chunk.length;
      }
    }

    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (signal.aborted || (err as { name?: string }).name === 'AbortError') {
        resolve({ exitCode: -1, output: Buffer.concat(chunks).toString('utf8'), truncated });
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        output: Buffer.concat(chunks).toString('utf8'),
        truncated,
      });
    });
  });
}
