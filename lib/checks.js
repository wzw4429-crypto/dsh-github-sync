/**
 * 推送前本地检查：在仓库目录按顺序执行配置的命令行。
 *
 * @module dsh-github-sync/checks
 */
import { runShell } from './exec.js';

const OUTPUT_TAIL = 4000;

function tail(text) {
  const t = text || '';
  return t.length > OUTPUT_TAIL ? `…${t.slice(-OUTPUT_TAIL)}` : t;
}

/**
 * 执行检查列表。
 *
 * @param {{name: string, run: string, onFail: 'block'|'warn'}[]} checks
 * @param {{cwd: string, timeoutMs?: number, env?: Record<string,string>}} opts
 * @returns {Promise<{results: Array<{name:string, run:string, ok:boolean, code:number, onFail:string, durationMs:number, output:string, timedOut:boolean}>, blocked: boolean, failed: string[]}>}
 */
export async function runChecks(checks, opts) {
  const results = [];
  let blocked = false;
  const failed = [];
  for (const check of checks || []) {
    const startedAt = Date.now();
    const r = await runShell(check.run, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? 600000,
      env: opts.env,
    });
    const ok = r.ok;
    if (!ok) {
      failed.push(check.name);
      if (check.onFail === 'block') blocked = true;
    }
    results.push({
      name: check.name,
      run: check.run,
      ok,
      code: r.code,
      onFail: check.onFail,
      durationMs: Date.now() - startedAt,
      output: tail([r.stdout, r.stderr].filter(Boolean).join('\n')),
      timedOut: Boolean(r.timedOut),
    });
  }
  return { results, blocked, failed };
}
