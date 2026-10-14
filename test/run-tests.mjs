/**
 * dsh-github-sync 测试套件（node:test）：
 *   - 配置归一化 / 状态持久化 / 推送前检查
 *   - 双向同步引擎（真实 git 临时仓库）
 *   - GitHub 客户端（mock fetch）
 *   - 流水线（注入依赖）
 *   - 工具定义 + Host apply 冒烟（mock ctx）
 *
 * 运行：node --test test/run-tests.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalizeConfig, redactedConfig, resolveToken } from '../lib/config.js';
import { loadState, saveState, recordSync, recordPipeline, getRepoState, addUserRepo, removeUserRepo, setAllRepos, getAllRepos, setRenamed, getRenamed, updateUserRepo, renameRepoSlot } from '../lib/state.js';
import { safePath, looksBinary, listLocalDir, readLocalFile } from '../lib/localfs.js';
import { recencyPoints, activityScore, isActive, probeActivity } from '../lib/activity.js';
import { normalizeRepoInput, defaultClonePath, mergeRepos, cloneRepo } from '../lib/repos.js';
import { runChecks } from '../lib/checks.js';
import { gitAuthEnv, setRemoteUrl, remoteUrl } from '../lib/git.js';
import { syncRepo, repoSnapshot } from '../lib/sync.js';
import { GitHubClient, GitHubError, parseRepoRef, ensureCiWorkflow, DEFAULT_CI_FILENAME } from '../lib/github.js';
import { runPipeline } from '../lib/pipeline.js';
import { buildTools } from '../lib/tools.js';
import { apply } from '../index.js';
import { runProcess } from '../lib/exec.js';

// ---------- 测试隔离的 git 环境 ----------
process.env.GIT_AUTHOR_NAME = 'dsh-test';
process.env.GIT_AUTHOR_EMAIL = 'dsh-test@example.com';
process.env.GIT_COMMITTER_NAME = 'dsh-test';
process.env.GIT_COMMITTER_EMAIL = 'dsh-test@example.com';
const gitEnvFile = path.join(tmpdir(), `dsh-gsync-gitenv-${process.pid}`);
writeFileSync(gitEnvFile, '', 'utf8');
process.env.GIT_CONFIG_GLOBAL = gitEnvFile;
process.env.GIT_CONFIG_SYSTEM = gitEnvFile;

const mkTmp = (prefix) => mkdtempSync(path.join(tmpdir(), prefix));

async function gitOk(cwd, args) {
  const r = await runProcess('git', args, { cwd, timeoutMs: 60000 });
  assert.equal(r.ok, true, `git ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout;
}

/** 建 bare 远端 + 初始 main 分支；返回 {remoteDir, seedDir}。 */
async function makeRemote() {
  const dir = mkTmp('dsh-gsync-remote-');
  const remoteDir = path.join(dir, 'remote.git');
  const seedDir = path.join(dir, 'seed');
  mkdirSync(remoteDir);
  await gitOk(dir, ['init', '--bare', '-b', 'main', remoteDir]);
  await gitOk(dir, ['init', '-b', 'main', seedDir]);
  writeFileSync(path.join(seedDir, 'README.md'), '# seed\n', 'utf8');
  await gitOk(seedDir, ['add', '-A']);
  await gitOk(seedDir, ['commit', '-m', 'init']);
  await gitOk(seedDir, ['remote', 'add', 'origin', remoteDir]);
  await gitOk(seedDir, ['push', '-u', 'origin', 'main']);
  return { dir, remoteDir, seedDir };
}

/** 从 bare 远端克隆一个工作仓库。 */
async function cloneWork(dir, remoteDir, name) {
  const workDir = path.join(dir, name);
  await gitOk(dir, ['clone', '-b', 'main', remoteDir, name]);
  return workDir;
}

const repoCfg = (workDir, extra = {}) => ({
  name: 't',
  path: workDir,
  remote: 'origin',
  branch: 'main',
  mode: 'bidirectional',
  autoCommit: false,
  commitMessage: 'chore(dsh): auto-commit before sync',
  conflictPolicy: 'report',
  onCheckFailure: 'block',
  checks: [],
  ciWorkflow: '',
  workflowFile: '',
  ensureCiWorkflow: false,
  ...extra,
});

// ================= 配置 =================

test('config: 默认值与仓库归一化', () => {
  const cfg = normalizeConfig({
    intervalMinutes: 5,
    repos: [{ path: 'D:\\x\\a' }, { name: 'b', path: 'D:\\x\\b', mode: 'pull', checks: [{ run: 'npm test' }] }, { name: 'no-path' }],
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.intervalMinutes, 5);
  assert.equal(cfg.conflictPolicy, 'report');
  assert.equal(cfg.onCheckFailure, 'block');
  assert.equal(cfg.repos.length, 2);
  assert.equal(cfg.repos[0].mode, 'bidirectional');
  assert.equal(cfg.repos[1].mode, 'pull');
  assert.equal(cfg.repos[1].checks[0].onFail, 'block');
  assert.equal(cfg.pipeline.triggerCi, true);
});

test('config: 非法枚举回落默认 + 脱敏不含 token', () => {
  const cfg = normalizeConfig({ conflictPolicy: 'destroy', token: 'ghp_SECRET', repos: [{ path: 'P' }] });
  assert.equal(cfg.conflictPolicy, 'report');
  assert.equal(resolveToken(cfg), 'ghp_SECRET');
  const red = JSON.stringify(redactedConfig(cfg));
  assert.ok(!red.includes('ghp_SECRET'), 'redacted config must not contain the token');
  assert.equal(redactedConfig(cfg).hasToken, true);
});

test('config: tokenEnv 环境变量回退', () => {
  process.env.TEST_DSH_TOKEN = 'abc123';
  const cfg = normalizeConfig({ tokenEnv: 'TEST_DSH_TOKEN' });
  assert.equal(resolveToken(cfg), 'abc123');
  delete process.env.TEST_DSH_TOKEN;
});

// ================= 状态 =================

test('state: 读写往返 + 历史截尾 + 损坏文件容错', () => {
  const dir = mkTmp('dsh-gsync-state-');
  const file = path.join(dir, 'state.json');
  const state = loadState(file);
  for (let i = 0; i < 25; i++) recordSync(state, 'r', { status: 'ok', message: `m${i}`, ok: true });
  recordPipeline(state, 'r', { status: 'done', message: 'p', ok: true });
  saveState(file, state);
  const back = loadState(file);
  assert.equal(back.repos.r.history.length, 20);
  assert.equal(back.repos.r.lastPipeline.status, 'done');
  writeFileSync(file, '{broken', 'utf8');
  assert.equal(loadState(file).repos.r, undefined);
  rmSync(dir, { recursive: true, force: true });
});

// ================= 推送前检查 =================

test('checks: 通过 / warn 不阻断 / block 阻断', async () => {
  const dir = mkTmp('dsh-gsync-checks-');
  const pass = await runChecks([{ name: 'ok', run: 'exit 0', onFail: 'block' }], { cwd: dir });
  assert.equal(pass.blocked, false);
  assert.equal(pass.results[0].ok, true);

  const warn = await runChecks([{ name: 'w', run: 'exit 1', onFail: 'warn' }], { cwd: dir });
  assert.equal(warn.blocked, false);
  assert.deepEqual(warn.failed, ['w']);

  const block = await runChecks([{ name: 'b', run: 'exit 1', onFail: 'block' }], { cwd: dir });
  assert.equal(block.blocked, true);
  rmSync(dir, { recursive: true, force: true });
});

// ================= PAT → git 鉴权 env =================

test('gitAuthEnv: PAT 走 env 注入，非 github https/无 token 返回 undefined', () => {
  assert.equal(gitAuthEnv('', 'ghp_SECRET'), undefined);
  assert.equal(gitAuthEnv('https://github.com/o/r.git', ''), undefined);
  assert.equal(gitAuthEnv('git@github.com:o/r.git', 'ghp_SECRET'), undefined); // ssh 用密钥，不注入
  assert.equal(gitAuthEnv('https://gitlab.com/o/r.git', 'ghp_SECRET'), undefined);
  const env = gitAuthEnv('https://github.com/o/r.git', 'ghp_SECRET');
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  const decoded = Buffer.from(env.GIT_CONFIG_VALUE_0.replace(/^AUTHORIZATION: basic /, ''), 'base64').toString('utf8');
  assert.equal(decoded, 'x-access-token:ghp_SECRET');
  assert.ok(!JSON.stringify(env).includes('ghp_SECRET'), 'env 序列化不应出现明文 token'); // base64 内不含明文
});

// ================= 同步引擎（真实 git） =================

test('sync: 一致时 up-to-date', async () => {
  const { dir, remoteDir } = await makeRemote();
  const a = await cloneWork(dir, remoteDir, 'a');
  const r = await syncRepo(repoCfg(a));
  assert.equal(r.status, 'up-to-date');
  assert.equal(r.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test('sync: 本地领先 → 检查通过后推送', async () => {
  const { dir, remoteDir } = await makeRemote();
  const a = await cloneWork(dir, remoteDir, 'a');
  writeFileSync(path.join(a, 'x.txt'), 'x\n', 'utf8');
  await gitOk(a, ['add', '-A']);
  await gitOk(a, ['commit', '-m', 'local change']);
  const r = await syncRepo(repoCfg(a, { checks: [{ name: 't', run: 'exit 0', onFail: 'block' }] }));
  assert.equal(r.status, 'pushed');
  assert.ok(r.actions.includes('checks-pass'));
  assert.ok(r.actions.includes('push'));
  rmSync(dir, { recursive: true, force: true });
});

test('sync: 远端领先 → 快进并入', async () => {
  const { dir, remoteDir, seedDir } = await makeRemote();
  const a = await cloneWork(dir, remoteDir, 'a');
  writeFileSync(path.join(seedDir, 'remote.txt'), 'r\n', 'utf8');
  await gitOk(seedDir, ['add', '-A']);
  await gitOk(seedDir, ['commit', '-m', 'remote change']);
  await gitOk(seedDir, ['push', 'origin', 'main']);
  const r = await syncRepo(repoCfg(a));
  assert.equal(r.status, 'pulled');
  assert.ok(existsSync(path.join(a, 'remote.txt')));
  rmSync(dir, { recursive: true, force: true });
});

test('sync: 分叉 + report 策略 → 只报告不动手', async () => {
  const { dir, remoteDir, seedDir } = await makeRemote();
  const a = await cloneWork(dir, remoteDir, 'a');
  // 远端新提交
  writeFileSync(path.join(seedDir, 'remote.txt'), 'r\n', 'utf8');
  await gitOk(seedDir, ['add', '-A']);
  await gitOk(seedDir, ['commit', '-m', 'remote change']);
  await gitOk(seedDir, ['push', 'origin', 'main']);
  // 本地新提交
  writeFileSync(path.join(a, 'local.txt'), 'l\n', 'utf8');
  await gitOk(a, ['add', '-A']);
  await gitOk(a, ['commit', '-m', 'local change']);
  const before = await gitOk(a, ['rev-parse', 'HEAD']);
  const r = await syncRepo(repoCfg(a, { conflictPolicy: 'report' }));
  assert.equal(r.status, 'diverged-report');
  assert.equal(r.ok, false);
  assert.equal(await gitOk(a, ['rev-parse', 'HEAD']), before, 'report 策略不得改动 HEAD');
  assert.ok(!existsSync(path.join(a, 'remote.txt')), 'report 策略不得并入远端');
  rmSync(dir, { recursive: true, force: true });
});

test('sync: 分叉 + merge 策略 → 合并并推送', async () => {
  const { dir, remoteDir, seedDir } = await makeRemote();
  const a = await cloneWork(dir, remoteDir, 'a');
  writeFileSync(path.join(seedDir, 'remote.txt'), 'r\n', 'utf8');
  await gitOk(seedDir, ['add', '-A']);
  await gitOk(seedDir, ['commit', '-m', 'remote change']);
  await gitOk(seedDir, ['push', 'origin', 'main']);
  writeFileSync(path.join(a, 'local.txt'), 'l\n', 'utf8');
  await gitOk(a, ['add', '-A']);
  await gitOk(a, ['commit', '-m', 'local change']);
  const r = await syncRepo(repoCfg(a, { conflictPolicy: 'merge' }));
  assert.equal(r.status, 'synced');
  assert.ok(existsSync(path.join(a, 'remote.txt')) && existsSync(path.join(a, 'local.txt')));
  rmSync(dir, { recursive: true, force: true });
});

test('sync: 分叉 + rebase 策略 → 变基并推送', async () => {
  const { dir, remoteDir, seedDir } = await makeRemote();
  const a = await cloneWork(dir, remoteDir, 'a');
  writeFileSync(path.join(seedDir, 'remote.txt'), 'r\n', 'utf8');
  await gitOk(seedDir, ['add', '-A']);
  await gitOk(seedDir, ['commit', '-m', 'remote change']);
  await gitOk(seedDir, ['push', 'origin', 'main']);
  writeFileSync(path.join(a, 'local.txt'), 'l\n', 'utf8');
  await gitOk(a, ['add', '-A']);
  await gitOk(a, ['commit', '-m', 'local change']);
  const r = await syncRepo(repoCfg(a, { conflictPolicy: 'rebase' }));
  assert.equal(r.status, 'synced');
  assert.ok(r.actions.includes('rebase'));
  rmSync(dir, { recursive: true, force: true });
});

test('sync: 冲突 → 回滚并报告 conflict', async () => {
  const { dir, remoteDir, seedDir } = await makeRemote();
  const a = await cloneWork(dir, remoteDir, 'a');
  // 远端改 file.txt
  writeFileSync(path.join(seedDir, 'file.txt'), 'remote version\n', 'utf8');
  await gitOk(seedDir, ['add', '-A']);
  await gitOk(seedDir, ['commit', '-m', 'remote edit']);
  await gitOk(seedDir, ['push', 'origin', 'main']);
  // 本地改同一文件同一行
  writeFileSync(path.join(a, 'file.txt'), 'local version\n', 'utf8');
  await gitOk(a, ['add', '-A']);
  await gitOk(a, ['commit', '-m', 'local edit']);
  const before = await gitOk(a, ['rev-parse', 'HEAD']);
  const r = await syncRepo(repoCfg(a, { conflictPolicy: 'merge' }));
  assert.equal(r.status, 'conflict');
  assert.ok(r.conflictFiles.includes('file.txt'));
  assert.equal(await gitOk(a, ['rev-parse', 'HEAD']), before, '冲突后必须回到原 HEAD');
  const status = await gitOk(a, ['status', '--porcelain']);
  assert.equal(status, '', '冲突后工作树必须干净');
  rmSync(dir, { recursive: true, force: true });
});

test('sync: 脏工作树需并入 → 无 autoCommit 报 dirty，有 autoCommit 先提交再合并', async () => {
  const { dir, remoteDir, seedDir } = await makeRemote();
  const a = await cloneWork(dir, remoteDir, 'a');
  writeFileSync(path.join(seedDir, 'remote.txt'), 'r\n', 'utf8');
  await gitOk(seedDir, ['add', '-A']);
  await gitOk(seedDir, ['commit', '-m', 'remote change']);
  await gitOk(seedDir, ['push', 'origin', 'main']);
  writeFileSync(path.join(a, 'dirty.txt'), 'd\n', 'utf8');

  const r1 = await syncRepo(repoCfg(a, { autoCommit: false }));
  assert.equal(r1.status, 'dirty');

  const r2 = await syncRepo(repoCfg(a, { autoCommit: true }));
  assert.ok(['pulled', 'synced'].includes(r2.status), `unexpected: ${r2.status} ${r2.message}`);
  assert.ok(r2.actions.includes('auto-commit'));
  assert.ok(existsSync(path.join(a, 'remote.txt')) && existsSync(path.join(a, 'dirty.txt')));
  rmSync(dir, { recursive: true, force: true });
});

test('sync: 检查 block → 阻止推送；warn → 照常推送', async () => {
  const { dir, remoteDir } = await makeRemote();
  const a = await cloneWork(dir, remoteDir, 'a');
  writeFileSync(path.join(a, 'x.txt'), 'x\n', 'utf8');
  await gitOk(a, ['add', '-A']);
  await gitOk(a, ['commit', '-m', 'local']);

  const blocked = await syncRepo(repoCfg(a, { checks: [{ name: 'fail', run: 'exit 1', onFail: 'block' }] }));
  assert.equal(blocked.status, 'checks-blocked');

  const warned = await syncRepo(repoCfg(a, { checks: [{ name: 'fail', run: 'exit 1', onFail: 'warn' }] }));
  assert.equal(warned.status, 'pushed');
  assert.ok(warned.actions.includes('checks-warn'));
  rmSync(dir, { recursive: true, force: true });
});

test('sync: mode=pull 不推送 / mode=push 不并入', async () => {
  const { dir, remoteDir, seedDir } = await makeRemote();
  const a = await cloneWork(dir, remoteDir, 'a');
  // 本地领先
  writeFileSync(path.join(a, 'local.txt'), 'l\n', 'utf8');
  await gitOk(a, ['add', '-A']);
  await gitOk(a, ['commit', '-m', 'local']);
  const pullOnly = await syncRepo(repoCfg(a, { mode: 'pull' }));
  assert.equal(pullOnly.status, 'up-to-date'); // ahead>0 但 pull 模式不动
  // 远端领先 + 本地领先（分叉），push 模式不并入
  writeFileSync(path.join(seedDir, 'remote.txt'), 'r\n', 'utf8');
  await gitOk(seedDir, ['add', '-A']);
  await gitOk(seedDir, ['commit', '-m', 'remote']);
  await gitOk(seedDir, ['push', 'origin', 'main']);
  const pushOnly = await syncRepo(repoCfg(a, { mode: 'push' }));
  assert.equal(pushOnly.status, 'error'); // 远端非快进，push 被拒绝
  assert.match(pushOnly.message, /push failed/);
  rmSync(dir, { recursive: true, force: true });
});

test('sync: 非 git 目录 → error；snapshot 不抛异常', async () => {
  const dir = mkTmp('dsh-gsync-nogit-');
  const r = await syncRepo(repoCfg(dir));
  assert.equal(r.status, 'error');
  const snap = await repoSnapshot(repoCfg(dir));
  assert.equal(snap.error, 'not-a-git-repo');
  rmSync(dir, { recursive: true, force: true });
});

// ================= GitHub 客户端 =================

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const res = handler(url, init);
    const body = res.body === undefined ? '' : JSON.stringify(res.body);
    return {
      ok: (res.status || 200) < 400,
      status: res.status || 200,
      text: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

test('github: parseRepoRef 各种形态', () => {
  assert.deepEqual(parseRepoRef('owner/name'), { owner: 'owner', repo: 'name' });
  assert.deepEqual(parseRepoRef('https://github.com/o/r.git'), { owner: 'o', repo: 'r' });
  assert.deepEqual(parseRepoRef('git@github.com:o/r.git'), { owner: 'o', repo: 'r' });
  assert.equal(parseRepoRef('not-a-repo'), null);
});

test('github: dispatch 带 PAT 头 + body；错误映射不泄漏 token', async () => {
  const fetchImpl = mockFetch((url, init) => {
    if (url.includes('/dispatches')) return { status: 204 };
    return { status: 500, body: { message: 'boom' } };
  });
  const client = new GitHubClient({ token: 'ghp_TOPSECRET', fetchImpl });
  await client.dispatchWorkflow('o/r', 'ci.yml', 'main', { foo: 'bar' });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.github.com/repos/o/r/actions/workflows/ci.yml/dispatches');
  assert.equal(call.init.headers.authorization, 'Bearer ghp_TOPSECRET');
  assert.deepEqual(JSON.parse(call.init.body), { ref: 'main', inputs: { foo: 'bar' } });

  await assert.rejects(
    () => client.request('GET', '/repos/o/r'),
    (err) => {
      assert.ok(err instanceof GitHubError);
      assert.ok(!String(err.message).includes('ghp_TOPSECRET'), 'error must not contain token');
      return true;
    },
  );

  const f401 = mockFetch(() => ({ status: 401, body: { message: 'Bad credentials' } }));
  await assert.rejects(
    () => new GitHubClient({ token: 'ghp_TOPSECRET', fetchImpl: f401 }).repoInfo('o/r'),
    (err) => err.code === 'bad-credentials',
  );
});

test('github: ensureCiWorkflow 缺失则创建、存在则跳过', async () => {
  const created = [];
  const fetchImpl = mockFetch((url, init) => {
    if (init.method === 'GET') return { status: 404, body: { message: 'Not Found' } };
    created.push(JSON.parse(init.body));
    return { status: 201, body: { content: {} } };
  });
  const client = new GitHubClient({ token: 't', fetchImpl });
  const res = await ensureCiWorkflow(client, 'o/r', { branch: 'main' });
  assert.equal(res.created, true);
  assert.equal(created[0].branch, 'main');
  assert.equal(created[0].content, Buffer.from(
    (await import('../lib/github.js')).DEFAULT_CI_CONTENT, 'utf8',
  ).toString('base64'));

  const f2 = mockFetch(() => ({ status: 200, body: { name: 'dsh-ci.yml' } }));
  const res2 = await ensureCiWorkflow(new GitHubClient({ token: 't', fetchImpl: f2 }), 'o/r', { branch: 'main' });
  assert.equal(res2.created, false);
});

// ================= 流水线 =================

test('pipeline: 步骤顺序与完成状态', async () => {
  const order = [];
  const client = {
    dispatchWorkflow: async () => { order.push('dispatch'); },
    listRuns: async () => [{ id: 7, run_number: 3, status: 'in_progress', created_at: new Date().toISOString(), html_url: 'u' }],
    getRun: async () => ({ id: 7, status: 'completed', conclusion: 'success', html_url: 'u' }),
    getFile: async () => ({ name: 'dsh-ci.yml' }),
  };
  const result = await runPipeline({
    repo: {
      name: 'r', path: 'x', remote: 'origin', workflowFile: 'ci.yml', ensureCiWorkflow: true,
      remoteUrl: 'https://github.com/o/r.git', githubRepo: 'o/r',
    },
    config: { pipeline: { triggerCi: true, waitCi: true, waitTimeoutMinutes: 1, pollIntervalSeconds: 0 } },
    sync: async () => { order.push('sync'); return { ok: true, status: 'up-to-date', message: 'm', branch: 'main' }; },
    client,
    sleep: async () => {},
  });
  assert.equal(result.status, 'done');
  assert.deepEqual(order, ['sync', 'dispatch']);
  assert.deepEqual(result.steps.map((s) => s.name), ['sync', 'ensure-workflow', 'trigger-ci', 'wait-ci']);
});

test('pipeline: 同步失败即短路', async () => {
  const result = await runPipeline({
    repo: { name: 'r', path: 'x' },
    config: { pipeline: { triggerCi: true, waitCi: true, waitTimeoutMinutes: 1, pollIntervalSeconds: 0 } },
    sync: async () => ({ ok: false, status: 'conflict', message: 'boom', branch: 'main' }),
    client: {},
    sleep: async () => {},
  });
  assert.equal(result.status, 'sync-failed');
  assert.equal(result.steps.length, 1);
});

// ================= 工具定义 =================

test('tools: 定义齐全、execute 走 services', async () => {
  const calls = [];
  const tools = buildTools({
    run: async (action, name) => { calls.push(['run', action, name]); return [{ ok: true, status: 'up-to-date' }]; },
    statusReport: async (name) => { calls.push(['status', name]); return { ok: true, repos: [] }; },
    ciStatus: async (name, opts) => { calls.push(['ci', name, opts.action]); return { repo: 'o/r', action: opts.action }; },
    runDetail: async (name, runId) => { calls.push(['run-detail', name, runId]); return { run: { id: runId }, jobs: [] }; },
    workflowList: async (name) => { calls.push(['wf-list', name]); return [{ id: 1 }]; },
    workflowDispatch: async (name, opts) => { calls.push(['wf-dispatch', name, opts.workflow]); return { dispatched: true }; },
    listAllRepos: async (opts) => { calls.push(['repos-list', opts.refresh]); return { repos: [{ fullName: 'o/r', synced: false }] }; },
    addRepo: async (opts) => { calls.push(['repos-add', opts.url, opts.path]); return { entry: { name: 'r' } }; },
    removeRepo: async (name) => { calls.push(['repos-remove', name]); return { removed: name }; },
    renameRepo: async (name, newName) => { calls.push(['repos-rename', name, newName]); return { renamed: true, name: newName }; },
    listFiles: async (name, p, ref) => { calls.push(['files', name, p, ref]); return { kind: 'dir', entries: [] }; },
    localFiles: async (name, p) => { calls.push(['local-dir', name, p]); return { kind: 'dir', entries: [] }; },
    localFile: async (name, p) => { calls.push(['local-file', name, p]); return { kind: 'file', content: '' }; },
  });
  assert.deepEqual(tools.map((t) => t.name), ['github_sync', 'github_status', 'github_ci', 'github_workflow', 'github_repos', 'github_files']);
  for (const def of tools) {
    assert.ok(def.parameters && def.parameters.type === 'object');
    assert.ok(typeof def.execute === 'function' && typeof def.render === 'function');
    assert.equal(def.render({}, { ok: true })[0].type, 'text');
  }
  const exec = { signal: { throwIfAborted() {} } };
  const r1 = await tools[0].execute({ action: 'pipeline', repo: 'x' }, exec);
  assert.equal(r1.ok, true);
  await tools[1].execute({}, exec);
  await tools[2].execute({ repo: 'x', action: 'checks' }, exec);
  await tools[2].execute({ repo: 'x', action: 'run-detail', runId: 42 }, exec);
  await tools[3].execute({ repo: 'x', action: 'list' }, exec);
  await tools[3].execute({ repo: 'x', action: 'dispatch', workflow: 'ci.yml' }, exec);
  await tools[4].execute({ action: 'list', refresh: true }, exec);
  await tools[4].execute({ action: 'add', url: 'o/r', path: 'D:\\x' }, exec);
  await tools[4].execute({ action: 'remove', repo: 'r' }, exec);
  await tools[4].execute({ action: 'rename', repo: 'r', newName: 'r2' }, exec);
  await tools[5].execute({ repo: 'x', path: 'src' }, exec); // 缺省 local → 走 localFile（有 path）
  await tools[5].execute({ repo: 'x', path: '', source: 'github' }, exec);
  assert.deepEqual(calls, [
    ['run', 'pipeline', 'x'],
    ['status', undefined],
    ['ci', 'x', 'checks'],
    ['run-detail', 'x', 42],
    ['wf-list', 'x'],
    ['wf-dispatch', 'x', 'ci.yml'],
    ['repos-list', true],
    ['repos-add', 'o/r', 'D:\\x'],
    ['repos-remove', 'r'],
    ['repos-rename', 'r', 'r2'],
    ['local-file', 'x', 'src'],
    ['files', 'x', '', undefined],
  ]);
});

// ================= Host apply 冒烟 =================

function mockCtx(profileDir) {
  const registered = { tools: [], routes: [] };
  const disposers = [];
  const listeners = {};
  return {
    tools: {
      register: (d) => { registered.tools.push(d); return () => {}; },
    },
    connection: {
      fetch: {
        register: (r) => { registered.routes.push(r); return () => {}; },
      },
    },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); },
    on: (event, cb) => { listeners[event] = cb; return () => { delete listeners[event]; }; },
    get: (key) => (key === 'profileContext' ? { dir: profileDir } : undefined),
    __registered: registered,
    __disposers: disposers,
  };
}

test('host: apply 注册工具与路由，状态接口可服务，dispose 干净', async () => {
  const dir = mkTmp('dsh-gsync-host-');
  const savedProfileDir = process.env.DSH_PROFILE_DIR;
  delete process.env.DSH_PROFILE_DIR; // 隔离外部环境，走 ctx.get('profileContext') 分支
  try {
    const ctx = mockCtx(dir);
    apply(ctx, { intervalMinutes: 60, repos: [] });

  assert.deepEqual(ctx.__registered.tools.map((t) => t.name), ['github_sync', 'github_status', 'github_ci', 'github_workflow', 'github_repos', 'github_files']);
  const statusRoute = ctx.__registered.routes.find((r) => r.path === '/api/github-sync/status');
  const actionRoute = ctx.__registered.routes.find((r) => r.path === '/api/github-sync/action');
  assert.ok(statusRoute && actionRoute);

  const res = await statusRoute.fetch({ });
  const payload = await res.json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.repos, []);
  assert.ok(existsSync(path.join(dir, 'github-sync-state.json')), 'state file must land in the profile dir');
  assert.ok(readFileSync(path.join(dir, 'github-sync-state.json'), 'utf8').includes('"codeGen": 3'), 'state 文件应带新代码指纹 codeGen=3');

  const res2 = await actionRoute.fetch({ text: async () => JSON.stringify({ action: 'refresh' }) });
  assert.equal((await res2.json()).ok, true);
  const res3 = await actionRoute.fetch({ text: async () => 'not-json' });
  assert.equal(res3.status, 400);

  // list-repos 无 PAT → 500 且错误消息点名 PAT（提示用户配置）
  const res4 = await actionRoute.fetch({ text: async () => JSON.stringify({ action: 'list-repos' }) });
  assert.equal(res4.status, 500);
  const p4 = await res4.json();
  assert.equal(p4.ok, false);
  assert.match(p4.error, /PAT/);

  // 工具可执行
  const statusTool = ctx.__registered.tools.find((t) => t.name === 'github_status');
  const out = await statusTool.execute({}, { signal: { throwIfAborted() {} } });
  assert.equal(out.ok, true);

  for (const dispose of ctx.__disposers) dispose();
  rmSync(dir, { recursive: true, force: true });
  } finally {
    if (savedProfileDir !== undefined) process.env.DSH_PROFILE_DIR = savedProfileDir;
  }
});

// ================= 运行时仓库注册（全部仓库/添加/文件浏览支撑） =================

test('repos: 地址规范化 / 默认克隆路径', () => {
  assert.deepEqual(normalizeRepoInput('owner/name'), { owner: 'owner', name: 'name', url: 'https://github.com/owner/name.git' });
  assert.deepEqual(normalizeRepoInput('https://github.com/o/r'), { owner: 'o', name: 'r', url: 'https://github.com/o/r.git' });
  assert.deepEqual(normalizeRepoInput('git@github.com:o/r.git'), { owner: 'o', name: 'r', url: 'https://github.com/o/r.git' });
  assert.equal(normalizeRepoInput('https://gitlab.com/o/r'), null);
  assert.equal(normalizeRepoInput(''), null);
  assert.equal(defaultClonePath('D:\\roots', 'o', 'r'), path.join('D:\\roots', 'o', 'r'));
  assert.ok(defaultClonePath('', 'o', 'r').endsWith(path.join('o', 'r')), '默认根为 ~/dsh-github-sync');
});

test('repos: 合并时配置优先、按路径/名称/URL 去重', () => {
  const cfg = { autoCommit: false, conflictPolicy: 'report', onCheckFailure: 'block' };
  const configRepos = [{ name: 'panorama', path: 'D:\\dsh\\panorama', remote: 'origin', branch: '', checks: [] }];
  const userRepos = [
    { name: 'dup-path', path: 'D:\\DSH\\PANORAMA', url: '', addedAt: 1 }, // 路径大小写重复 → 丢弃
    { name: 'panorama', path: 'D:\\elsewhere', url: '', addedAt: 2 }, // 名称重复 → 丢弃
    { name: 'b-clone', path: 'D:\\clone\\b', url: 'https://github.com/a/b.git', addedAt: 3 }, // 正常加入
    { name: 'b-again', path: 'D:\\clone\\b2', url: 'https://github.com/a/b.git', addedAt: 4 }, // URL 重复 → 丢弃
    { name: 'new-repo', path: 'D:\\clone\\c', url: 'https://github.com/a/c.git', addedAt: 5 },
  ];
  const merged = mergeRepos(configRepos, userRepos, cfg);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].source, 'config');
  assert.equal(merged[1].name, 'b-clone');
  const runtime = merged[2];
  assert.equal(runtime.source, 'runtime');
  assert.equal(runtime.name, 'new-repo');
  assert.equal(runtime.mode, 'bidirectional');
  assert.equal(runtime.conflictPolicy, 'report');
  assert.deepEqual(runtime.checks, []);
});

test('repos: cloneRepo 从本地远端真实克隆', async () => {
  const { dir, remoteDir } = await makeRemote();
  const target = path.join(dir, 'clone');
  const r = await cloneRepo(remoteDir, target);
  assert.equal(r.ok, true, `clone failed: ${r.stderr || r.error}`);
  assert.ok(existsSync(path.join(target, 'README.md')));
  rmSync(dir, { recursive: true, force: true });
});

test('state: userRepos/allRepos 持久化往返', () => {
  const dir = mkTmp('dsh-gsync-userrepos-');
  const file = path.join(dir, 'state.json');
  const state = loadState(file);
  addUserRepo(state, { name: 'r1', path: 'D:\\x\\r1', url: 'https://github.com/o/r1.git', addedAt: 1 });
  setAllRepos(state, [{ fullName: 'o/r1' }]);
  saveState(file, state);
  const back = loadState(file);
  assert.equal(back.userRepos.length, 1);
  assert.equal(back.userRepos[0].name, 'r1');
  assert.equal(getAllRepos(back).repos[0].fullName, 'o/r1');
  assert.equal(removeUserRepo(back, 'r1'), true);
  assert.equal(removeUserRepo(back, 'r1'), false);
  assert.equal(back.userRepos.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('github: listUserRepos 请求参数与 contents 目录/文件', async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes('/user/repos')) return { status: 200, body: [{ full_name: 'o/r', name: 'r', owner: { login: 'o' }, private: false, fork: false, default_branch: 'main', html_url: 'https://github.com/o/r', description: 'd', pushed_at: '2026-10-14T00:00:00Z' }] };
    if (url.includes('/contents/src')) return { status: 200, body: [{ name: 'a.js', path: 'src/a.js', type: 'file', size: 3 }, { name: 'sub', path: 'src/sub', type: 'dir', size: 0 }] };
    if (url.includes('/contents/README.md')) return { status: 200, body: { name: 'README.md', path: 'README.md', type: 'file', size: 7, content: Buffer.from('# hello\n').toString('base64') } };
    return { status: 404, body: { message: 'Not Found' } };
  });
  const client = new GitHubClient({ token: 'ghp_T', fetchImpl });

  const list = await client.listUserRepos({ perPage: 100, page: 1 });
  assert.equal(list.length, 1);
  const listCall = fetchImpl.calls.find((c) => c.url.includes('/user/repos'));
  const q = new URL(listCall.url).searchParams;
  assert.equal(q.get('per_page'), '100');
  assert.equal(q.get('page'), '1');
  assert.equal(q.get('sort'), 'updated');
  assert.equal(listCall.init.headers.authorization, 'Bearer ghp_T');

  const dirData = await client.getFile('o/r', 'src', 'main');
  assert.ok(Array.isArray(dirData));
  assert.equal(dirData[0].type, 'file');
  const fileData = await client.getFile('o/r', 'README.md', 'main');
  assert.equal(Buffer.from(fileData.content, 'base64').toString('utf8'), '# hello\n');
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes('ghp_T')), 'token 绝不出现在 URL');
});

// ================= 本地浏览 / 活跃度 / 改名 =================

test('localfs: 路径穿越防护 + 目录列举 + 文本预览 + 二进制识别', async () => {
  const dir = mkTmp('dsh-gsync-localfs-');
  mkdirSync(path.join(dir, 'sub'));
  writeFileSync(path.join(dir, 'a.txt'), 'hello world\n', 'utf8');
  writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  writeFileSync(path.join(dir, 'sub', 'b.txt'), 'inner', 'utf8');

  // 穿越防护
  assert.throws(() => safePath(dir, '../outside'), /path-escape/);
  assert.throws(() => safePath(dir, '..\\outside'), /path-escape/);
  assert.throws(() => safePath(dir, 'sub/../../outside'), /path-escape/);
  await assert.rejects(listLocalDir(dir, '../x'), /path-escape/);
  await assert.rejects(readLocalFile(dir, '../a.txt'), /path-escape/);
  assert.equal(safePath(dir, 'sub/b.txt').target, path.join(dir, 'sub', 'b.txt'));
  assert.equal(safePath(dir, '').target, path.resolve(dir));

  // 列举：目录优先排序，文件带大小
  const listing = await listLocalDir(dir, '');
  assert.equal(listing.kind, 'dir');
  assert.equal(listing.entries[0].name, 'sub');
  assert.equal(listing.entries[0].type, 'dir');
  const txt = listing.entries.find((e) => e.name === 'a.txt');
  assert.equal(txt.type, 'file');
  assert.equal(txt.size, 'hello world\n'.length);

  // 文本预览 / 二进制
  const file = await readLocalFile(dir, 'a.txt');
  assert.equal(file.kind, 'file');
  assert.equal(file.content, 'hello world\n');
  assert.equal(file.binary, false);
  const bin = await readLocalFile(dir, 'bin.dat');
  assert.equal(bin.binary, true);
  assert.equal(bin.content, '');
  assert.equal(looksBinary(Buffer.from([1, 0, 2])), true);
  assert.equal(looksBinary(Buffer.from('abc')), false);

  // 目录当文件读 / 文件当目录列
  await assert.rejects(readLocalFile(dir, 'sub'), /is-a-directory/);
  await assert.rejects(listLocalDir(dir, 'a.txt'), /not-a-directory/);
  rmSync(dir, { recursive: true, force: true });
});

test('activity: 阶梯打分与活跃判定（纯函数）', () => {
  const now = Date.now();
  assert.equal(recencyPoints(now - 2 * 60000, now, 100), 100); // ≤5min 全分
  assert.equal(recencyPoints(now - 30 * 60000, now, 100), 60); // ≤60min 六成
  assert.equal(recencyPoints(now - 5 * 3600000, now, 100), 25); // ≤24h 四分之一
  assert.equal(recencyPoints(now - 48 * 3600000, now, 100), 0);
  assert.equal(recencyPoints(0, now, 100), 0);
  assert.equal(recencyPoints(NaN, now, 100), 0);

  const fresh = { dirty: false, newestFileTs: now - 60000, lastCommitTs: now - 60000 };
  const stale = { dirty: false, newestFileTs: now - 48 * 3600000, lastCommitTs: now - 48 * 3600000 };
  const dirtyStale = { dirty: true, newestFileTs: 0, lastCommitTs: 0 };
  // 排序不变量：脏仓库 > 新鲜干净仓库 > 陈旧仓库
  assert.ok(activityScore(dirtyStale, now) > activityScore(fresh, now));
  assert.ok(activityScore(fresh, now) > activityScore(stale, now));
  assert.equal(isActive(fresh, now), true);
  assert.equal(isActive({ dirty: false, newestFileTs: now - 2 * 3600000, lastCommitTs: 0 }, now), false);
  assert.equal(isActive({ dirty: true, newestFileTs: 0, lastCommitTs: 0 }, now), true);
});

test('activity: probeActivity 读本地提交时间与文件 mtime，坏目录不抛', async () => {
  const { dir, remoteDir } = await makeRemote();
  const a = await cloneWork(dir, remoteDir, 'a');
  const probe = await probeActivity(a);
  assert.ok(probe.lastCommitTs > 0, '应读到最近提交时间');
  assert.ok(probe.newestFileTs > 0, '应读到顶层文件最新 mtime');
  const bare = mkTmp('dsh-gsync-probe-'); // 非 git 目录：信号为 0，不抛
  const probe2 = await probeActivity(bare);
  assert.equal(probe2.lastCommitTs, 0);
  rmSync(dir, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

test('state: 改名映射 / 运行时条目更新 / 历史槽位跟随', () => {
  const dir = mkTmp('dsh-gsync-renamed-');
  const file = path.join(dir, 'state.json');
  const state = loadState(file);
  addUserRepo(state, { name: 'old-run', path: 'D:\\x\\r', url: 'https://github.com/o/old-run.git', addedAt: 1 });
  recordSync(state, 'cfg-repo', { status: 'up-to-date', message: 'm', ok: true });

  assert.equal(updateUserRepo(state, 'old-run', { name: 'new-run', url: 'https://github.com/o/new-run.git' }), true);
  assert.equal(updateUserRepo(state, 'ghost', { name: 'x' }), false);
  assert.equal(state.userRepos[0].name, 'new-run');

  setRenamed(state, 'cfg-repo', { name: 'cfg-renamed', url: 'https://github.com/o/cfg-renamed.git' });
  assert.equal(getRenamed(state)['cfg-repo'].name, 'cfg-renamed');

  renameRepoSlot(state, 'cfg-repo', 'cfg-renamed');
  assert.ok(state.repos['cfg-renamed']);
  assert.equal(state.repos['cfg-repo'], undefined);

  saveState(file, state);
  const back = loadState(file);
  assert.equal(getRenamed(back)['cfg-repo'].name, 'cfg-renamed');
  assert.equal(back.userRepos[0].name, 'new-run');
  rmSync(dir, { recursive: true, force: true });
});

test('github: renameRepo 发 PATCH 且不泄漏 token', async () => {
  const fetchImpl = mockFetch((url, init) => {
    if (init.method === 'PATCH') {
      assert.equal(url, 'https://api.github.com/repos/o/old-name');
      assert.deepEqual(JSON.parse(init.body), { name: 'new-name' });
      return { status: 200, body: { full_name: 'o/new-name', html_url: 'https://github.com/o/new-name', default_branch: 'main' } };
    }
    return { status: 404, body: { message: 'Not Found' } };
  });
  const client = new GitHubClient({ token: 'ghp_TOPSECRET', fetchImpl });
  const result = await client.renameRepo('o/old-name', 'new-name');
  assert.equal(result.fullName, 'o/new-name');
  assert.equal(result.htmlUrl, 'https://github.com/o/new-name');
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes('ghp_TOPSECRET')), 'token 不进 URL');
});

test('git: setRemoteUrl 真实改本地远端地址', async () => {
  const { dir, remoteDir } = await makeRemote();
  const target = path.join(dir, 'clone');
  const cl = await cloneRepo(remoteDir, target);
  assert.equal(cl.ok, true);
  const newUrl = 'https://github.com/o/renamed.git';
  const set = await setRemoteUrl(target, 'origin', newUrl);
  assert.equal(set.ok, true, `set-url failed: ${set.stderr}`);
  assert.equal(await remoteUrl(target, 'origin'), newUrl);
  rmSync(dir, { recursive: true, force: true });
});
