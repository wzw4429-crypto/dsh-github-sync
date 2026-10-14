/**
 * 仓库活跃度：把「未提交改动 / 最近文件修改 / 最近提交」折算成可排序分数。
 * 纯函数 + 显式规则，便于单测；宿主按分数降序展示仓库（活跃的排前面）。
 *
 * @module dsh-github-sync/activity
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { git } from './git.js';

const SCAN_CAP = 200; // 顶层扫描条目上限

/** 时近度打分：越近分越高（阶梯，确定性规则）。 */
export function recencyPoints(ts, now, weight) {
  if (!ts || !Number.isFinite(ts)) return 0;
  const minutes = (now - ts) / 60000;
  if (minutes <= 5) return weight;
  if (minutes <= 60) return Math.round(weight * 0.6);
  if (minutes <= 1440) return Math.round(weight * 0.25);
  return 0;
}

/**
 * 活跃度分数（越大越活跃）。
 * dirty +1000；工作树最新文件修改(权重100) + 最近提交(权重60) 的时近度阶梯分。
 */
export function activityScore({ dirty, newestFileTs, lastCommitTs }, now) {
  let score = 0;
  if (dirty) score += 1000;
  score += recencyPoints(newestFileTs, now, 100);
  score += recencyPoints(lastCommitTs, now, 60);
  return score;
}

/** 是否算「正在使用」：有未提交改动，或 1 小时内动过文件/提交过。 */
export function isActive({ dirty, newestFileTs, lastCommitTs }, now) {
  const withinHour = (ts) => Boolean(ts) && now - ts <= 60 * 60000;
  return Boolean(dirty) || withinHour(newestFileTs) || withinHour(lastCommitTs);
}

/** 探测仓库活跃信号：git 最近提交时间 + 顶层文件最新 mtime（不含 .git）。 */
export async function probeActivity(repoPath) {
  let lastCommitTs = 0;
  try {
    const r = await git(repoPath, ['log', '-1', '--format=%ct']);
    if (r.ok && r.stdout) lastCommitTs = Number(r.stdout) * 1000;
  } catch {}
  let newestFileTs = 0;
  try {
    const dirents = await fsp.readdir(repoPath, { withFileTypes: true });
    let scanned = 0;
    for (const d of dirents) {
      if (scanned >= SCAN_CAP) break;
      if (d.name === '.git') continue;
      scanned++;
      try {
        const s = await fsp.stat(path.join(repoPath, d.name));
        if (s.mtimeMs > newestFileTs) newestFileTs = s.mtimeMs;
      } catch {}
    }
  } catch {}
  const now = Date.now();
  return {
    lastCommitTs,
    newestFileTs,
    now,
  };
}
