/**
 * dsh-github-sync —— Web 客户端面板（sidebar.panellist + main 槽）。
 * 数据来自 GET /api/github-sync/status（15s 轮询），操作走 POST /api/github-sync/action。
 * 能力：同步仓库卡片、全部仓库浏览（需 PAT）、添加/移除仓库、文件浏览、Actions/CI。
 * 样式只用 --dsw-alias-* 主题 token（practices.md）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-github-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'github-sync';
    const PANEL_ID = 'github-sync';
    const REFRESH_MS = 15000;

    // ---------- 文案 ----------
    const zh = {
      meta: { title: 'GitHub 同步', description: 'GitHub 仓库双向同步、Actions/CI 监控与自动化流水线' },
      panel: 'GitHub 同步',
      kicker: 'GITHUB · REPO SYNC',
      subtitle: '双向同步 · 推送前检查 · Actions/CI · 自动化流水线',
      live: 'LIVE',
      updated: '更新于',
      refresh: '刷新',
      empty: '同步列表为空 —— 在下方「全部仓库」里点「加入同步」，或在 cordis.patch.yml 配置 repos',
      error: '请求失败',
      retry: '重试',
      branch: '分支',
      remote: '远端',
      path: '路径',
      ahead: '领先',
      behind: '落后',
      dirty: '未提交改动',
      clean: '工作树干净',
      lastSync: '最近同步',
      never: '尚未同步',
      checks: '推送前检查',
      ci: 'CI / Actions',
      noCi: '暂无 CI 数据',
      history: '历史',
      actSync: '同步',
      actPipeline: '流水线',
      actDispatch: '触发 CI',
      actEnsure: '补 CI 文件',
      running: '执行中…',
      mode_bidirectional: '双向',
      mode_pull: '仅拉取',
      mode_push: '仅推送',
      allRepos: '全部仓库（GitHub 账号）',
      loadRepos: '加载全部仓库',
      refreshRepos: '刷新列表',
      needToken: '列出全部仓库需要 GitHub PAT（插件 config 的 token，或环境变量 GITHUB_TOKEN）',
      addRepoSec: '手动添加仓库',
      addPlaceholder: 'https://github.com/owner/repo 或 owner/repo',
      addPathPlaceholder: '本地路径（可选，缺省克隆到 ~/dsh-github-sync）',
      addBtn: '添加',
      private: '私有',
      forked: 'fork',
      synced: '已同步',
      add: '加入同步',
      noRepos: '暂无数据',
      files: '文件',
      closeFiles: '收起',
      remove: '移除',
      up: '上级',
      filePreview: '文件预览',
      truncated: '文件过大，仅预览前 128 KB',
      loading: '加载中…',
      added: '已加入',
      manual: '手动',
      fromConfig: '配置',
      localFiles: '本地文件',
      closeLocal: '收起',
      rename: '改名',
      renamePlaceholder: '新名称（GitHub 仓库名，字母数字 . _ -）',
      renameBtn: '确认改名',
      active: '使用中',
      ago: '{n} 分钟前',
      loadActions: 'Actions 运行',
      runDetailLabel: '运行详情',
      jobLabel: 'job',
      binary: '二进制文件',
      actionsNeedToken: '查看 Actions 需要 PAT',
    };
    const en = {
      meta: { title: 'GitHub Sync', description: 'Bidirectional repo sync, Actions/CI monitoring and automation pipeline' },
      panel: 'GitHub Sync',
      kicker: 'GITHUB · REPO SYNC',
      subtitle: 'Bi-directional sync · pre-push checks · Actions/CI · pipeline',
      live: 'LIVE',
      updated: 'Updated',
      refresh: 'Refresh',
      empty: 'Sync list is empty — use “Add to sync” below, or set `repos` in cordis.patch.yml',
      error: 'Request failed',
      retry: 'Retry',
      branch: 'branch',
      remote: 'remote',
      path: 'path',
      ahead: 'ahead',
      behind: 'behind',
      dirty: 'uncommitted changes',
      clean: 'working tree clean',
      lastSync: 'Last sync',
      never: 'never synced',
      checks: 'Pre-push checks',
      ci: 'CI / Actions',
      noCi: 'No CI data yet',
      history: 'History',
      actSync: 'Sync',
      actPipeline: 'Pipeline',
      actDispatch: 'Trigger CI',
      actEnsure: 'Add CI file',
      running: 'Running…',
      mode_bidirectional: 'bi-directional',
      mode_pull: 'pull only',
      mode_push: 'push only',
      allRepos: 'All repositories (GitHub account)',
      loadRepos: 'Load all repos',
      refreshRepos: 'Refresh list',
      needToken: 'Listing all repositories needs a GitHub PAT (config token, or GITHUB_TOKEN env var)',
      addRepoSec: 'Add repository manually',
      addPlaceholder: 'https://github.com/owner/repo or owner/repo',
      addPathPlaceholder: 'Local path (optional; defaults to ~/dsh-github-sync)',
      addBtn: 'Add',
      private: 'private',
      forked: 'fork',
      synced: 'synced',
      add: 'Add to sync',
      noRepos: 'No data',
      files: 'Files',
      closeFiles: 'Collapse',
      remove: 'Remove',
      up: 'Up',
      filePreview: 'File preview',
      truncated: 'File too large; previewing first 128 KB',
      loading: 'Loading…',
      added: 'Added',
      manual: 'manual',
      fromConfig: 'config',
      localFiles: 'Local files',
      closeLocal: 'Collapse',
      rename: 'Rename',
      renamePlaceholder: 'New name (GitHub repo name; letters, digits . _ -)',
      renameBtn: 'Confirm rename',
      active: 'in use',
      ago: '{n} min ago',
      loadActions: 'Actions runs',
      runDetailLabel: 'Run detail',
      jobLabel: 'job',
      binary: 'binary file',
      actionsNeedToken: 'Viewing Actions needs a PAT',
    };

    // ---------- 样式 ----------
    const CSS = `
.gss-page{box-sizing:border-box;width:100%;min-width:0;height:100%;min-height:0;overflow-y:auto;scrollbar-gutter:stable;padding:22px 26px 34px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-family:ui-rounded,'Segoe UI Variable Text','Segoe UI','PingFang SC','Microsoft YaHei UI',system-ui,-apple-system,sans-serif;font-size:14px}
.gss-kicker{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.2em;color:var(--dsw-alias-brand-primary)}
.gss-sub{font-size:13.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.gss-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}
.gss-live{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.gss-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.gss-updated{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.gss-btn{display:inline-flex;align-items:center;gap:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;letter-spacing:.06em;padding:8px 14px;border-radius:8px;cursor:pointer;transition:border-color .18s ease,color .18s ease,background .18s ease}
.gss-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-overlay)}
.gss-btn:disabled{opacity:.5;cursor:default}
.gss-btnPrimary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.gss-btnSm{font-size:11.5px;padding:5px 11px}
.gss-btnDanger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.gss-err{display:flex;justify-content:space-between;align-items:center;gap:12px;border:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);padding:11px 16px;margin:14px 0;border-radius:10px;font-size:13px;color:var(--dsw-alias-state-error-primary)}
.gss-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;margin-top:18px}
.gss-card{position:relative;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px 17px 14px;transition:border-color .18s ease}
.gss-card:hover{border-color:var(--dsw-alias-brand-primary)}
.gss-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.gss-name{font-size:16px;font-weight:700;letter-spacing:.02em}
.gss-chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.gss-meta{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.7;word-break:break-all}
.gss-metrics{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.gss-metric{font-size:11.5px;letter-spacing:.05em;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.gss-sec{margin-top:12px}
.gss-secTitle{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.gss-line{font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.65;word-break:break-word}
.gss-actions{display:flex;gap:8px;margin-top:13px;flex-wrap:wrap}
.gss-empty{display:flex;align-items:center;justify-content:center;height:220px;font-size:13.5px;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.gss-foot{margin-top:18px;font-size:11.5px;color:var(--dsw-alias-label-secondary);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.gss-a{color:var(--dsw-alias-brand-primary);text-decoration:none}
.gss-panel{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px 17px;margin-top:18px}
.gss-secHead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.gss-panelTitle{font-size:14px;font-weight:700;letter-spacing:.04em}
.gss-input{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:8px 11px;border-radius:8px;min-width:220px;flex:1}
.gss-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.gss-allList{max-height:340px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.gss-allRow{display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12.5px;flex-wrap:wrap}
.gss-allRow:first-child{border-top:none}
.gss-allRow:hover{background:var(--dsw-alias-bg-layer-2)}
.gss-allName{font-weight:600;word-break:break-all}
.gss-allDesc{color:var(--dsw-alias-label-secondary);flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gss-crumb{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.gss-crumbBtn{background:none;border:none;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer;padding:0}
.gss-fileList{max-height:240px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.gss-fileRow{display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12.5px;cursor:pointer;background:none;border-left:none;border-right:none;border-bottom:none;color:inherit;text-align:left;width:100%;font-family:inherit}
.gss-fileRow:first-child{border-top:none}
.gss-fileRow:hover{background:var(--dsw-alias-bg-layer-2)}
.gss-pre{max-height:260px;overflow:auto;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;font-family:Consolas,'Cascadia Mono',monospace;font-size:12px;line-height:1.5;white-space:pre;word-break:break-all;margin-top:8px}
.gss-active{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;letter-spacing:.06em;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2)}
.gss-activeDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);animation:gssPulse 2s ease-in-out infinite}
@keyframes gssPulse{0%,100%{opacity:1}50%{opacity:.35}}
.gss-runRow{display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12.5px;cursor:pointer;background:none;border-left:none;border-right:none;border-bottom:none;color:inherit;text-align:left;width:100%;font-family:inherit}
.gss-runRow:first-child{border-top:none}
.gss-runRow:hover{background:var(--dsw-alias-bg-layer-2)}
.gss-runSel{background:var(--dsw-alias-bg-layer-2);border-left:2px solid var(--dsw-alias-brand-primary)}
.gss-stepRow{display:flex;align-items:center;gap:8px;padding:3px 0 3px 26px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.gss-renameRow{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
`;

    const STATUS_COLOR = {
      'up-to-date': 'var(--dsw-alias-state-success-primary)',
      pulled: 'var(--dsw-alias-brand-primary)',
      pushed: 'var(--dsw-alias-brand-primary)',
      synced: 'var(--dsw-alias-state-success-primary)',
      dirty: 'var(--dsw-alias-state-warn-primary)',
      'checks-blocked': 'var(--dsw-alias-state-warn-primary)',
      'diverged-report': 'var(--dsw-alias-state-warn-primary)',
      conflict: 'var(--dsw-alias-state-error-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    };

    function fmtTime(ts) {
      if (!ts) return '—';
      try {
        return new Date(ts).toLocaleString();
      } catch {
        return String(ts);
      }
    }

    function Style() {
      return h('style', null, CSS);
    }

    function StatusChip({ status, t }) {
      const color = STATUS_COLOR[status] || 'var(--dsw-alias-state-idle-primary)';
      return h('span', { className: 'gss-chip', style: { color, borderColor: color } }, status || '—');
    }

    // ---------- 文件浏览器（GitHub contents API） ----------
    function FileBrowser({ repoName, branch, t, onAct }) {
      const [dirPath, setDirPath] = React.useState('');
      const [dir, setDir] = React.useState(null);
      const [file, setFile] = React.useState(null);
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(false);

      const loadDir = React.useCallback(
        async (p) => {
          setLoading(true);
          try {
            const value = await onAct('list-files', { repo: repoName, path: p });
            if (value && value.kind === 'dir') {
              setDir(value);
              setDirPath(p);
              setFile(null);
              setError('');
            } else {
              setError('unexpected response');
            }
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setLoading(false);
          }
        },
        [onAct, repoName],
      );

      const openFile = React.useCallback(
        async (p) => {
          setLoading(true);
          try {
            const value = await onAct('list-files', { repo: repoName, path: p });
            if (value && value.kind === 'file') {
              setFile(value);
              setError('');
            } else {
              setError('unexpected response');
            }
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setLoading(false);
          }
        },
        [onAct, repoName],
      );

      React.useEffect(() => {
        loadDir('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [repoName]);

      const segments = dirPath ? dirPath.split('/') : [];
      return h(
        'div',
        { className: 'gss-sec' },
        h('div', { className: 'gss-secTitle' }, t('files')),
        h(
          'div',
          { className: 'gss-crumb' },
          h('button', { className: 'gss-crumbBtn', onClick: () => loadDir('') }, `⌂ ${branch || 'default'}`),
          segments.map((seg, i) =>
            h(
              'span',
              { key: i },
              ' / ',
              h(
                'button',
                {
                  className: 'gss-crumbBtn',
                  onClick: () => loadDir(segments.slice(0, i + 1).join('/')),
                },
                seg,
              ),
            ),
          ),
        ),
        error ? h('div', { className: 'gss-line', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        loading ? h('div', { className: 'gss-line' }, t('loading')) : null,
        dir && !loading
          ? h(
              'div',
              { className: 'gss-fileList' },
              dirPath
                ? h(
                    'button',
                    { className: 'gss-fileRow', onClick: () => loadDir(segments.slice(0, -1).join('/')) },
                    '↩ ' + t('up'),
                  )
                : null,
              (dir.entries || []).map((e) =>
                h(
                  'button',
                  {
                    key: e.path,
                    className: 'gss-fileRow',
                    onClick: () => (e.type === 'dir' ? loadDir(e.path) : openFile(e.path)),
                  },
                  h('span', null, e.type === 'dir' ? '📁' : '📄'),
                  h('span', { style: { flex: 1, wordBreak: 'break-all' } }, e.name),
                  e.type === 'file' ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, `${e.size} B`) : null,
                ),
              ),
            )
          : null,
        file
          ? h(
              'div',
              { className: 'gss-sec' },
              h(
                'div',
                { className: 'gss-row', style: { justifyContent: 'space-between' } },
                h('span', { className: 'gss-line', style: { fontWeight: 600 } }, `${t('filePreview')}: ${file.path}`),
                h('button', { className: 'gss-btn gss-btnSm', onClick: () => setFile(null) }, '✕'),
              ),
              file.truncated ? h('div', { className: 'gss-line' }, t('truncated')) : null,
              h('pre', { className: 'gss-pre' }, file.content || ''),
            )
          : null,
      );
    }

    // ---------- 本地文件浏览器（直接读磁盘，不需 PAT） ----------
    function LocalBrowser({ repoName, t, onAct }) {
      const [dirPath, setDirPath] = React.useState('');
      const [dir, setDir] = React.useState(null);
      const [file, setFile] = React.useState(null);
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(false);

      const loadDir = React.useCallback(
        async (p) => {
          setLoading(true);
          try {
            const value = await onAct('local-files', { repo: repoName, path: p });
            if (value && value.kind === 'dir') {
              setDir(value);
              setDirPath(p);
              setFile(null);
              setError('');
            } else {
              setError('unexpected response');
            }
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setLoading(false);
          }
        },
        [onAct, repoName],
      );

      const openFile = React.useCallback(
        async (p) => {
          setLoading(true);
          try {
            const value = await onAct('local-file', { repo: repoName, path: p });
            if (value && value.kind === 'file') {
              setFile(value);
              setError('');
            } else {
              setError('unexpected response');
            }
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setLoading(false);
          }
        },
        [onAct, repoName],
      );

      React.useEffect(() => {
        loadDir('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [repoName]);

      const childPath = (name) => (dirPath ? dirPath + '/' + name : name);
      const segments = dirPath ? dirPath.split('/') : [];
      return h(
        'div',
        { className: 'gss-sec' },
        h('div', { className: 'gss-secTitle' }, t('localFiles')),
        h(
          'div',
          { className: 'gss-crumb' },
          h('button', { className: 'gss-crumbBtn', onClick: () => loadDir('') }, `⌂ ${repoName}`),
          segments.map((seg, i) =>
            h(
              'span',
              { key: i },
              ' / ',
              h(
                'button',
                { className: 'gss-crumbBtn', onClick: () => loadDir(segments.slice(0, i + 1).join('/')) },
                seg,
              ),
            ),
          ),
        ),
        error ? h('div', { className: 'gss-line', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        loading ? h('div', { className: 'gss-line' }, t('loading')) : null,
        dir && !loading
          ? h(
              'div',
              { className: 'gss-fileList' },
              dirPath
                ? h(
                    'button',
                    { className: 'gss-fileRow', onClick: () => loadDir(segments.slice(0, -1).join('/')) },
                    '↩ ' + t('up'),
                  )
                : null,
              (dir.entries || []).map((e) =>
                h(
                  'button',
                  {
                    key: e.name,
                    className: 'gss-fileRow',
                    onClick: () => (e.type === 'dir' ? loadDir(childPath(e.name)) : openFile(childPath(e.name))),
                  },
                  h('span', null, e.type === 'dir' ? '📁' : e.type === 'link' ? '🔗' : '📄'),
                  h('span', { style: { flex: 1, wordBreak: 'break-all' } }, e.name),
                  e.type === 'file' ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, `${e.size} B`) : null,
                ),
              ),
            )
          : null,
        file
          ? h(
              'div',
              { className: 'gss-sec' },
              h(
                'div',
                { className: 'gss-row', style: { justifyContent: 'space-between' } },
                h('span', { className: 'gss-line', style: { fontWeight: 600 } }, `${t('filePreview')}: ${file.path}`),
                h('button', { className: 'gss-btn gss-btnSm', onClick: () => setFile(null) }, '✕'),
              ),
              file.binary ? h('div', { className: 'gss-line' }, `${t('binary')}（${file.size} B）`) : null,
              file.truncated ? h('div', { className: 'gss-line' }, t('truncated')) : null,
              file.binary ? null : h('pre', { className: 'gss-pre' }, file.content || ''),
            )
          : null,
      );
    }

    // ---------- Actions 运行列表 + 详情 ----------
    function ActionsPanel({ repoName, t, onAct }) {
      const [runs, setRuns] = React.useState(null);
      const [selected, setSelected] = React.useState(null);
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(false);

      const loadRuns = React.useCallback(async () => {
        setLoading(true);
        try {
          const value = await onAct('ci-runs', { repo: repoName });
          setRuns((value && value.runs) || []);
          setError('');
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setLoading(false);
        }
      }, [onAct, repoName]);

      React.useEffect(() => {
        setSelected(null);
        loadRuns();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [repoName]);

      const openRun = React.useCallback(
        async (runId) => {
          setLoading(true);
          try {
            const value = await onAct('run-detail', { repo: repoName, runId });
            setSelected(value);
            setError('');
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setLoading(false);
          }
        },
        [onAct, repoName],
      );

      const conclColor = (conclusion, status) =>
        conclusion === 'success'
          ? 'var(--dsw-alias-state-success-primary)'
          : conclusion
            ? 'var(--dsw-alias-state-error-primary)'
            : status === 'in_progress'
              ? 'var(--dsw-alias-state-warn-primary)'
              : 'var(--dsw-alias-state-idle-primary)';

      return h(
        'div',
        { className: 'gss-sec' },
        h('div', { className: 'gss-secTitle' }, t('loadActions')),
        error ? h('div', { className: 'gss-line', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        loading ? h('div', { className: 'gss-line' }, t('loading')) : null,
        !loading && runs && runs.length === 0 ? h('div', { className: 'gss-line' }, t('noCi')) : null,
        runs && runs.length > 0
          ? h(
              'div',
              { className: 'gss-fileList' },
              runs.slice(0, 10).map((r) =>
                h(
                  'button',
                  {
                    key: r.id,
                    className: 'gss-runRow' + (selected && selected.run && selected.run.id === r.id ? ' gss-runSel' : ''),
                    onClick: () => openRun(r.id),
                  },
                  h('span', { style: { fontWeight: 700, color: conclColor(r.conclusion, r.status), minWidth: 58 } }, r.conclusion || r.status || '—'),
                  h('span', { style: { flex: 1, wordBreak: 'break-all' } }, `#${r.run_number} ${r.name || ''} · ${r.branch || ''}`),
                  r.html_url ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '↗') : null,
                ),
              ),
            )
          : null,
        selected && selected.run
          ? h(
              'div',
              { className: 'gss-sec' },
              h('div', { className: 'gss-secTitle' }, `${t('runDetailLabel')} #${selected.run.run_number}`),
              h(
                'div',
                { className: 'gss-line' },
                `${selected.run.name || ''} · ${selected.run.status}${selected.run.conclusion ? ' / ' + selected.run.conclusion : ''} · ${selected.run.branch || ''}${selected.run.triggered_by ? ' · @' + selected.run.triggered_by : ''}`,
              ),
              (selected.jobs || []).map((j) =>
                h(
                  'div',
                  { key: j.name, className: 'gss-line', style: { marginTop: 6 } },
                  h(
                    'span',
                    { style: { fontWeight: 700, color: conclColor(j.conclusion, j.status), marginRight: 8 } },
                    j.conclusion || j.status || '—',
                  ),
                  `${t('jobLabel')}: ${j.name}`,
                  (j.steps || []).map((s, i) =>
                    h(
                      'div',
                      { key: i, className: 'gss-stepRow' },
                      h('span', { style: { color: conclColor(s.conclusion, s.status), fontWeight: 700 } }, s.conclusion === 'success' ? '✓' : s.conclusion ? '✗' : '·'),
                      s.name,
                    ),
                  ),
                ),
              ),
              selected.run.html_url
                ? h('a', { className: 'gss-a', href: selected.run.html_url, target: '_blank', rel: 'noreferrer' }, '↗ GitHub')
                : null,
            )
          : null,
      );
    }

    // ---------- 改名表单（GitHub PATCH + 本地 remote 更新） ----------
    function RenameForm({ repoName, t, busy, onAct, onDone }) {
      const [value, setValue] = React.useState('');
      const [error, setError] = React.useState('');
      const submit = async () => {
        const newName = value.trim();
        if (!newName || newName === repoName) return;
        try {
          await onAct('rename-repo', { repo: repoName, newName });
          setValue('');
          setError('');
          if (onDone) onDone();
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      };
      return h(
        'div',
        { className: 'gss-renameRow' },
        h('input', {
          className: 'gss-input',
          placeholder: t('renamePlaceholder'),
          value,
          onChange: (e) => setValue(e.target.value),
        }),
        h('button', { className: 'gss-btn gss-btnPrimary', disabled: busy || !value.trim(), onClick: submit }, t('renameBtn')),
        error ? h('span', { className: 'gss-line', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
      );
    }

    // ---------- 同步仓库卡片 ----------
    function RepoCard({ repo, t, busy, onAct }) {
      const [filesOpen, setFilesOpen] = React.useState(false);
      const [localOpen, setLocalOpen] = React.useState(false);
      const [actionsOpen, setActionsOpen] = React.useState(false);
      const [renameOpen, setRenameOpen] = React.useState(false);
      const snap = repo.snapshot || {};
      const last = repo.lastSync;
      const checks = (last && last.checks) || [];
      const ciRuns = (repo.ci && repo.ci.runs) || [];
      const isRuntime = repo.source === 'runtime';
      const activity = repo.activity || {};
      const activeTs = Math.max(activity.newestFileTs || 0, activity.lastCommitTs || 0);
      return h(
        'div',
        { className: 'gss-card' },
        h(
          'div',
          { className: 'gss-row' },
          h('span', { className: 'gss-name' }, repo.name),
          h(StatusChip, { status: (last && last.status) || (snap.error ? 'error' : 'idle'), t }),
          activity.active
            ? h(
                'span',
                { className: 'gss-active' },
                h('span', { className: 'gss-activeDot' }),
                activeTs && Date.now() - activeTs < 60000 ? t('active') : t('ago', { n: Math.max(1, Math.round((Date.now() - activeTs) / 60000)) }),
              )
            : null,
          h('span', { className: 'gss-chip' }, t(`mode_${repo.mode}`) || repo.mode),
          h('span', { className: 'gss-chip' }, isRuntime ? t('manual') : t('fromConfig')),
        ),
        h(
          'div',
          { className: 'gss-meta' },
          `${t('branch')}: ${repo.branch || '—'} · ${t('remote')}: ${repo.remote}`,
          h('br'),
          `${t('path')}: ${repo.path}`,
          h('br'),
          repo.url ? `${t('remote')}: ${repo.url}` : null,
        ),
        h(
          'div',
          { className: 'gss-metrics' },
          h('span', { className: 'gss-metric' }, `${t('ahead')}: ${snap.ahead ?? 0}`),
          h('span', { className: 'gss-metric' }, `${t('behind')}: ${snap.behind ?? 0}`),
          h(
            'span',
            {
              className: 'gss-metric',
              style: snap.dirty
                ? { color: 'var(--dsw-alias-state-warn-primary)', borderColor: 'var(--dsw-alias-state-warn-primary)' }
                : null,
            },
            snap.dirty ? t('dirty') : t('clean'),
          ),
          snap.head ? h('span', { className: 'gss-metric' }, snap.head) : null,
        ),
        h(
          'div',
          { className: 'gss-sec' },
          h('div', { className: 'gss-secTitle' }, t('lastSync')),
          h('div', { className: 'gss-line' }, last ? `${fmtTime(last.finishedAt)} · ${last.status} — ${last.message}` : t('never')),
        ),
        checks.length > 0
          ? h(
              'div',
              { className: 'gss-sec' },
              h('div', { className: 'gss-secTitle' }, t('checks')),
              checks.map((c) =>
                h(
                  'div',
                  { key: c.name, className: 'gss-line' },
                  h(
                    'span',
                    {
                      style: {
                        color: c.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
                        fontWeight: 700,
                        marginRight: 8,
                      },
                    },
                    c.ok ? '✓' : '✗',
                  ),
                  `${c.name} · ${Math.round((c.durationMs || 0) / 1000)}s`,
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'gss-sec' },
          h('div', { className: 'gss-secTitle' }, t('ci')),
          ciRuns.length > 0
            ? ciRuns.slice(0, 3).map((r) =>
                h(
                  'div',
                  { key: r.id, className: 'gss-line' },
                  h(
                    'span',
                    {
                      style: {
                        color:
                          r.conclusion === 'success'
                            ? 'var(--dsw-alias-state-success-primary)'
                            : r.conclusion
                              ? 'var(--dsw-alias-state-error-primary)'
                              : 'var(--dsw-alias-state-warn-primary)',
                        fontWeight: 700,
                        marginRight: 8,
                      },
                    },
                    r.conclusion || r.status || '—',
                  ),
                  `#${r.run_number} ${r.name || ''} · ${r.branch || ''}`,
                  r.html_url
                    ? h('a', { className: 'gss-a', href: r.html_url, target: '_blank', rel: 'noreferrer', style: { marginLeft: 8 } }, '↗')
                    : null,
                ),
              )
            : h('div', { className: 'gss-line' }, t('noCi')),
        ),
        h(
          'div',
          { className: 'gss-actions' },
          h(
            'button',
            { className: 'gss-btn gss-btnPrimary', disabled: busy, onClick: () => onAct('sync', { repo: repo.name }) },
            busy ? t('running') : t('actSync'),
          ),
          h('button', { className: 'gss-btn', disabled: busy, onClick: () => onAct('pipeline', { repo: repo.name }) }, t('actPipeline')),
          h('button', { className: 'gss-btn', disabled: busy, onClick: () => onAct('dispatch-ci', { repo: repo.name }) }, t('actDispatch')),
          h('button', { className: 'gss-btn', disabled: busy, onClick: () => onAct('ensure-workflow', { repo: repo.name }) }, t('actEnsure')),
          h(
            'button',
            { className: 'gss-btn', disabled: busy, onClick: () => setActionsOpen((v) => !v) },
            actionsOpen ? t('closeFiles') : t('loadActions'),
          ),
          h(
            'button',
            { className: 'gss-btn', disabled: busy, onClick: () => setLocalOpen((v) => !v) },
            localOpen ? t('closeLocal') : t('localFiles'),
          ),
          h(
            'button',
            { className: 'gss-btn', disabled: busy, onClick: () => setFilesOpen((v) => !v) },
            filesOpen ? t('closeFiles') : t('files'),
          ),
          h(
            'button',
            { className: 'gss-btn', disabled: busy, onClick: () => setRenameOpen((v) => !v) },
            t('rename'),
          ),
          isRuntime
            ? h(
                'button',
                { className: 'gss-btn gss-btnDanger', disabled: busy, onClick: () => onAct('remove-repo', { repo: repo.name }) },
                t('remove'),
              )
            : null,
        ),
        renameOpen ? h(RenameForm, { repoName: repo.name, t, busy, onAct, onDone: () => setRenameOpen(false) }) : null,
        actionsOpen ? h(ActionsPanel, { repoName: repo.name, t, onAct }) : null,
        localOpen ? h(LocalBrowser, { repoName: repo.name, t, onAct }) : null,
        filesOpen ? h(FileBrowser, { repoName: repo.name, branch: repo.branch, t, onAct }) : null,
      );
    }

    // ---------- 全部仓库 + 手动添加 ----------
    function AllRepos({ t, busy, data, error, loading, onLoad, onAct }) {
      const [url, setUrl] = React.useState('');
      const [targetPath, setTargetPath] = React.useState('');
      const repos = (data && data.repos) || [];
      return h(
        'div',
        { className: 'gss-panel' },
        h(
          'div',
          { className: 'gss-secHead' },
          h('span', { className: 'gss-panelTitle' }, t('allRepos')),
          h(
            'div',
            { className: 'gss-row' },
            h('button', { className: 'gss-btn gss-btnSm', disabled: busy || loading, onClick: () => onLoad(false) }, t('loadRepos')),
            h('button', { className: 'gss-btn gss-btnSm', disabled: busy || loading, onClick: () => onLoad(true) }, t('refreshRepos')),
          ),
        ),
        error ? h('div', { className: 'gss-line', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        repos.length === 0 && !error
          ? h('div', { className: 'gss-line' }, loading ? t('loading') : t('needToken'))
          : h(
              'div',
              { className: 'gss-allList' },
              repos.map((r) =>
                h(
                  'div',
                  { key: r.fullName || r.name, className: 'gss-allRow' },
                  h('span', { className: 'gss-allName' }, r.fullName || r.name),
                  r.private ? h('span', { className: 'gss-chip' }, t('private')) : null,
                  r.fork ? h('span', { className: 'gss-chip' }, t('forked')) : null,
                  h('span', { className: 'gss-allDesc' }, r.description || ''),
                  h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11.5px' } }, String(r.updatedAt || '').slice(0, 10)),
                  r.synced
                    ? h('span', { className: 'gss-chip', style: { color: 'var(--dsw-alias-state-success-primary)' } }, t('synced'))
                    : h(
                        'button',
                        { className: 'gss-btn gss-btnSm', disabled: busy, onClick: () => onAct('add-repo', { url: r.htmlUrl || r.fullName }) },
                        t('add'),
                      ),
                ),
              ),
            ),
        h(
          'div',
          { className: 'gss-sec' },
          h('div', { className: 'gss-secTitle' }, t('addRepoSec')),
          h(
            'div',
            { className: 'gss-row' },
            h('input', {
              className: 'gss-input',
              placeholder: t('addPlaceholder'),
              value: url,
              onChange: (e) => setUrl(e.target.value),
            }),
            h('input', {
              className: 'gss-input',
              placeholder: t('addPathPlaceholder'),
              value: targetPath,
              onChange: (e) => setTargetPath(e.target.value),
            }),
            h(
              'button',
              {
                className: 'gss-btn gss-btnPrimary',
                disabled: busy || !url.trim(),
                onClick: () => {
                  onAct('add-repo', { url: url.trim(), path: targetPath.trim() || undefined });
                  setUrl('');
                  setTargetPath('');
                },
              },
              t('addBtn'),
            ),
          ),
        ),
      );
    }

    // ---------- 主面板 ----------
    function App({ t }) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [allData, setAllData] = React.useState(null);
      const [allError, setAllError] = React.useState('');
      const [allLoading, setAllLoading] = React.useState(false);

      const load = React.useCallback(async () => {
        try {
          const res = await fetch('api/github-sync/status', { cache: 'no-store' });
          const json = await res.json();
          setData(json);
          setError('');
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, []);

      React.useEffect(() => {
        load();
        const id = setInterval(load, REFRESH_MS);
        return () => clearInterval(id);
      }, [load]);

      const post = React.useCallback(async (body) => {
        const res = await fetch('api/github-sync/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || 'failed');
        return json;
      }, []);

      /** 面板动作：payload 为对象（含 repo/path/url 等）；成功后刷新状态。 */
      const act = React.useCallback(
        async (action, payload) => {
          setBusy(true);
          try {
            const json = await post({ action, ...(payload || {}) });
            setError('');
            return json;
          } catch (err) {
            setError(String((err && err.message) || err));
            throw err;
          } finally {
            setBusy(false);
            load();
          }
        },
        [load, post],
      );

      /** 文件浏览器动作：不触发整面板刷新（避免打断浏览）。 */
      const actQuiet = React.useCallback(
        async (action, payload) => {
          setBusy(true);
          try {
            const json = await post({ action, ...(payload || {}) });
            setError('');
            return json;
          } catch (err) {
            setError(String((err && err.message) || err));
            throw err;
          } finally {
            setBusy(false);
          }
        },
        [post],
      );

      const loadAll = React.useCallback(
        async (refresh) => {
          setAllLoading(true);
          try {
            const json = await post({ action: 'list-repos', refresh });
            setAllData(json);
            setAllError('');
          } catch (err) {
            setAllError(String((err && err.message) || err));
          } finally {
            setAllLoading(false);
          }
        },
        [post],
      );

      const repos = (data && data.repos) || [];
      return h(
        'div',
        { className: 'gss-page' },
        h(Style),
        h(
          'div',
          { className: 'gss-head' },
          h(
            'div',
            null,
            h('div', { className: 'gss-kicker' }, t('kicker')),
            h('div', { className: 'gss-sub' }, t('subtitle')),
          ),
          h(
            'div',
            { className: 'gss-row' },
            h('span', { className: 'gss-live' }, h('span', { className: 'gss-dot' }), t('live')),
            h('span', { className: 'gss-updated' }, `${t('updated')} ${fmtTime(data && data.now)}`),
            h('button', { className: 'gss-btn', disabled: busy, onClick: load }, t('refresh')),
          ),
        ),
        error
          ? h(
              'div',
              { className: 'gss-err' },
              h('span', null, `${t('error')}: ${error}`),
              h('button', { className: 'gss-btn', onClick: load }, t('retry')),
            )
          : null,
        repos.length === 0
          ? h('div', { className: 'gss-empty' }, t('empty'))
          : h(
              'div',
              { className: 'gss-cards' },
              repos.map((repo) =>
                h(RepoCard, {
                  key: repo.name,
                  repo,
                  t,
                  busy,
                  onAct: (a, p) =>
                    ['list-files', 'local-files', 'local-file', 'ci-runs', 'run-detail'].includes(a) ? actQuiet(a, p) : act(a, p),
                }),
              ),
            ),
        h(AllRepos, {
          t,
          busy,
          data: allData,
          error: allError,
          loading: allLoading,
          onLoad: loadAll,
          onAct: async (action, payload) => {
            try {
              await act(action, payload);
              // 加入/移除后同步刷新全部仓库列表的“已同步”标记
              if (action === 'add-repo' || action === 'remove-repo') loadAll(false);
            } catch {}
          },
        }),
        h(
          'div',
          { className: 'gss-foot' },
          h(
            'span',
            null,
            `interval ${(data && data.config && data.config.intervalMinutes) || '—'} min · storage ${(data && data.storageFile) || '—'}`,
          ),
          h('span', null, `dsh-github-sync v1.0.0`),
        ),
      );
    }

    function PanelIcon(props) {
      const size = (props && props.size) || 18;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('circle', { cx: 6, cy: 6, r: 2.6 }),
        h('circle', { cx: 6, cy: 18, r: 2.6 }),
        h('circle', { cx: 18, cy: 8, r: 2.6 }),
        h('path', { d: 'M6 8.6v6.8' }),
        h('path', { d: 'M15.6 9.6c-2 1.4-4.4 2-7 2' }),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.locale.register(NS, { zh, en });
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, (props) => h(App, Object.assign({}, props, { t }))),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => t('panel'), locale: NS },
            PanelIcon,
          ),
        );
      },
    };
  },
});
