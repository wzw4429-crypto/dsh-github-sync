/**
 * 双向同步引擎（纯 git 操作，便于本地测试）。
 *
 * 流程（mode=bidirectional）：
 *   fetch → 计算 ahead/behind → 需要并入时处理工作树（autoCommit 或阻断）→
 *   按 conflictPolicy 集成远端（冲突即 abort 并报告）→ ahead>0 时跑推送前检查 → push。
 *
 * @module dsh-github-sync/sync
 */
import * as g from './git.js';
import { runChecks } from './checks.js';

/** 健康收尾状态（可继续自动化）。 */
const OK_STATUSES = new Set(['up-to-date', 'pulled', 'pushed', 'synced']);

/**
 * 面板用轻量快照：不联网，基于本地缓存的远端引用。
 *
 * @returns {Promise<{branch:string, dirty:boolean, ahead:number, behind:number, head:string, remoteUrl:string, error?:string}>}
 */
export async function repoSnapshot(repo) {
  try {
    if (!(await g.isRepo(repo.path))) {
      return { branch: '', dirty: false, ahead: 0, behind: 0, head: '', remoteUrl: '', error: 'not-a-git-repo' };
    }
    const branch = repo.branch || (await g.currentBranch(repo.path));
    const dirty = await g.isDirty(repo.path);
    const { ahead, behind } = await g.counts(repo.path, `refs/remotes/${repo.remote}/${branch}`);
    const head = await g.headSummary(repo.path);
    const url = await g.remoteUrl(repo.path, repo.remote);
    return { branch, dirty, ahead, behind, head, remoteUrl: url };
  } catch (err) {
    return { branch: '', dirty: false, ahead: 0, behind: 0, head: '', remoteUrl: '', error: String((err && err.message) || err) };
  }
}

/**
 * 执行一轮同步。
 *
 * @param {object} repo 归一化后的仓库配置
 * @param {{checksTimeoutMs?: number, log?: (msg: string) => void, token?: string}} [opts] token（PAT）仅用于 github.com https 远端的 fetch/push 鉴权（env 注入）
 * @returns {Promise<object>} 结果：{name, ok, status, message, branch, ahead, behind, actions, checks, conflictFiles, startedAt, finishedAt, durationMs}
 */
export async function syncRepo(repo, opts = {}) {
  const log = opts.log || (() => {});
  const startedAt = Date.now();
  const actions = [];
  let checks = [];
  const result = {
    name: repo.name,
    ok: false,
    status: 'error',
    message: '',
    branch: repo.branch || '',
    ahead: 0,
    behind: 0,
    actions,
    checks,
    conflictFiles: [],
    startedAt,
    finishedAt: 0,
    durationMs: 0,
  };
  const finish = (status, message) => {
    result.status = status;
    result.message = message;
    result.ok = OK_STATUSES.has(status);
    result.finishedAt = Date.now();
    result.durationMs = result.finishedAt - startedAt;
    return result;
  };

  if (!(await g.isRepo(repo.path))) {
    return finish('error', `not a git repository: ${repo.path}`);
  }
  const branch = repo.branch || (await g.currentBranch(repo.path));
  if (!branch) {
    return finish('error', 'cannot determine branch (detached HEAD?)');
  }
  result.branch = branch;
  const remoteRef = `refs/remotes/${repo.remote}/${branch}`;
  const authEnv = g.gitAuthEnv(await g.remoteUrl(repo.path, repo.remote), opts.token);

  log(`[${repo.name}] fetch ${repo.remote}`);
  const fetched = await g.fetchRemote(repo.path, repo.remote, authEnv);
  if (!fetched.ok) {
    return finish('error', `fetch failed: ${fetched.stderr || fetched.error || fetched.stdout || `exit ${fetched.code}`}`);
  }
  actions.push('fetch');

  const { ahead, behind } = await g.counts(repo.path, remoteRef);
  result.ahead = ahead;
  result.behind = behind;
  if (ahead === 0 && behind === 0) {
    return finish('up-to-date', `与 ${repo.remote}/${branch} 一致`);
  }

  const wantIntegrate = behind > 0 && repo.mode !== 'push';
  const wantPush = ahead > 0 && repo.mode !== 'pull';
  if (!wantIntegrate && !wantPush) {
    return finish('up-to-date', `mode=${repo.mode} 无需动作（${ahead} ahead / ${behind} behind）`);
  }

  if (wantIntegrate) {
    const dirty = await g.isDirty(repo.path);
    if (dirty) {
      if (repo.autoCommit) {
        log(`[${repo.name}] auto-commit dirty tree`);
        const committed = await g.addAllAndCommit(repo.path, repo.commitMessage);
        if (!committed.ok) {
          return finish('error', `auto-commit failed: ${committed.stderr || committed.error || `exit ${committed.code}`}`);
        }
        actions.push('auto-commit');
      } else {
        return finish('dirty', '工作树有未提交改动，且需要并入远端（可开 autoCommit 或手动处理）');
      }
    }

    const diverged = ahead > 0;
    let integrated = false;
    if (!diverged || repo.conflictPolicy === 'report') {
      // 纯落后（或 report 策略）：只接受快进
      const ff = await g.merge(repo.path, remoteRef, { ffOnly: true });
      if (ff.ok) {
        actions.push('ff-merge');
        integrated = true;
      } else if (diverged) {
        return finish('diverged-report', `本地与 ${repo.remote}/${branch} 分叉（${ahead} ahead / ${behind} behind），conflictPolicy=report，未做改动`);
      }
    }
    if (!integrated) {
      const policy = repo.conflictPolicy;
      const useRebase = policy === 'rebase';
      const strategy = policy === 'prefer-remote' ? 'theirs' : policy === 'prefer-local' ? 'ours' : undefined;
      log(`[${repo.name}] ${useRebase ? 'rebase' : 'merge'} (${policy})`);
      const applied = useRebase
        ? await g.rebase(repo.path, remoteRef)
        : await g.merge(repo.path, remoteRef, { strategy });
      if (!applied.ok) {
        const files = await g.conflictFiles(repo.path);
        await g.abortMergeOrRebase(repo.path);
        result.conflictFiles = files;
        actions.push('abort');
        return finish('conflict', `${useRebase ? 'rebase' : 'merge'} 冲突已回滚（conflictPolicy=${policy}）${files.length ? `：${files.slice(0, 5).join(', ')}` : ''}`);
      }
      actions.push(useRebase ? 'rebase' : 'merge');
      integrated = true;
    }
    // 集成后重新计数
    const after = await g.counts(repo.path, remoteRef);
    result.ahead = after.ahead;
    result.behind = after.behind;
  }

  if (wantPush) {
    if ((repo.checks || []).length > 0) {
      log(`[${repo.name}] pre-push checks: ${repo.checks.map((c) => c.name).join(', ')}`);
      const checkRun = await runChecks(repo.checks, { cwd: repo.path, timeoutMs: opts.checksTimeoutMs });
      checks = checkRun.results;
      result.checks = checks;
      if (checkRun.blocked) {
        actions.push('checks-blocked');
        return finish('checks-blocked', `推送前检查未通过（${checkRun.failed.join(', ')}），已阻止推送`);
      }
      if (checkRun.failed.length > 0) {
        actions.push('checks-warn');
      } else {
        actions.push('checks-pass');
      }
    }
    log(`[${repo.name}] push ${repo.remote} ${branch}`);
    const pushed = await g.push(repo.path, repo.remote, branch, authEnv);
    if (!pushed.ok) {
      return finish('error', `push failed: ${pushed.stderr || pushed.error || `exit ${pushed.code}`}`);
    }
    actions.push('push');
  }

  if (actions.includes('push') && (actions.includes('ff-merge') || actions.includes('merge') || actions.includes('rebase'))) {
    return finish('synced', `已并入远端并推送（${branch}）`);
  }
  if (actions.includes('push')) return finish('pushed', `已推送 ${result.ahead} 个本地提交到 ${repo.remote}/${branch}`);
  return finish('pulled', `已并入 ${repo.remote}/${branch} 的更新`);
}
