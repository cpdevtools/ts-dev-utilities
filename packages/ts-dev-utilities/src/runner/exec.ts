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
 *
 * When `onChunk` is provided, every chunk of combined stdout+stderr is forwarded
 * to it as it arrives (unbounded — independent of the capture limit), enabling
 * live streaming of output.
 */
export async function execScript(
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  maxOutputBytes: number,
  onChunk?: (chunk: string) => void,
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
      if (onChunk) onChunk(chunk.toString('utf8'));
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
