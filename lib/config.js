/**
 * 配置归一化：apply(ctx, config) 的原始对象 → 严格、带默认值的运行配置。
 *
 * @module dsh-github-sync/config
 */

export const CONFLICT_POLICIES = ['report', 'merge', 'rebase', 'prefer-remote', 'prefer-local'];
export const REPO_MODES = ['bidirectional', 'pull', 'push'];
export const CHECK_FAILURE_MODES = ['block', 'warn'];
export const NOTIFY_EVENTS = ['conflict', 'error', 'checks', 'pipeline', 'pull', 'push'];

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value, fallback, min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return min !== undefined && n < min ? fallback : n;
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function enumOf(value, allowed, fallback) {
  const v = str(value);
  return allowed.includes(v) ? v : fallback;
}

function checkList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const run = str(item.run);
    if (!run) continue;
    out.push({
      name: str(item.name) || run.slice(0, 40),
      run,
      onFail: enumOf(item.onFail, CHECK_FAILURE_MODES, 'block'),
    });
  }
  return out;
}

function normalizeRepo(raw, defaults, index) {
  if (!raw || typeof raw !== 'object') return null;
  const path = str(raw.path);
  if (!path) return null;
  return {
    name: str(raw.name) || `repo-${index + 1}`,
    path,
    remote: str(raw.remote, 'origin') || 'origin',
    branch: str(raw.branch), // 空 = 使用当前分支
    mode: enumOf(raw.mode, REPO_MODES, 'bidirectional'),
    autoCommit: bool(raw.autoCommit, defaults.autoCommit),
    commitMessage: str(raw.commitMessage, 'chore(dsh): auto-commit before sync'),
    conflictPolicy: enumOf(raw.conflictPolicy, CONFLICT_POLICIES, defaults.conflictPolicy),
    onCheckFailure: enumOf(raw.onCheckFailure, CHECK_FAILURE_MODES, defaults.onCheckFailure),
    checks: Array.isArray(raw.checks) ? checkList(raw.checks) : defaults.checks.map((c) => ({ ...c })),
    ciWorkflow: str(raw.ciWorkflow),
    workflowFile: str(raw.workflowFile) || str(raw.ciWorkflow),
    ensureCiWorkflow: bool(raw.ensureCiWorkflow, false),
  };
}

/**
 * 归一化原始配置。
 *
 * @param {object} raw cordis.patch.yml 里的 config 对象
 */
export function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const defaults = {
    autoCommit: bool(r.autoCommit, false),
    conflictPolicy: enumOf(r.conflictPolicy, CONFLICT_POLICIES, 'report'),
    onCheckFailure: enumOf(r.onCheckFailure, CHECK_FAILURE_MODES, 'block'),
    checks: checkList(r.checks),
  };
  const repos = [];
  if (Array.isArray(r.repos)) {
    r.repos.forEach((item, i) => {
      const repo = normalizeRepo(item, defaults, i);
      if (repo) repos.push(repo);
    });
  }
  const pipeline = r.pipeline && typeof r.pipeline === 'object' ? r.pipeline : {};
  const notifyOn = Array.isArray(r.notifyOn)
    ? r.notifyOn.filter((e) => NOTIFY_EVENTS.includes(str(e)))
    : ['conflict', 'error', 'checks', 'pipeline'];
  return {
    enabled: bool(r.enabled, true),
    runOnStart: bool(r.runOnStart, false),
    intervalMinutes: num(r.intervalMinutes, 30, 1),
    token: str(r.token),
    tokenEnv: str(r.tokenEnv, 'GITHUB_TOKEN'),
    storageFile: str(r.storageFile),
    cloneRoot: str(r.cloneRoot), // 空 = ~/dsh-github-sync（面板“加入同步”缺省克隆位置）
    notifyAgent: bool(r.notifyAgent, true),
    notifyOn,
    autoCommit: defaults.autoCommit,
    conflictPolicy: defaults.conflictPolicy,
    onCheckFailure: defaults.onCheckFailure,
    checks: defaults.checks,
    repos,
    pipeline: {
      triggerCi: bool(pipeline.triggerCi, true),
      waitCi: bool(pipeline.waitCi, true),
      waitTimeoutMinutes: num(pipeline.waitTimeoutMinutes, 10, 1),
      pollIntervalSeconds: num(pipeline.pollIntervalSeconds, 20, 2),
    },
  };
}

/**
 * 解析 PAT：config.token 优先，其次 tokenEnv 指定的环境变量。
 * 绝不把 token 写入日志/返回值。
 */
export function resolveToken(cfg) {
  if (cfg.token) return cfg.token;
  const envName = cfg.tokenEnv || 'GITHUB_TOKEN';
  const v = process.env[envName];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : '';
}

/** 供面板/工具展示的脱敏配置快照。 */
export function redactedConfig(cfg) {
  return {
    enabled: cfg.enabled,
    runOnStart: cfg.runOnStart,
    intervalMinutes: cfg.intervalMinutes,
    tokenEnv: cfg.tokenEnv,
    hasToken: Boolean(resolveToken(cfg)),
    cloneRoot: cfg.cloneRoot || '',
    notifyAgent: cfg.notifyAgent,
    notifyOn: cfg.notifyOn,
    autoCommit: cfg.autoCommit,
    conflictPolicy: cfg.conflictPolicy,
    onCheckFailure: cfg.onCheckFailure,
    checks: cfg.checks,
    pipeline: cfg.pipeline,
    repos: cfg.repos.map((repo) => ({
      name: repo.name,
      path: repo.path,
      remote: repo.remote,
      branch: repo.branch,
      mode: repo.mode,
      autoCommit: repo.autoCommit,
      conflictPolicy: repo.conflictPolicy,
      onCheckFailure: repo.onCheckFailure,
      checks: repo.checks,
      ciWorkflow: repo.ciWorkflow,
      ensureCiWorkflow: repo.ensureCiWorkflow,
    })),
  };
}
