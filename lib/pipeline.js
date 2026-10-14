/**
 * DSH 自动化流水线：同步 → 确保 CI workflow → 触发 CI → 等待结论 → 汇报。
 * 各步可经 config.pipeline / repo 配置开关；依赖注入便于测试。
 *
 * @module dsh-github-sync/pipeline
 */
import { ensureCiWorkflow, parseRepoRef } from './github.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{repo: object, config: object, sync: Function, client: object, sleep?: Function, now?: Function, log?: Function}} deps
 * @returns {Promise<{name:string, ok:boolean, status:string, message:string, steps:Array<object>, startedAt:number, finishedAt:number, durationMs:number}>}
 */
export async function runPipeline(deps) {
  const { repo, config, sync, client } = deps;
  const sleep = deps.sleep || defaultSleep;
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});
  const startedAt = now();
  const steps = [];
  const out = {
    name: repo.name,
    ok: false,
    status: 'error',
    message: '',
    steps,
    startedAt,
    finishedAt: 0,
    durationMs: 0,
  };
  const finish = (status, message) => {
    out.status = status;
    out.message = message;
    out.ok = status === 'done' || status === 'done-with-warnings';
    out.finishedAt = now();
    out.durationMs = out.finishedAt - startedAt;
    return out;
  };

  // 1) 同步
  log(`[${repo.name}] pipeline: sync`);
  const syncResult = await sync(repo);
  steps.push({ name: 'sync', ok: syncResult.ok, status: syncResult.status, message: syncResult.message, detail: syncResult });
  if (!syncResult.ok) {
    return finish('sync-failed', `同步未完成（${syncResult.status}）：${syncResult.message}`);
  }

  const warnings = [];

  // 2) 确保 CI workflow
  if (repo.ensureCiWorkflow && client) {
    log(`[${repo.name}] pipeline: ensure workflow`);
    const ensured = await ensureCiWorkflow(client, repoRefOf(repo), { branch: syncResult.branch });
    steps.push({ name: 'ensure-workflow', ok: !/^probe failed/.test(ensured.message), status: ensured.created ? 'created' : 'exists', message: ensured.message });
  }

  // 3) 触发 CI
  let run = null;
  if (config.pipeline.triggerCi && repo.workflowFile && client) {
    log(`[${repo.name}] pipeline: dispatch ${repo.workflowFile}`);
    try {
      const dispatchAt = now();
      await client.dispatchWorkflow(repoRefOf(repo), repo.workflowFile, syncResult.branch, {});
      run = await waitForNewRun(client, repo, syncResult.branch, dispatchAt, sleep, config.pipeline.pollIntervalSeconds * 1000);
      steps.push({
        name: 'trigger-ci',
        ok: true,
        status: 'dispatched',
        message: run ? `run #${run.run_number} (${run.status})` : 'dispatched（未捕获到 run，可能稍后出现）',
        runId: run ? run.id : null,
        runUrl: run ? run.html_url : null,
      });
    } catch (err) {
      warnings.push('trigger-ci');
      steps.push({ name: 'trigger-ci', ok: false, status: 'error', message: String((err && err.message) || err) });
    }
  }

  // 4) 等待 CI 结论
  if (run && config.pipeline.waitCi && client) {
    log(`[${repo.name}] pipeline: wait for run ${run.id}`);
    const deadline = now() + config.pipeline.waitTimeoutMinutes * 60000;
    let finalRun = run;
    while (now() < deadline) {
      if (finalRun.status === 'completed') break;
      await sleep(config.pipeline.pollIntervalSeconds * 1000);
      try {
        finalRun = await client.getRun(repoRefOf(repo), run.id);
      } catch (err) {
        warnings.push('wait-ci');
        steps.push({ name: 'wait-ci', ok: false, status: 'error', message: String((err && err.message) || err) });
        return finish('done-with-warnings', assemble(out, warnings));
      }
    }
    const completed = finalRun.status === 'completed';
    const conclusion = finalRun.conclusion || (completed ? 'unknown' : 'timeout');
    steps.push({
      name: 'wait-ci',
      ok: completed && conclusion === 'success',
      status: conclusion,
      message: completed ? `CI 结论：${conclusion}` : `等待超时（${config.pipeline.waitTimeoutMinutes} 分钟）`,
      runUrl: finalRun.html_url,
    });
  }

  const allOk = steps.every((s) => s.ok);
  return finish(allOk ? 'done' : 'done-with-warnings', assemble(out, warnings));
}

function assemble(out, warnings) {
  const parts = out.steps.map((s) => `${s.name}=${s.status}`);
  return parts.join(' → ') + (warnings.length ? `（告警：${warnings.join(', ')}）` : '');
}

/** dispatch 后捕获新 run（近似：事件=workflow_dispatch、分支匹配、created_at 晚于触发时刻-60s）。 */
async function waitForNewRun(client, repo, branch, dispatchAt, sleep, pollMs) {
  for (let i = 0; i < 6; i++) {
    try {
      const runs = await client.listRuns(repoRefOf(repo), {
        workflowId: repo.workflowFile,
        branch,
        event: 'workflow_dispatch',
        perPage: 5,
      });
      const hit = runs.find((r) => Date.parse(r.created_at) >= dispatchAt - 60000);
      if (hit) return hit;
    } catch {
      return null;
    }
    await sleep(pollMs);
  }
  return null;
}

/** 仓库的 GitHub 引用（owner/name）：优先显式 githubRepo，其次由 git remote URL 解析。 */
function repoRefOf(repo) {
  const parsed = parseRepoRef(repo.githubRepo || repo.remoteUrl || '');
  return parsed ? `${parsed.owner}/${parsed.repo}` : String(repo.githubRepo || '');
}
