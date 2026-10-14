# Changelog

## 1.0.0

First public release.

- Bidirectional git sync with conflict policies (`report` / `merge` / `rebase` / `prefer-remote` / `prefer-local`); conflicts abort and roll back, HEAD and working tree are never left half-merged.
- Pre-push local checks (`block` / `warn`), dirty-tree protection, optional auto-commit.
- GitHub Actions: workflow list/dispatch, run list, run detail (jobs and per-step conclusions), check-runs and combined commit status, optional CI workflow provisioning.
- Automation pipeline: sync → ensure CI workflow → dispatch → wait for conclusion → report, with agent notification.
- Repository inventory: list all repos visible to the PAT, add (clone or register an existing local checkout), remove, and rename on GitHub (updates the local remote URL too).
- Web panel: repository cards with sync/CI state, activity-based ordering, Actions drill-down, local and remote file browsers, and the full action set.
- Six agent tools: `github_sync`, `github_status`, `github_ci`, `github_workflow`, `github_repos`, `github_files`.
- Scheduled sync (`intervalMinutes`, optional `runOnStart`).
- PAT is used for GitHub API calls and injected into `git fetch`/`git push` through the environment (never into argv or logs).
