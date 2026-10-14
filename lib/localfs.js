/**
 * 本地仓库内容浏览：目录列举与文本预览，带路径穿越防护。
 * 所有路径都必须落在仓库根之内（含符号链接目标的二次校验不展开，仅做词法防护）。
 *
 * @module dsh-github-sync/localfs
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const PREVIEW_LIMIT = 131072; // 128 KB
const MAX_ENTRIES = 500;

/**
 * 解析并校验相对路径落在 root 内；越界抛 Error('path-escape')。
 * @param {string} root 仓库根（绝对路径）
 * @param {string} rel 相对路径（'' = 根）
 */
export function safePath(root, rel) {
  const base = path.resolve(root);
  const target = path.resolve(base, String(rel || ''));
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(baseWithSep)) {
    throw new Error(`path-escape: ${rel}`);
  }
  return { base, target };
}

/** 是否疑似二进制（前 8KB 含 NUL）。 */
export function looksBinary(buffer) {
  const len = Math.min(buffer.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * 列举目录：{kind:'dir', path, entries:[{name, type, size, mtime}]}。
 * 条目按 类型(目录优先) + 名称 排序，数量上限 MAX_ENTRIES。
 */
export async function listLocalDir(root, rel) {
  const { base, target } = safePath(root, rel);
  const stat = await fsp.stat(target);
  if (!stat.isDirectory()) throw new Error(`not-a-directory: ${rel}`);
  const dirents = await fsp.readdir(target, { withFileTypes: true });
  const entries = [];
  for (const d of dirents.slice(0, MAX_ENTRIES)) {
    let size = 0;
    let mtime = 0;
    try {
      const s = await fsp.stat(path.join(target, d.name));
      size = s.size;
      mtime = s.mtimeMs;
    } catch {}
    entries.push({
      name: d.name,
      type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file',
      size,
      mtime,
    });
  }
  entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (b.type === 'dir' && a.type !== 'dir') return 1;
    return a.name.localeCompare(b.name);
  });
  const relOut = path.relative(base, target).split(path.sep).join('/');
  return { kind: 'dir', path: relOut, entries, truncated: dirents.length > MAX_ENTRIES };
}

/**
 * 读文件预览：{kind:'file', path, size, mtime, binary, truncated, content}。
 * 二进制文件 content 为空串（只给元数据）；文本超 PREVIEW_LIMIT 截断。
 */
export async function readLocalFile(root, rel) {
  const { target } = safePath(root, rel);
  const stat = await fsp.stat(target);
  if (stat.isDirectory()) throw new Error(`is-a-directory: ${rel}`);
  const handle = await fsp.open(target, 'r');
  try {
    const buf = Buffer.alloc(Math.min(stat.size, PREVIEW_LIMIT));
    await handle.read(buf, 0, buf.length, 0);
    const binary = looksBinary(buf);
    return {
      kind: 'file',
      path: String(rel || '').split('\\').join('/'),
      size: stat.size,
      mtime: stat.mtimeMs,
      binary,
      truncated: stat.size > PREVIEW_LIMIT,
      content: binary ? '' : buf.toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}
