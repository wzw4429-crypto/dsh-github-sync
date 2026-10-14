/**
 * Agent 工具定义：github_sync / github_status / github_ci / github_workflow。
 * 与 Web 面板共用同一组 services 方法（user-actions.md：同一操作只实现一次）。
 *
 * @module dsh-github-sync/tools
 */

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    results: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  additionalProperties: true,
};

function textRender(_args, value) {
  try {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  } catch {
    return [{ type: 'text', text: String(value) }];
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

/**
 * 生成工具定义数组。
 *
 * @param {object} services { runSync, runPipeline, statusReport, ciStatus, workflowList, workflowDispatch }
 */
export function buildTools(services) {
  return [
    {
      name: 'github_sync',
      description:
        'Sync configured GitHub repositories (bidirectional git sync with optional pre-push local checks) or run the full automation pipeline (sync -> ensure CI workflow -> dispatch GitHub Actions -> wait for conclusion). Use action "sync" for a plain sync round, "pipeline" for the full DSH automation pipeline. Omit repo to run for every configured repository.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"sync" (default) or "pipeline".', enum: ['sync', 'pipeline'] },
          repo: { type: 'string', description: 'Repository name from plugin config; omit for all repos.' },
        },
      },
      output: RESULT_SCHEMA,
      render: textRender,
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.();
        const action = args?.action === 'pipeline' ? 'pipeline' : 'sync';
        const results = await services.run(action, args?.repo ? String(args.repo) : undefined);
        return { ok: results.every((r) => r.ok), results };
      },
    },
    {
      name: 'github_status',
      description:
        'Report sync/CI status for configured GitHub repositories: last sync result, ahead/behind counts, dirty working tree, last pipeline result, cached CI status, and effective config (token redacted).',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository name; omit for all repos.' },
        },
      },
      output: RESULT_SCHEMA,
      render: textRender,
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.();
        const report = await services.statusReport(args?.repo ? String(args.repo) : undefined);
        return { ok: true, ...report };
      },
    },
    {
      name: 'github_ci',
      description:
        'Query GitHub Actions / CI status for a repository: recent workflow runs ("runs"), check runs for a commit ("checks"), the combined commit status ("status"), or one run\'s jobs/steps detail ("run-detail" + runId). Requires a PAT (token/tokenEnv in plugin config).',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository name from plugin config.' },
          action: { type: 'string', description: '"runs" (default) | "checks" | "status" | "run-detail".', enum: ['runs', 'checks', 'status', 'run-detail'] },
          ref: { type: 'string', description: 'Branch name or commit SHA for checks/status; default HEAD.' },
          perPage: { type: 'integer', description: 'Max runs to return (default 10).' },
          runId: { type: 'integer', description: 'Run id; required for run-detail (get it from runs).' },
        },
        required: ['repo'],
      },
      output: RESULT_SCHEMA,
      render: textRender,
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.();
        if (args?.action === 'run-detail') {
          const value = await services.runDetail(String(args.repo), args?.runId);
          return { ok: true, ...value };
        }
        const action = ['checks', 'status'].includes(args?.action) ? args.action : 'runs';
        const value = await services.ciStatus(String(args.repo), {
          action,
          ref: args?.ref ? String(args.ref) : undefined,
          perPage: args?.perPage ? Number(args.perPage) : undefined,
        });
        return { ok: true, ...value };
      },
    },
    {
      name: 'github_workflow',
      description:
        'Manage GitHub Actions workflows: list workflows ("list") or dispatch one via workflow_dispatch ("dispatch", optionally waiting for its conclusion through the pipeline wait logic). Requires a PAT.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository name from plugin config.' },
          action: { type: 'string', description: '"list" | "dispatch".', enum: ['list', 'dispatch'] },
          workflow: { type: 'string', description: 'Workflow file name (e.g. ci.yml) or id. Required for dispatch.' },
          ref: { type: 'string', description: 'Branch to dispatch on; default the repo sync branch.' },
          inputs: { type: 'object', description: 'workflow_dispatch inputs (key/value).' },
        },
        required: ['repo', 'action'],
      },
      output: RESULT_SCHEMA,
      render: textRender,
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.();
        const repo = String(args.repo);
        if (args.action === 'list') {
          const workflows = await services.workflowList(repo);
          return { ok: true, workflows: asArray(workflows) };
        }
        const value = await services.workflowDispatch(repo, {
          workflow: args?.workflow ? String(args.workflow) : '',
          ref: args?.ref ? String(args.ref) : '',
          inputs: args?.inputs && typeof args.inputs === 'object' ? args.inputs : undefined,
        });
        return { ok: true, ...value };
      },
    },
    {
      name: 'github_repos',
      description:
        'Manage the GitHub repository inventory: "list" all repositories visible to the configured PAT (cached 5 min; refresh=true forces a re-fetch), "add" a repository to the sync list by URL/owner-name (clones it when the local path is missing), "remove" a runtime-added repository, or "rename" a sync-listed repo on GitHub (PATCH /repos, needs admin) and update its local remote URL. Requires a PAT for "list"/"add-by-clone"/"rename".',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"list" (default) | "add" | "remove" | "rename".', enum: ['list', 'add', 'remove', 'rename'] },
          url: { type: 'string', description: 'For add: owner/name, https://github.com/owner/repo or git@ URL.' },
          path: { type: 'string', description: 'For add: local directory; omit to clone into <cloneRoot>/<owner>/<name>.' },
          repo: { type: 'string', description: 'For remove/rename: current repository name from the sync list.' },
          newName: { type: 'string', description: 'For rename: new GitHub repo name (letters, digits, . _ -).' },
          refresh: { type: 'boolean', description: 'For list: force refresh of the cached inventory.' },
        },
      },
      output: RESULT_SCHEMA,
      render: textRender,
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.();
        const action = ['add', 'remove', 'rename'].includes(args?.action) ? args.action : 'list';
        if (action === 'add') {
          const value = await services.addRepo({
            url: args?.url !== undefined ? String(args.url) : args?.repo !== undefined ? String(args.repo) : '',
            path: args?.path ? String(args.path) : undefined,
            name: args?.repo && args?.url ? String(args.repo) : undefined,
          });
          return { ok: true, ...value };
        }
        if (action === 'remove') {
          const value = await services.removeRepo(args?.repo ? String(args.repo) : '');
          return { ok: true, ...value };
        }
        if (action === 'rename') {
          const value = await services.renameRepo(args?.repo ? String(args.repo) : '', args?.newName);
          return { ok: true, ...value };
        }
        const value = await services.listAllRepos({ refresh: args?.refresh === true });
        return { ok: true, ...value };
      },
    },
    {
      name: 'github_files',
      description:
        'Browse repository files: "local" source (default — reads the local clone on disk, no PAT needed, path-constrained to the repo root) or "github" source (GitHub contents API at a branch). Lists a directory or previews one file as text (~128 KB cap; binary files return metadata only).',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository name from the sync list.' },
          path: { type: 'string', description: 'Directory or file path inside the repo; omit for root.' },
          ref: { type: 'string', description: 'For github source: branch name; default the repo sync branch.' },
          source: { type: 'string', description: '"local" (default) | "github".', enum: ['local', 'github'] },
        },
        required: ['repo'],
      },
      output: RESULT_SCHEMA,
      render: textRender,
      async execute(args, exec) {
        exec?.signal?.throwIfAborted?.();
        const p = args?.path ? String(args.path) : '';
        if (args?.source === 'github') {
          const value = await services.listFiles(String(args.repo), p, args?.ref ? String(args.ref) : undefined);
          return { ok: true, ...value };
        }
        const value = p
          ? await services.localFile(String(args.repo), p)
          : await services.localFiles(String(args.repo), p);
        return { ok: true, ...value };
      },
    },
  ];
}
