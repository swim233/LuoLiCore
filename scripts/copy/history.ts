/**
 * 保存历史：每次〔保存〕之前的那一份源码存一层，可以往回退任意一步。
 *
 * 为什么是逐次快照而不是「一份原始基线」：基线一旦定死就永远是最初那一版，等整站文案改完，
 * 「还原到最初」会抹掉几天的工作 —— 那个按钮迟早没人敢按，等于没有。逐次栈的语义和撤销一致：
 * 退到第 N 次保存**之前**，就是把第 N 次及其之后碰过的每个文件写回 N 之前的样子。
 *
 * 落盘而不是留在内存里：dev server 一天重启十几次（改 vite.config、改插件都会重启），
 * 只在内存里的历史那时就空了，而人对「历史」的期待恰恰是它比进程活得久。
 * 目录 `.luoli-copy-history/` 已被 `.gitignore` 的 `.luoli-*` 覆盖 —— 快照是本机产物，不进版本库。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { restore } from './extract.js';

/**
 * 快照目录。`LUOLI_COPY_HISTORY` 只为测试而存在：用例要能建、能删、能数自己的历史，
 * 而**不能碰到真的那一份** —— 那里面是人刚才改的每一句话，删掉就没了。
 */
const home = (): string => process.env.LUOLI_COPY_HISTORY ?? '.luoli-copy-history';
/** 留最近多少步。再往前是 git 的事 —— 快照是「刚才那几下」的网，不是版本控制。 */
const CAP = 20;

export interface Step { id: string; at: number; applied: number; files: string[] }
interface Manifest { at: number; applied: number; files: Record<string, string> }

const dirs = (): string[] => (existsSync(home()) ? readdirSync(home()).filter((name) => /^\d{4}$/.test(name)).sort() : []);
const manifestOf = (id: string): Manifest | null => {
  try { return JSON.parse(readFileSync(join(home(), id, 'manifest.json'), 'utf8')) as Manifest; } catch { return null; }
};

/** 从旧到新。面板自己倒过来显示 —— 这里保持时间序，`rewind` 依赖它。 */
export function steps(): Step[] {
  return dirs().flatMap((id) => {
    const manifest = manifestOf(id);
    return manifest ? [{ id, at: manifest.at, applied: manifest.applied, files: Object.keys(manifest.files) }] : [];
  });
}

/**
 * 存一层。`before` 是 `applyChanges` 交回来的「改动前内容」，键是仓库相对路径。
 *
 * 文件按序号存成 blob 而不是按路径建目录：路径里有 `/`，照原样建目录要么撞上 Windows 的
 * 保留字符，要么在 `packages/webui/src/...` 这种深度上把快照目录搞得比源码树还乱。
 */
export function snapshot(before: Record<string, string>, applied: number): Step | null {
  const paths = Object.keys(before);
  if (!paths.length) return null;
  const id = String(Number(dirs().at(-1) ?? '0') + 1).padStart(4, '0');
  const seat = join(home(), id);
  mkdirSync(seat, { recursive: true });
  const files: Record<string, string> = {};
  for (const [index, path] of paths.entries()) {
    const blob = `${index + 1}.snap`;
    writeFileSync(join(seat, blob), before[path] ?? '');
    files[path] = blob;
  }
  const manifest: Manifest = { at: Date.now(), applied, files };
  writeFileSync(join(seat, 'manifest.json'), JSON.stringify(manifest));
  for (const stale of dirs().slice(0, -CAP)) rmSync(join(home(), stale), { recursive: true, force: true });
  return { id, at: manifest.at, applied, files: paths };
}

/**
 * 退到 `to` 这一步**之前**（不给 `to` 就是退最近一步）。
 *
 * 一个文件可能在 N、N+1、N+2 里都被碰过，要写回的是**最早那一份** —— 后面那些都是它之后的
 * 状态。所以从 N 往新走，同一个路径只认第一次见到的内容。
 *
 * 退完把 N 及其之后的层删掉：它们描述的世界已经不存在了，留着会让「往回退两步」第二次点下去
 * 退到一个从未存在过的混合状态。
 */
export function rewind(to?: string): { ok: true; files: string[]; dropped: string[] } | { ok: false; reason: string } {
  const all = dirs();
  if (!all.length) return { ok: false, reason: '还没有任何保存历史' };
  const target = to ?? all[all.length - 1] ?? '';
  const from = all.indexOf(target);
  if (from < 0) return { ok: false, reason: `历史里没有 ${target} 这一步` };
  const merged: Record<string, string> = {};
  for (const id of all.slice(from)) {
    const manifest = manifestOf(id);
    if (!manifest) continue;
    for (const [path, blob] of Object.entries(manifest.files)) {
      if (path in merged) continue;
      try { merged[path] = readFileSync(join(home(), id, blob), 'utf8'); } catch { /* 缺一份就少还一份，不要整批失败 */ }
    }
  }
  const files = restore(merged);
  const dropped = all.slice(from);
  for (const id of dropped) rmSync(join(home(), id), { recursive: true, force: true });
  return { ok: true, files, dropped };
}
