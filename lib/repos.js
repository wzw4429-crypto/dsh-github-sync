/**
 * 运行时仓库注册：GitHub 地址规范化、克隆、配置仓库与运行时仓库合并。
 *
 * @module dsh-github-sync/repos
 */
import path from 'node:path';
import os from 'node:os';
import { runProcess } from './exec.js';
import { parseRepoRef } from './github.js';

/**
 * 规范化用户输入的仓库地址（owner/name、https URL、git@ SSH URL）。
 * @returns {{owner: string, name: string, url: string}|null}
 */
export function normalizeRepoInput(input) {
  const parsed = parseRepoRef(input);
  if (!parsed) return null;
  return { owner: parsed.owner, name: parsed.repo, url: `https://github.com/${parsed.owner}/${parsed.repo}.git` };
}

/** 克隆目标路径：<cloneRoot>/<owner>/<name>；cloneRoot 缺省 ~/dsh-github-sync。 */
export function defaultClonePath(cloneRoot, owner, name) {
  const root = cloneRoot && String(cloneRoot).trim()
    ? String(cloneRoot).trim()
    : path.join(os.homedir(), 'dsh-github-sync');
  return path.join(root, owner, name);
}

/** 运行时条目 → 与配置仓库同构（策略继承全局默认，无推送前检查）。 */
export function toRuntimeRepo(entry, cfg) {
  return {
    name: entry.name,
    path: entry.path,
    remote: entry.remote || 'origin',
    branch: entry.branch || '',
    mode: 'bidirectional',
    autoCommit: cfg.autoCommit,
    commitMessage: 'chore(dsh): auto-commit before sync',
    conflictPolicy: cfg.conflictPolicy,
    onCheckFailure: cfg.onCheckFailure,
    checks: [],
    ciWorkflow: '',
    workflowFile: '',
    ensureCiWorkflow: false,
    source: 'runtime',
    url: entry.url || '',
    addedAt: entry.addedAt || 0,
  };
}

/**
 * 合并配置仓库与运行时加入的仓库：按路径（大小写不敏感）、名称、URL 去重，配置优先。
 */
export function mergeRepos(configRepos, userRepos, cfg) {
  const out = (Array.isArray(configRepos) ? configRepos : []).map((r) => ({ ...r, source: r.source || 'config' }));
  const paths = new Set(out.map((r) => String(r.path || '').toLowerCase()));
  const names = new Set(out.map((r) => r.name));
  const urls = new Set(out.map((r) => String(r.url || '').toLowerCase().replace(/\.git$/, '')));
  for (const entry of Array.isArray(userRepos) ? userRepos : []) {
    if (!entry || typeof entry !== 'object') continue;
    const p = String(entry.path || '').toLowerCase();
    const u = String(entry.url || '').toLowerCase().replace(/\.git$/, '');
    if (!p || !entry.name) continue;
    if (paths.has(p) || names.has(entry.name) || (u && urls.has(u))) continue;
    const repo = toRuntimeRepo(entry, cfg);
    out.push(repo);
    paths.add(p);
    names.add(repo.name);
    if (u) urls.add(u);
  }
  return out;
}

/** git clone（网络鉴权经 env 注入，不进 argv）。 */
export async function cloneRepo(url, dir, { env, timeoutMs } = {}) {
  return runProcess('git', ['clone', '--', url, dir], { timeoutMs: timeoutMs ?? 600000, env });
}

/** 目录是否已是 git 工作树。 */
export async function isGitWorkTree(dir) {
  const r = await runProcess('git', ['rev-parse', '--git-dir'], { cwd: dir, timeoutMs: 30000 });
  return r.ok;
}

/** /user/repos 结果 → slim 列表。 */
export function slimRepoList(items) {
  return (Array.isArray(items) ? items : []).map((r) => ({
    fullName: r.full_name || '',
    name: r.name || '',
    owner: (r.owner && r.owner.login) || '',
    private: Boolean(r.private),
    fork: Boolean(r.fork),
    defaultBranch: r.default_branch || '',
    htmlUrl: r.html_url || '',
    description: r.description || '',
    updatedAt: r.pushed_at || r.updated_at || '',
  }));
}
