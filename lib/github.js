/**
 * GitHub REST API 客户端（PAT 认证）。token 绝不进入错误消息/返回值。
 *
 * @module dsh-github-sync/github
 */

export class GitHubError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code;
  }
}

/** 解析 owner/name：支持 `owner/name`、https URL、git@ SSH URL。 */
export function parseRepoRef(ref) {
  const s = String(ref || '').trim();
  let m = s.match(/^(?:https?:\/\/)?(?:git@)?github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i);
  if (!m) m = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
}

function codeForStatus(status) {
  if (status === 401) return 'bad-credentials';
  if (status === 403) return 'rate-limited-or-forbidden';
  if (status === 404) return 'not-found';
  return `http-${status}`;
}

export class GitHubClient {
  /**
   * @param {{token?: string, apiUrl?: string, fetchImpl?: typeof fetch}} [opts]
   */
  constructor(opts = {}) {
    this.token = opts.token || '';
    this.apiUrl = (opts.apiUrl || 'https://api.github.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
  }

  headers(extra = {}) {
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-github-sync',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  /**
   * 发请求。错误消息只含 HTTP 状态与 API 返回的 message（GitHub 不回显 token）。
   */
  async request(method, path, { query, body, accept } = {}) {
    const url = new URL(this.apiUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    let res;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers: this.headers(accept ? { accept } : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw new GitHubError(`network error: ${String((err && err.message) || err)}`, 0, 'network');
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const msg = (data && data.message) || `HTTP ${res.status}`;
      throw new GitHubError(`GitHub API ${method} ${path} failed: ${msg}`, res.status, codeForStatus(res.status));
    }
    return data;
  }

  /** 仓库信息（默认分支等）。 */
  repoInfo(ref) {
    const { owner, repo } = this.#parts(ref);
    return this.request('GET', `/repos/${owner}/${repo}`);
  }

  /** 当前 token 可见的全部仓库（/user/repos，需 PAT；调用方负责分页）。 */
  async listUserRepos({ perPage = 100, page = 1 } = {}) {
    const data = await this.request('GET', '/user/repos', {
      query: { per_page: perPage, page, sort: 'updated', affiliation: 'owner,collaborator,organization_member' },
    });
    return Array.isArray(data) ? data : [];
  }

  /** 在 GitHub 上重命名仓库（需 admin 权限）。返回 {fullName, htmlUrl, defaultBranch}。 */
  async renameRepo(ref, newName) {
    const { owner, repo } = this.#parts(ref);
    const data = await this.request('PATCH', `/repos/${owner}/${repo}`, { body: { name: String(newName) } });
    return {
      fullName: data.full_name || `${owner}/${newName}`,
      htmlUrl: data.html_url || `https://github.com/${owner}/${newName}`,
      defaultBranch: data.default_branch || '',
    };
  }

  /** workflow 列表。 */
  async listWorkflows(ref) {
    const { owner, repo } = this.#parts(ref);
    const data = await this.request('GET', `/repos/${owner}/${repo}/actions/workflows`, { query: { per_page: 100 } });
    return (data && data.workflows) || [];
  }

  /** 触发 workflow_dispatch。workflow 为文件名（ci.yml）、路径或数字 id。 */
  async dispatchWorkflow(ref, workflow, branch, inputs) {
    const { owner, repo } = this.#parts(ref);
    const wf = String(workflow || '').replace(/^\.github\/workflows\//, '');
    await this.request('POST', `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(wf)}/dispatches`, {
      body: { ref: branch, ...(inputs && Object.keys(inputs).length ? { inputs } : {}) },
    });
    return true;
  }

  /** 最近的 workflow runs。 */
  async listRuns(ref, { workflowId, branch, event, perPage = 10 } = {}) {
    const { owner, repo } = this.#parts(ref);
    const base = workflowId
      ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/runs`
      : `/repos/${owner}/${repo}/actions/runs`;
    const data = await this.request('GET', base, {
      query: { per_page: perPage, ...(branch ? { branch } : {}), ...(event ? { event } : {}) },
    });
    return (data && data.workflow_runs) || [];
  }

  /** 单个 run（含 status/conclusion）。 */
  async getRun(ref, runId) {
    const { owner, repo } = this.#parts(ref);
    return this.request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}`);
  }

  /** run 的 jobs 列表（步骤级结论）。 */
  async listRunJobs(ref, runId) {
    const { owner, repo } = this.#parts(ref);
    const data = await this.request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, { query: { per_page: 50 } });
    return (data && data.jobs) || [];
  }

  /** 某 commit 的 check runs。 */
  async checkRuns(ref, sha) {
    const { owner, repo } = this.#parts(ref);
    const data = await this.request('GET', `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/check-runs`);
    return (data && data.check_runs) || [];
  }

  /** 某 commit 的 combined status（旧式 commit status）。 */
  async combinedStatus(ref, sha) {
    const { owner, repo } = this.#parts(ref);
    return this.request('GET', `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/status`);
  }

  /** 读取文件/目录（contents API；path 空 = 仓库根）。不存在抛 code='not-found'。 */
  async getFile(ref, path, branch) {
    const { owner, repo } = this.#parts(ref);
    const suffix = String(path || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return this.request('GET', `/repos/${owner}/${repo}/contents${suffix ? '/' + suffix : ''}`, {
      query: branch ? { ref: branch } : undefined,
    });
  }

  /** 创建/更新文件（contents API，base64）。 */
  putFile(ref, path, { message, contentBase64, branch, sha }) {
    const { owner, repo } = this.#parts(ref);
    return this.request('PUT', `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      body: { message, content: contentBase64, ...(branch ? { branch } : {}), ...(sha ? { sha } : {}) },
    });
  }

  #parts(ref) {
    const parsed = typeof ref === 'object' && ref ? ref : parseRepoRef(ref);
    if (!parsed) throw new GitHubError(`invalid repo reference: ${String(ref)}`, 0, 'bad-repo-ref');
    return parsed;
  }
}

/** 默认 CI workflow 模板（ensureCiWorkflow 用）。 */
export const DEFAULT_CI_FILENAME = '.github/workflows/dsh-ci.yml';
export const DEFAULT_CI_CONTENT = `name: DSH CI
on:
  push:
  pull_request:
  workflow_dispatch:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci || npm install
      - run: npm test
`;

/**
 * 仓库缺少 CI workflow 时创建之。
 * @returns {Promise<{created: boolean, path: string, message: string}>}
 */
export async function ensureCiWorkflow(client, ref, { branch, filename = DEFAULT_CI_FILENAME, content = DEFAULT_CI_CONTENT, message = 'ci: add DSH CI workflow' } = {}) {
  try {
    await client.getFile(ref, filename, branch);
    return { created: false, path: filename, message: 'workflow already exists' };
  } catch (err) {
    if (!(err instanceof GitHubError) || err.code !== 'not-found') {
      return { created: false, path: filename, message: `probe failed: ${err.message}` };
    }
  }
  await client.putFile(ref, filename, {
    message,
    contentBase64: Buffer.from(content, 'utf8').toString('base64'),
    branch,
  });
  return { created: true, path: filename, message: 'workflow created' };
}
