/**
 * git 命令薄封装（全部无 shell，避免转义问题）。
 *
 * @module dsh-github-sync/git
 */
import { runProcess } from './exec.js';

const GIT_TIMEOUT = 120000;
const FETCH_TIMEOUT = 180000;

/** 运行 git 子命令。返回 {ok, code, stdout, stderr, timedOut, error?}。 */
export function git(cwd, args, opts = {}) {
  return runProcess('git', args, { cwd, timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT, env: opts.env });
}

/** 是否是 git 工作树（含 bare）。 */
export async function isRepo(cwd) {
  const r = await git(cwd, ['rev-parse', '--git-dir']);
  return r.ok;
}

/** 当前分支名（detached 时返回空串）。 */
export async function currentBranch(cwd) {
  const r = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r.ok) return '';
  return r.stdout === 'HEAD' ? '' : r.stdout;
}

/**
 * 构造注入 git 网络操作的鉴权环境（PAT 走 env，绝不进 argv/日志）。
 * 仅当远端是 github.com 的 http(s) URL 且提供了 token 时生效；否则返回 undefined，
 * 交给系统凭据助手（Git Credential Manager / ssh key）。
 */
export function gitAuthEnv(remoteUrl, token) {
  if (!token || !remoteUrl) return undefined;
  if (!/^https?:\/\/github\.com\//i.test(remoteUrl)) return undefined;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** 抓取远端（prune）。 */
export async function fetchRemote(cwd, remote, env) {
  return git(cwd, ['fetch', '--prune', remote], { timeoutMs: FETCH_TIMEOUT, env });
}

/** 本地相对远端分支的领先/落后数。rev-list --left-right --count：左=本地独有(ahead)，右=远端独有(behind)。 */
export async function counts(cwd, remoteRef) {
  const r = await git(cwd, ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`]);
  if (!r.ok) return { ahead: 0, behind: 0, unknown: true };
  const [a, b] = r.stdout.split(/\s+/).map((x) => parseInt(x, 10));
  return { ahead: Number.isFinite(a) ? a : 0, behind: Number.isFinite(b) ? b : 0, unknown: false };
}

/** 工作树是否不干净（含未跟踪）。 */
export async function isDirty(cwd) {
  const r = await git(cwd, ['status', '--porcelain']);
  return r.ok ? r.stdout !== '' : false;
}

/** 暂存全部并提交；无内容可提交视为成功。 */
export async function addAllAndCommit(cwd, message) {
  const add = await git(cwd, ['add', '-A']);
  if (!add.ok) return add;
  const commit = await git(cwd, ['commit', '-m', message]);
  if (commit.ok) return commit;
  // 没有变化时 commit 非零，但这是安全状态
  if (/nothing to commit/i.test(commit.stdout + commit.stderr)) {
    return { ...commit, ok: true };
  }
  return commit;
}

/**
 * 合并远端引用。
 * @param {string} target 例如 refs/remotes/origin/main
 * @param {{ffOnly?: boolean, strategy?: 'theirs'|'ours'}} [opts]
 */
export async function merge(cwd, target, opts = {}) {
  const args = ['merge', '--no-edit'];
  if (opts.ffOnly) args.push('--ff-only');
  if (opts.strategy === 'theirs') args.push('-X', 'theirs');
  if (opts.strategy === 'ours') args.push('-X', 'ours');
  args.push(target);
  return git(cwd, args);
}

/** 变基到远端引用。 */
export async function rebase(cwd, target) {
  return git(cwd, ['rebase', target]);
}

/** 中止冲突中的合并/变基（尽力而为）。 */
export async function abortMergeOrRebase(cwd) {
  const a = await git(cwd, ['merge', '--abort']);
  if (a.ok) return a;
  return git(cwd, ['rebase', '--abort']);
}

/** 推送当前 HEAD 到远端分支。 */
export async function push(cwd, remote, branch, env) {
  return git(cwd, ['push', remote, `HEAD:${branch}`], { timeoutMs: FETCH_TIMEOUT, env });
}

/** 冲突文件列表（未合并路径）。 */
export async function conflictFiles(cwd) {
  const r = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
  return r.ok ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

/** 最近一次提交摘要（短 sha + 主题行）。 */
export async function headSummary(cwd) {
  const r = await git(cwd, ['log', '-1', '--format=%h %s']);
  return r.ok ? r.stdout : '';
}

/** 远端 URL（展示用）。 */
export async function remoteUrl(cwd, remote) {
  const r = await git(cwd, ['remote', 'get-url', remote]);
  return r.ok ? r.stdout : '';
}

/** 更新远端 URL（GitHub 改名后同步本地 remote）。 */
export async function setRemoteUrl(cwd, remote, url) {
  return git(cwd, ['remote', 'set-url', remote, url]);
}
