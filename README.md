# dsh-github-sync

DSH 插件：GitHub 仓库自动双向同步 + Actions/CI 流水线 + 本地推送前检查。同一套能力同时暴露给 **Agent 工具**、**Web 面板**和**定时器**。

## 功能

| 能力 | 说明 |
| --- | --- |
| 双向同步 | fetch → 计算 ahead/behind → 并入远端（快进 / merge / rebase，冲突即回滚）→ 跑推送前检查 → push |
| 冲突策略 | `report`（默认，只报告不动手）/ `merge` / `rebase` / `prefer-remote` / `prefer-local`；任何冲突都会 abort 并回滚，绝不留半合并状态 |
| 推送前检查 | `checks` 列表（shell 命令），`onFail: block`（阻止推送）或 `warn`（记一笔继续） |
| Actions/CI | 自动补 `.github/workflows/dsh-ci.yml`（缺失时创建）、`workflow_dispatch` 触发、轮询 run 到完成、查看 runs/checks/status |
| 工作流 | 列出 workflows、按 ref 分发触发（支持 inputs） |
| 通知 | 同步/流水线事件按 `notifyOn` 过滤，经 `agent.followup()` 唤醒 agent |
| Web 面板 | 侧栏 "GitHub Sync" 面板：仓库卡片、状态、CI runs、一键 同步/流水线/触发CI/补CI文件、**文件浏览器**、**全部仓库列表 + 一键加入同步/手动添加/移除**，15s 自动刷新 |
| 仓库管理 | 全部仓库（`/user/repos`，需 PAT，缓存 5 分钟）；「加入同步」自动克隆到 `cloneRoot/<owner>/<name>`（可指定本地路径；已是 git 仓库的路径直接注册）；运行时加入的仓库持久化在状态文件，「移除」只出列表、不动磁盘 |
| 改名同步 | 面板/工具改名 → GitHub `PATCH /repos`（需 admin）+ 本地 `git remote set-url`；配置仓库的改名记在状态文件的映射里（不改 cordis.patch.yml），运行时仓库直接改条目；历史/CI 缓存跟随新名 |
| 活跃置顶 | 按「未提交改动(+1000) + 顶层文件最新 mtime(权重100) + 最近提交(权重60)」的时近度阶梯分排序，活跃仓库自动排前面；卡片显示「使用中 / N 分钟前」徽章 |
| Actions 详情 | 卡片「Actions 运行」区：最近 runs 列表 → 点开某次 run → jobs 与每一步（step）的结论；带 ↗ GitHub 跳转 |
| 本地文件 | 卡片「本地文件」区：直接读本地克隆磁盘（不走 GitHub、不需 PAT），目录/文件树 + 文本预览（≤128 KB，二进制只给元数据）；路径被约束在仓库根内（`path-escape` 防护） |
| Agent 工具 | `github_sync` / `github_status` / `github_ci`（runs/checks/status/**run-detail**）/ `github_workflow` / `github_repos`（list/add/remove/**rename**）/ `github_files`（**source: local(默认)/github**） |
| 定时 | `intervalMinutes` 周期自动同步全部仓库；`runOnStart` 启动即跑一次 |

## 安装

零运行时依赖，直接从 GitHub 安装（需要 dsh 自带 pnpm）：

```powershell
dsh plugin --profile <profile> add https://github.com/wzw4429-crypto/dsh-github-sync
```

发到 npm 之后也可以用包名安装：`dsh plugin --profile <profile> add dsh-github-sync`。安装后**重启 dsh** 生效。

## 配置放在哪里

包内的 [cordis.patch.yml](cordis.patch.yml) **只声明插件行、不带任何配置**；你的 token、仓库列表、定时周期等写在 **profile 自己的 patch 层**（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`），按 `id` + 模块名覆盖：

```yaml
- id: github-sync
  name: dsh-github-sync
  config:
    token: 'ghp_...'
    repos:
      - name: my-repo
        path: D:\path\to\repo
```

这样密钥与机器路径不会进插件仓库，插件升级也不会覆盖你的配置。面板/工具运行时「加入同步」的仓库存在状态文件里，无需改配置。

## 认证（PAT）

两种方式，二选一（`token` 优先）：

1. **环境变量（推荐）**：设置 `GITHUB_TOKEN=<PAT>`（或改 `tokenEnv` 指向别的变量名）。PAT 需要 `repo` 权限（私库）和 `workflow` 权限（触发 Actions / 写 workflow 文件）。
2. **配置直填**：`config.token: '<PAT>'`。

token 绝不会出现在日志、工具输出、面板或错误消息里（`redactedConfig` 脱敏）；git 的 fetch/push 通过 **env 注入** `http.extraheader` 使用 PAT（不进进程参数），无 token 或非 github.com https 远端时回退系统凭据助手/SSH 密钥。

## 配置项（profile patch 层的 `github-sync.config`）

```yaml
- id: github-sync
  name: 'dsh-github-sync'
  config:
    enabled: true            # 总开关
    runOnStart: false        # 启动 5s 后先跑一轮
    intervalMinutes: 30      # 定时周期
    tokenEnv: 'GITHUB_TOKEN'
    notifyAgent: true
    notifyOn: [conflict, error, checks, pipeline]   # 事件：conflict/error/checks/pipeline/pull/push
    autoCommit: false        # 同步前把脏工作树自动提交（否则脏树需并入时报 dirty）
    conflictPolicy: 'report' # report/merge/rebase/prefer-remote/prefer-local
    onCheckFailure: 'block'  # 检查未单独声明 onFail 时的默认：block/warn
    repos:
      - name: my-repo
        path: D:\path\to\repo
        remote: origin        # 默认 origin
        branch: ''            # 默认当前分支
        mode: bidirectional   # bidirectional/pull/push
        githubRepo: ''        # 可选显式 owner/name；缺省从 remote URL 推断
        workflowFile: ''      # 可选，补 CI 文件名，默认 .github/workflows/dsh-ci.yml
        checks:
          - name: test
            run: 'npm test'
            onFail: block     # block/warn
    pipeline:
      triggerCi: true         # 同步后 dispatch CI
      waitCi: true            # 轮询到 run 完成
      waitTimeoutMinutes: 10
      pollIntervalSeconds: 20
```

## 状态与数据

- 状态文件：`<profile>/github-sync-state.json`（每仓库 `lastSync` / `lastPipeline` / `history`（尾 20 条）/ `ci` 缓存）。
- 同步语义：`up-to-date` / `pulled` / `pushed` / `synced` 为成功；`dirty` / `diverged-report` / `conflict` / `checks-blocked` 为安全停住（工作树与 HEAD 不受损）；`error` 为 git/环境失败。

## 开发

```powershell
# 语法检查 + 测试（35 项：config/state/checks/真实 git 同步 10 场景/github mock/pipeline/tools/host 冒烟/本地浏览防穿越/活跃度/改名/setRemoteUrl）
node --test test/run-tests.mjs
```

状态文件里的 `"codeGen": N` 是已加载代码的代号指纹：改完代码重启 dsh 后该值应更新，用于自检新代码是否生效。

## 环境要求

- dsh（DeepSeek Harness）能加载 bundle，自带 pnpm 与 Node
- Node ≥ 20（仅本地开发/测试需要）
- `git` 在 PATH 中；需要 GitHub API 功能（列全部仓库、Actions/CI、改名、私有库）时配置 PAT，仅做公开库拉取可以不用

## 许可证

MIT
