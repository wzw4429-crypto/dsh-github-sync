/**
 * 状态持久化：JSON 文件（默认 <profile>/github-sync-state.json），原子写。
 *
 * @module dsh-github-sync/state
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HISTORY_LIMIT = 20;

export function emptyState() {
  return { version: 1, updatedAt: 0, repos: {}, userRepos: [], allRepos: null, renamed: {} };
}

export function loadState(file) {
  if (!file || !existsSync(file)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const state = emptyState();
    if (raw && typeof raw === 'object') {
      state.updatedAt = Number(raw.updatedAt) || 0;
      if (raw.repos && typeof raw.repos === 'object') state.repos = raw.repos;
      if (Array.isArray(raw.userRepos)) state.userRepos = raw.userRepos;
      if (raw.allRepos && typeof raw.allRepos === 'object') state.allRepos = raw.allRepos;
      if (raw.renamed && typeof raw.renamed === 'object') state.renamed = raw.renamed;
    }
    return state;
  } catch {
    return emptyState();
  }
}

export function saveState(file, state) {
  if (!file) return false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `${basenameSafe(file)}.tmp`);
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    try {
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
      try { rmSync(tmp, { force: true }); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

function basenameSafe(file) {
  const parts = String(file).split(/[\\/]/);
  return parts[parts.length - 1] || 'state.json';
}

function repoSlot(state, name) {
  if (!state.repos[name]) {
    state.repos[name] = { lastSync: null, lastPipeline: null, history: [], ci: null };
  }
  const slot = state.repos[name];
  if (!Array.isArray(slot.history)) slot.history = [];
  return slot;
}

/** 记录一次同步结果（历史截尾 20 条）。 */
export function recordSync(state, name, result) {
  const slot = repoSlot(state, name);
  slot.lastSync = result;
  slot.history.push({ kind: 'sync', ts: Date.now(), status: result.status, message: result.message, ok: result.ok });
  if (slot.history.length > HISTORY_LIMIT) slot.history = slot.history.slice(-HISTORY_LIMIT);
  state.updatedAt = Date.now();
  return slot;
}

/** 记录一次流水线结果。 */
export function recordPipeline(state, name, result) {
  const slot = repoSlot(state, name);
  slot.lastPipeline = result;
  slot.history.push({ kind: 'pipeline', ts: Date.now(), status: result.status, message: result.message, ok: result.ok });
  if (slot.history.length > HISTORY_LIMIT) slot.history = slot.history.slice(-HISTORY_LIMIT);
  state.updatedAt = Date.now();
  return slot;
}

/** 缓存 CI 查询结果。 */
export function setCi(state, name, ci) {
  const slot = repoSlot(state, name);
  slot.ci = { ...ci, fetchedAt: Date.now() };
  state.updatedAt = Date.now();
  return slot;
}

/** 面板/工具用读取。 */
export function getRepoState(state, name) {
  return state.repos[name] || { lastSync: null, lastPipeline: null, history: [], ci: null };
}

/** 运行时加入的仓库列表（面板/工具添加，持久化）。 */
export function getUserRepos(state) {
  return Array.isArray(state.userRepos) ? state.userRepos : [];
}

/** 追加一个运行时仓库条目（调用方负责去重）。 */
export function addUserRepo(state, entry) {
  const list = getUserRepos(state);
  list.push(entry);
  state.userRepos = list;
  state.updatedAt = Date.now();
  return list;
}

/** 移除一个运行时仓库条目；返回是否移除。 */
export function removeUserRepo(state, name) {
  const list = getUserRepos(state);
  const next = list.filter((r) => r && r.name !== name);
  const removed = next.length !== list.length;
  state.userRepos = next;
  state.updatedAt = Date.now();
  return removed;
}

/** 缓存 /user/repos 全部仓库列表。 */
export function setAllRepos(state, repos) {
  state.allRepos = { fetchedAt: Date.now(), repos };
  state.updatedAt = Date.now();
  return state.allRepos;
}

/** 读取全部仓库缓存。 */
export function getAllRepos(state) {
  return state.allRepos && Array.isArray(state.allRepos.repos) ? state.allRepos : null;
}

/** 记录一次改名（配置仓库改名不改配置文件，用映射覆盖；runtime 条目直接改）。 */
export function setRenamed(state, oldName, patch) {
  if (!state.renamed || typeof state.renamed !== 'object') state.renamed = {};
  state.renamed[oldName] = { name: patch.name, url: patch.url || '', at: Date.now() };
  state.updatedAt = Date.now();
  return state.renamed[oldName];
}

/** 读取改名映射。 */
export function getRenamed(state) {
  return state.renamed && typeof state.renamed === 'object' ? state.renamed : {};
}

/** 更新一个运行时仓库条目（按原名）；返回是否更新。 */
export function updateUserRepo(state, oldName, patch) {
  const list = getUserRepos(state);
  const entry = list.find((r) => r && r.name === oldName);
  if (!entry) return false;
  Object.assign(entry, patch);
  state.updatedAt = Date.now();
  return true;
}

/** 同步历史/缓存槽位键名（改名后 lastSync/history/ci 跟随新名）。 */
export function renameRepoSlot(state, oldName, newName) {
  if (state.repos && state.repos[oldName] && oldName !== newName) {
    state.repos[newName] = state.repos[oldName];
    delete state.repos[oldName];
    state.updatedAt = Date.now();
  }
}
