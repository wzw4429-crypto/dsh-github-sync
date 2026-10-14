/**
 * 进程执行原语：git 命令走无 shell 的 spawn，检查命令走 shell。
 *
 * @module dsh-github-sync/exec
 */
import { spawn } from 'node:child_process';

const MAX_CAPTURE = 1024 * 1024; // 单流捕获上限 1MB

/**
 * 运行一个进程并收集输出。
 *
 * @param {string} command 命令名（shell=false 时）或整行命令（shell=true 时）
 * @param {string[]} [args] 参数（shell=true 时请传 []）
 * @param {{cwd?: string, timeoutMs?: number, shell?: boolean, env?: Record<string,string>}} [opts]
 * @returns {Promise<{ok: boolean, code: number, stdout: string, stderr: string, timedOut: boolean, error?: string}>}
 */
export function runProcess(command, args = [], opts = {}) {
  const { cwd, timeoutMs = 120000, shell = false, env } = opts;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        shell,
        windowsHide: true,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', timedOut: false, error: String((err && err.message) || err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString('utf8');
    });
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut && !error,
        code: typeof code === 'number' ? code : -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        ...(error ? { error: String(error) } : {}),
      });
    };
    child.on('error', (err) => finish(-1, (err && err.message) || String(err)));
    child.on('close', (code) => finish(code ?? -1));
  });
}

/**
 * 运行 shell 命令行（用于仓库本地检查，如 `npm test`）。
 *
 * @param {string} commandLine 完整命令行
 * @param {{cwd?: string, timeoutMs?: number, env?: Record<string,string>}} [opts]
 */
export function runShell(commandLine, opts = {}) {
  return runProcess(commandLine, [], { ...opts, shell: true });
}
