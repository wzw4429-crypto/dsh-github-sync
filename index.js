/**
 * dsh-github-sync —— Host 入口。
 *
 * 能力：
 *  - 定时双向同步（含推送前本地检查）
 *  - GitHub Actions 触发/监控、CI 状态查询
 *  - DSH 自动化流水线（同步 → 确保 CI workflow → 触发 → 等结论 → 汇报/唤醒 agent）
 *  - Agent 工具（github_sync / github_status / github_ci / github_workflow）
 *  - Web 面板数据接口（GET /api/github-sync/status、POST /api/github-sync/action）
 *
 * @module dsh-github-sync
 */
import path from 'node:path';
import { normalizeConfig, resolveToken, redactedConfig } from './lib/config.js';
import * as stateLib from './lib/state.js';
import { syncRepo, repoSnapshot } from './lib/sync.js';
import { remoteUrl as gitRemoteUrl, gitAuthEnv, setRemoteUrl as gitSetRemoteUrl } from './lib/git.js';
import { mergeRepos, normalizeRepoInput, defaultClonePath, cloneRepo, isGitWorkTree, slimRepoList } from './lib/repos.js';
import { listLocalDir, readLocalFile } from './lib/localfs.js';
import { probeActivity, activityScore, isActive } from './lib/activity.js';
import { runPipeline } from './lib/pipeline.js';
import { GitHubClient, GitHubError, parseRepoRef, ensureCiWorkflow, DEFAULT_CI_FILENAME, DEFAULT_CI_CONTENT } from './lib/github.js';
import { buildTools } from './lib/tools.js';

export const inject = ['tools', 'connection'];

const NOTIFY_EVENT_OF = {
  conflict: 'conflict',
  error: 'error',
  'checks-blocked': 'checks',
  dirty: 'checks',
  pulled: 'pull',
  pushed: 'push',
  synced: 'push',
};

function storageFile(cfg, ctx) {
  try {
    if (cfg.storageFile) return path.resolve(cfg.storageFile);
    // Host 进程本身没有 DSH_PROFILE_DIR（shell overlay 只给子进程），向 profile context 要。
    let dir = process.env.DSH_PROFILE_DIR;
    if (!dir && ctx && typeof ctx.get === 'function') {
      const profile = ctx.get('profileContext');
      if (profile && typeof profile.dir === 'string' && profile.dir) dir = profile.dir;
    }
    if (dir) return path.join(dir, 'github-sync-state.json');
  } catch {}
  return null;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const file = storageFile(cfg, ctx);
  const state = stateLib.loadState(file);
  state.bootedAt = Date.now();
  state.codeGen = 3; // 代码代号指纹：重启加载新代码后可在状态文件自检
  const persist = () => {
    try {
      state.updatedAt = Date.now();
      stateLib.saveState(file, state);
    } catch {}
  };
  persist();

  const log = (msg) => {
    try { console.log(`[dsh-github-sync] ${msg}`); } catch {}
  };

  // ---------- agent 通知 ----------
  const agents = new Set();
  try {
    const map = ctx.get('agents');
    if (map && typeof map.forEach === 'function') map.forEach((a) => agents.add(a));
  } catch {}
  try {
    const stop = ctx.on('agent/created', ({ agent }) => { if (agent) agents.add(agent); });
    if (typeof stop === 'function') ctx.effect(() => stop());
  } catch {}
  const notify = (text) => {
    if (!cfg.notifyAgent) return;
    for (const agent of [...agents]) {
      try {
        agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } });
      } catch {}
    }
  };
  const maybeNotify = (event, text) => {
    if (cfg.notifyOn.includes(event)) notify(`[dsh-github-sync] ${text}`);
  };

  // ---------- 核心服务（工具与面板共用） ----------
  const clientFor = () => new GitHubClient({ token: resolveToken(cfg) });

  const prepareRepo = async (repo) => {
    let remoteUrl = '';
    try {
      remoteUrl = await gitRemoteUrl(repo.path, repo.remote);
    } catch {}
    const parsed = parseRepoRef(remoteUrl);
    return { ...repo, remoteUrl, githubRepo: parsed ? `${parsed.owner}/${parsed.repo}` : '' };
  };

  // 运行时加入的仓库（面板/工具添加）与配置仓库合并；配置优先去重；再套用改名映射。
  const mergedRepos = () => {
    const renames = stateLib.getRenamed(state);
    const base = mergeRepos(cfg.repos, stateLib.getUserRepos(state), cfg);
    return base.map((r) => {
      const hit = renames[r.name];
      if (hit && hit.name && hit.name !== r.name) return { ...r, name: hit.name, url: hit.url || r.url };
      return r;
    });
  };
  const findRepo = (name) => mergedRepos().find((r) => r.name === name);

  // 全部仓库列表里标记“已加入同步”：按 URL/owner-repo 名匹配。
  const markSynced = async (repos) => {
    const keys = new Set();
    for (const repo of mergedRepos()) {
      let url = repo.url || '';
      if (!url) {
        try { url = await gitRemoteUrl(repo.path, repo.remote); } catch {}
      }
      const norm = String(url || '').toLowerCase().replace(/\.git$/, '');
      if (norm) keys.add(norm);
      const parsed = parseRepoRef(url || repo.name);
      if (parsed) keys.add(`${parsed.owner}/${parsed.repo}`.toLowerCase());
    }
    return repos.map((r) => ({
      ...r,
      synced: keys.has(String(r.htmlUrl || '').toLowerCase().replace(/\.git$/, '')) || keys.has(String(r.fullName || '').toLowerCase()),
    }));
  };

  const runSyncOne = async (repo) => {
    const enriched = await prepareRepo(repo);
    // git fetch/push 的 PAT 经 env 注入（lib/git.js gitAuthEnv），不进进程参数/日志
    const result = await syncRepo(enriched, { log, token: resolveToken(cfg) });
    stateLib.recordSync(state, repo.name, result);
    persist();
    const event = NOTIFY_EVENT_OF[result.status];
    if (event) maybeNotify(event, `${repo.name}: ${result.status} — ${result.message}`);
    return result;
  };

  const runPipelineOne = async (repo) => {
    const enriched = await prepareRepo(repo);
    const result = await runPipeline({
      repo: enriched,
      config: cfg,
      sync: (r) => runSyncOne(repo),
      client: clientFor(),
      log,
    });
    stateLib.recordPipeline(state, repo.name, result);
    persist();
    maybeNotify('pipeline', `${repo.name}: pipeline ${result.status} — ${result.message}`);
    return result;
  };

  const services = {
    /** 工具入口：action='sync'|'pipeline'，name 省略=全部仓库。 */
    async run(action, name) {
      const targets = name ? [findRepo(name)].filter(Boolean) : mergedRepos();
      if (name && targets.length === 0) throw new Error(`unknown repo: ${name}`);
      const results = [];
      for (const repo of targets) {
        results.push(action === 'pipeline' ? await runPipelineOne(repo) : await runSyncOne(repo));
      }
      return results;
    },

    /** 状态报告（面板 GET 与 github_status 工具共用）。活跃仓库排前面。 */
    async statusReport(name) {
      const targets = name ? [findRepo(name)].filter(Boolean) : mergedRepos();
      const repos = [];
      for (const repo of targets) {
        const snapshot = await repoSnapshot(repo);
        const slot = stateLib.getRepoState(state, repo.name);
        let activity = { dirty: Boolean(snapshot.dirty), lastCommitTs: 0, newestFileTs: 0, score: 0, active: false };
        try {
          const probe = await probeActivity(repo.path);
          const now = Date.now();
          const signals = { dirty: Boolean(snapshot.dirty), lastCommitTs: probe.lastCommitTs, newestFileTs: probe.newestFileTs };
          activity = { ...signals, score: activityScore(signals, now), active: isActive(signals, now) };
        } catch {}
        repos.push({
          name: repo.name,
          path: repo.path,
          remote: repo.remote,
          branch: repo.branch || snapshot.branch,
          mode: repo.mode,
          source: repo.source || 'config',
          url: repo.url || snapshot.remoteUrl,
          addedAt: repo.addedAt || 0,
          activity,
          snapshot,
          lastSync: slot.lastSync,
          lastPipeline: slot.lastPipeline,
          history: slot.history.slice(-8),
          ci: slot.ci,
        });
      }
      repos.sort((a, b) => (b.activity ? b.activity.score : 0) - (a.activity ? a.activity.score : 0));
      return {
        ok: true,
        now: Date.now(),
        storageFile: file,
        config: redactedConfig(cfg),
        repos,
      };
    },

    /** CI 查询：runs / checks / status。 */
    async ciStatus(name, { action = 'runs', ref, perPage } = {}) {
      const repo = findRepo(name);
      if (!repo) throw new Error(`unknown repo: ${name}`);
      const enriched = await prepareRepo(repo);
      if (!enriched.githubRepo) throw new Error(`${name}: cannot derive owner/repo from remote "${enriched.remoteUrl}"`);
      const client = clientFor();
      const target = ref || enriched.githubRepo;
      if (action === 'runs') {
        const runs = await client.listRuns(enriched.githubRepo, { branch: ref, perPage: perPage || 10 });
        const slim = runs.map((r) => ({
          id: r.id,
          name: r.name,
          event: r.event,
          branch: r.head_branch,
          status: r.status,
          conclusion: r.conclusion,
          run_number: r.run_number,
          created_at: r.created_at,
          updated_at: r.updated_at,
          html_url: r.html_url,
        }));
        stateLib.setCi(state, name, { kind: 'runs', runs: slim.slice(0, 5) });
        persist();
        return { repo: enriched.githubRepo, action, runs: slim };
      }
      const sha = ref || 'HEAD';
      if (action === 'checks') {
        const checks = await client.checkRuns(enriched.githubRepo, sha);
        return {
          repo: enriched.githubRepo,
          action,
          ref: sha,
          checks: checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, html_url: c.html_url })),
        };
      }
      const status = await client.combinedStatus(enriched.githubRepo, sha);
      return {
        repo: enriched.githubRepo,
        action,
        ref: sha,
        state: status.state,
        total: status.total_count,
        statuses: (status.statuses || []).map((s) => ({ context: s.context, state: s.state, description: s.description, html_url: s.target_url })),
      };
    },

    /** workflow 列表。 */
    async workflowList(name) {
      const repo = findRepo(name);
      if (!repo) throw new Error(`unknown repo: ${name}`);
      const enriched = await prepareRepo(repo);
      if (!enriched.githubRepo) throw new Error(`${name}: cannot derive owner/repo from remote "${enriched.remoteUrl}"`);
      const workflows = await clientFor().listWorkflows(enriched.githubRepo);
      return workflows.map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state }));
    },

    /** 触发 workflow_dispatch。 */
    async workflowDispatch(name, { workflow, ref, inputs } = {}) {
      const repo = findRepo(name);
      if (!repo) throw new Error(`unknown repo: ${name}`);
      const enriched = await prepareRepo(repo);
      if (!enriched.githubRepo) throw new Error(`${name}: cannot derive owner/repo from remote "${enriched.remoteUrl}"`);
      const wf = workflow || repo.workflowFile;
      if (!wf) throw new Error(`${name}: no workflow specified (set ciWorkflow in config or pass workflow)`);
      const branch = ref || repo.branch || (await repoSnapshot(repo)).branch;
      await clientFor().dispatchWorkflow(enriched.githubRepo, wf, branch, inputs);
      return { repo: enriched.githubRepo, workflow: wf, branch, dispatched: true, message: `dispatched ${wf} on ${branch}` };
    },

    /** 确保 CI workflow 文件存在（pipeline / 面板按钮用）。 */
    async ensureWorkflow(name) {
      const repo = findRepo(name);
      if (!repo) throw new Error(`unknown repo: ${name}`);
      const enriched = await prepareRepo(repo);
      if (!enriched.githubRepo) throw new Error(`${name}: cannot derive owner/repo from remote "${enriched.remoteUrl}"`);
      const snapshot = await repoSnapshot(repo);
      return ensureCiWorkflow(clientFor(), enriched.githubRepo, {
        branch: snapshot.branch,
        filename: DEFAULT_CI_FILENAME,
        content: DEFAULT_CI_CONTENT,
      });
    },

    /** 当前账号的全部 GitHub 仓库（需 PAT；缓存 5 分钟，refresh 强制刷新）。 */
    async listAllRepos({ refresh = false } = {}) {
      if (!resolveToken(cfg)) {
        throw new Error('列出全部仓库需要 GitHub PAT（在插件 config 里填 token 或设 tokenEnv 环境变量）');
      }
      const cached = stateLib.getAllRepos(state);
      if (!refresh && cached && Date.now() - (cached.fetchedAt || 0) < 5 * 60000) {
        return { fetchedAt: cached.fetchedAt, cached: true, repos: await markSynced(cached.repos) };
      }
      const client = clientFor();
      const all = [];
      for (let page = 1; page <= 3; page++) {
        const batch = await client.listUserRepos({ perPage: 100, page });
        all.push(...slimRepoList(batch));
        if (batch.length < 100) break;
      }
      stateLib.setAllRepos(state, all);
      persist();
      return { fetchedAt: Date.now(), cached: false, repos: await markSynced(all) };
    },

    /**
     * 加入同步列表：url / owner/name / git@ 均可；path 缺省克隆到 cloneRoot/<owner>/<name>。
     * 本地路径已是 git 工作树时直接注册，不重复克隆。
     */
    async addRepo({ url, path: targetPath, name } = {}) {
      const norm = normalizeRepoInput(url);
      if (!norm) throw new Error(`无法识别仓库地址（支持 owner/name、https://github.com/owner/repo、git@github.com:owner/repo.git）: ${String(url)}`);
      const dir = targetPath && String(targetPath).trim()
        ? String(targetPath).trim()
        : defaultClonePath(cfg.cloneRoot, norm.owner, norm.name);
      const exists = await isGitWorkTree(dir);
      if (mergedRepos().some((r) => r.name === (name || norm.name))) {
        throw new Error(`同名仓库已在同步列表: ${name || norm.name}`);
      }
      let cloned = false;
      if (!exists) {
        const r = await cloneRepo(norm.url, dir, { env: gitAuthEnv(norm.url, resolveToken(cfg)) });
        if (!r.ok) throw new Error(`clone 失败: ${r.stderr || r.error || `exit ${r.code}`}`);
        cloned = true;
      }
      const entry = { name: name || norm.name, path: dir, url: norm.url, remote: 'origin', branch: '', addedAt: Date.now() };
      stateLib.addUserRepo(state, entry);
      persist();
      const repo = mergeRepos(cfg.repos, stateLib.getUserRepos(state), cfg).find((r) => r.path === dir);
      return { entry, cloned, reused: exists, snapshot: await repoSnapshot(repo) };
    },

    /** 从同步列表移除一个运行时加入的仓库（只移出列表，不动磁盘文件）。 */
    async removeRepo(name) {
      const removed = stateLib.removeUserRepo(state, name);
      if (!removed) throw new Error(`不是运行时加入的仓库: ${name}（配置仓库请改 cordis.patch.yml）`);
      persist();
      return { removed: name };
    },

    /**
     * 改名并同步到 GitHub：PATCH /repos/{owner}/{repo}（需 admin）→
     * 本地 remote set-url → 注册表更新（runtime 条目直改；配置仓库写改名映射，不改配置文件）→ 历史槽位跟随新名。
     */
    async renameRepo(name, newName) {
      const clean = String(newName || '').trim();
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(clean)) {
        throw new Error(`非法仓库名（GitHub 允许 字母数字 . _ -）: ${newName}`);
      }
      const repo = findRepo(name);
      if (!repo) throw new Error(`unknown repo: ${name}`);
      if (clean === name) return { renamed: false, name, message: '名称未变化' };
      if (mergedRepos().some((r) => r.name === clean)) throw new Error(`目标名已在同步列表: ${clean}`);
      const enriched = await prepareRepo(repo);
      if (!enriched.githubRepo) {
        throw new Error(`${name}: 无法从远端地址解析 owner/repo，不能在 GitHub 上改名`);
      }
      const renamed = await clientFor().renameRepo(enriched.githubRepo, clean);
      const newUrl = `https://github.com/${renamed.fullName}.git`;
      await gitSetRemoteUrl(repo.path, repo.remote, newUrl);
      if (repo.source === 'runtime') {
        stateLib.updateUserRepo(state, repo.name, { name: clean, url: newUrl });
      } else {
        stateLib.setRenamed(state, repo.name, { name: clean, url: newUrl });
      }
      stateLib.renameRepoSlot(state, repo.name, clean);
      persist();
      return {
        renamed: true,
        oldName: name,
        name: clean,
        fullName: renamed.fullName,
        htmlUrl: renamed.htmlUrl,
        localRemoteUpdated: true,
        message: `已改名 ${name} → ${renamed.fullName}（GitHub + 本地 remote）`,
      };
    },

    /** 本地浏览目录（直接读磁盘，不走 GitHub、不需 PAT；路径被约束在仓库根内）。 */
    async localFiles(name, relPath) {
      const repo = findRepo(name);
      if (!repo) throw new Error(`unknown repo: ${name}`);
      return listLocalDir(repo.path, relPath);
    },

    /** 本地读文件预览（文本；二进制只回元数据）。 */
    async localFile(name, relPath) {
      const repo = findRepo(name);
      if (!repo) throw new Error(`unknown repo: ${name}`);
      return readLocalFile(repo.path, relPath);
    },

    /** Actions run 详情：run 元数据 + jobs（含每一步结论）。 */
    async runDetail(name, runId) {
      const repo = findRepo(name);
      if (!repo) throw new Error(`unknown repo: ${name}`);
      const enriched = await prepareRepo(repo);
      if (!enriched.githubRepo) throw new Error(`${name}: 无法从远端地址解析 owner/repo`);
      const id = Number(runId);
      if (!Number.isFinite(id) || id <= 0) throw new Error(`invalid runId: ${runId}`);
      const client = clientFor();
      const run = await client.getRun(enriched.githubRepo, id);
      const jobs = await client.listRunJobs(enriched.githubRepo, id);
      return {
        repo: enriched.githubRepo,
        run: {
          id: run.id,
          name: run.name,
          run_number: run.run_number,
          event: run.event,
          branch: run.head_branch,
          status: run.status,
          conclusion: run.conclusion,
          html_url: run.html_url,
          created_at: run.created_at,
          updated_at: run.updated_at,
          triggered_by: (run.triggering_actor && run.triggering_actor.login) || '',
        },
        jobs: jobs.map((j) => ({
          name: j.name,
          status: j.status,
          conclusion: j.conclusion,
          started_at: j.started_at,
          completed_at: j.completed_at,
          steps: (j.steps || []).map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion })),
        })),
      };
    },

    /** 浏览仓库文件（GitHub contents API；dir 返回条目列表，file 返回文本预览）。 */
    async listFiles(name, filePath, ref) {
      const repo = findRepo(name);
      if (!repo) throw new Error(`unknown repo: ${name}`);
      const enriched = await prepareRepo(repo);
      if (!enriched.githubRepo) throw new Error(`${name}: 无法从远端地址解析 owner/repo`);
      const data = await clientFor().getFile(enriched.githubRepo, filePath || '', ref || repo.branch || undefined);
      if (Array.isArray(data)) {
        return {
          kind: 'dir',
          path: filePath || '',
          entries: data.map((e) => ({ name: e.name, path: e.path, type: e.type, size: Number(e.size) || 0 })),
        };
      }
      const size = Number(data.size) || 0;
      const content = typeof data.content === 'string' ? Buffer.from(data.content, 'base64').toString('utf8') : '';
      const truncated = size > 131072 || content.length > 131072;
      return { kind: 'file', path: data.path, size, truncated, content: truncated ? content.slice(0, 131072) : content };
    },
  };

  // ---------- Agent 工具 ----------
  for (const definition of buildTools(services)) {
    try {
      const dispose = ctx.tools.register(definition);
      if (typeof dispose === 'function') ctx.effect(() => dispose());
    } catch (err) {
      log(`tool register failed (${definition.name}): ${String((err && err.message) || err)}`);
    }
  }

  // ---------- Web 面板数据接口 ----------
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/github-sync/status',
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return json(await services.statusReport());
        } catch (err) {
          return json({ ok: false, error: String((err && err.message) || err) }, 500);
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/github-sync/action',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = null;
        try {
          const text = await request.text();
          body = text ? JSON.parse(text) : null;
        } catch {}
        if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad-body' }, 400);
        const action = String(body.action || '');
        const name = body.repo ? String(body.repo) : undefined;
        try {
          switch (action) {
            case 'sync':
            case 'pipeline': {
              const results = await services.run(action, name);
              return json({ ok: results.every((r) => r.ok), results });
            }
            case 'refresh':
              return json(await services.statusReport(name));
            case 'dispatch-ci': {
              const value = await services.workflowDispatch(name, {
                workflow: body.workflow ? String(body.workflow) : '',
                ref: body.ref ? String(body.ref) : '',
                inputs: body.inputs && typeof body.inputs === 'object' ? body.inputs : undefined,
              });
              return json({ ok: true, ...value });
            }
            case 'ensure-workflow': {
              const value = await services.ensureWorkflow(name);
              return json({ ok: true, ...value });
            }
            case 'list-repos': {
              const value = await services.listAllRepos({ refresh: body.refresh === true });
              return json({ ok: true, ...value });
            }
            case 'add-repo': {
              const value = await services.addRepo({
                url: body.url !== undefined ? body.url : body.repo,
                path: body.path,
                name: body.name,
              });
              return json({ ok: true, ...value });
            }
            case 'remove-repo': {
              const value = await services.removeRepo(name || String(body.name || ''));
              return json({ ok: true, ...value });
            }
            case 'list-files': {
              const value = await services.listFiles(
                name || '',
                body.path !== undefined ? String(body.path) : '',
                body.ref !== undefined ? String(body.ref) : undefined,
              );
              return json({ ok: true, ...value });
            }
            case 'rename-repo': {
              const value = await services.renameRepo(name || '', body.newName);
              return json({ ok: true, ...value });
            }
            case 'local-files': {
              const value = await services.localFiles(name || '', body.path !== undefined ? String(body.path) : '');
              return json({ ok: true, ...value });
            }
            case 'local-file': {
              const value = await services.localFile(name || '', body.path !== undefined ? String(body.path) : '');
              return json({ ok: true, ...value });
            }
            case 'run-detail': {
              const value = await services.runDetail(name || '', body.runId);
              return json({ ok: true, ...value });
            }
            case 'ci-runs': {
              const value = await services.ciStatus(name || '', { action: 'runs', perPage: body.perPage ? Number(body.perPage) : undefined });
              return json({ ok: true, ...value });
            }
            default:
              return json({ ok: false, error: `unknown action: ${action}` }, 400);
          }
        } catch (err) {
          const status = err instanceof GitHubError ? 502 : 500;
          return json({ ok: false, error: String((err && err.message) || err) }, status);
        }
      },
    }),
  );

  // ---------- 定时器 ----------
  let ticking = false;
  const tick = async () => {
    if (ticking || !cfg.enabled) return;
    ticking = true;
    try {
      for (const repo of mergedRepos()) {
        await runSyncOne(repo);
      }
    } catch (err) {
      log(`scheduler tick failed: ${String((err && err.message) || err)}`);
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(tick, cfg.intervalMinutes * 60000);
  ctx.effect(() => clearInterval(timer));
  if (cfg.enabled && cfg.runOnStart) {
    const boot = setTimeout(tick, 5000);
    ctx.effect(() => clearTimeout(boot));
  }

  log(`applied: ${mergedRepos().length} repo(s), interval ${cfg.intervalMinutes}min, enabled=${cfg.enabled}, storage=${file || '(none)'}`);
}
