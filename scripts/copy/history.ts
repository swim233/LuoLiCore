/**
 * 保存历史：每次保存前的源码存为一层，可回退任意步数。
 *
 * 采用逐次快照而不是单一原始基线的原因：基线一经确定即固定为最初版本，整站文案改完后
 * 还原到最初会清除数日的工作量，该操作最终无人敢用，等同于不存在。逐次栈的语义与撤销一致：
 * 回退到第 N 次保存之前，即把第 N 次及其之后修改过的每个文件写回 N 之前的状态。
 *
 * 写入磁盘而不是保留在内存：dev server 每天重启十余次（修改 vite.config 或插件均会重启），
 * 仅存于内存的历史届时会清空，而历史的价值恰在于其生命周期长于进程。
 * 目录 `.luoli-copy-history/` 已被 `.gitignore` 中的 `.luoli-*` 覆盖，快照属于本机产物，不进版本库。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { restore } from "./extract.js";

/**
 * 快照目录。`LUOLI_COPY_HISTORY` 仅为测试而存在：用例需能创建、删除、统计自身的历史，
 * 且不得触及真实历史目录，其中保存的是刚修改过的每一句文案，删除后无法恢复。
 */
const home = (): string =>
  process.env.LUOLI_COPY_HISTORY ?? ".luoli-copy-history";
/** 保留最近多少步。更早的版本由 git 负责，快照只覆盖最近若干次操作，不承担版本控制职责。 */
const CAP = 20;

export interface Step {
  id: string;
  at: number;
  applied: number;
  files: string[];
}
interface Manifest {
  at: number;
  applied: number;
  files: Record<string, string>;
}

const dirs = (): string[] =>
  existsSync(home())
    ? readdirSync(home())
        .filter((name) => /^\d{4}$/.test(name))
        .sort()
    : [];
const manifestOf = (id: string): Manifest | null => {
  try {
    return JSON.parse(
      readFileSync(join(home(), id, "manifest.json"), "utf8"),
    ) as Manifest;
  } catch {
    return null;
  }
};

/** 从旧到新排列。面板自行倒序显示，这里保持时间序，`rewind` 依赖该顺序。 */
export function steps(): Step[] {
  return dirs().flatMap((id) => {
    const manifest = manifestOf(id);
    return manifest
      ? [
          {
            id,
            at: manifest.at,
            applied: manifest.applied,
            files: Object.keys(manifest.files),
          },
        ]
      : [];
  });
}

/**
 * 保存一层。`before` 是 `applyChanges` 返回的改动前内容，键为仓库相对路径。
 *
 * 文件按序号存为 blob 而不是按路径建立目录：路径中含 `/`，原样建目录会遇到 Windows 的
 * 保留字符问题，或在 `packages/webui/src/...` 这类深度下使快照目录结构比源码树更复杂。
 */
export function snapshot(
  before: Record<string, string>,
  applied: number,
): Step | null {
  const paths = Object.keys(before);
  if (!paths.length) return null;
  const id = String(Number(dirs().at(-1) ?? "0") + 1).padStart(4, "0");
  const seat = join(home(), id);
  mkdirSync(seat, { recursive: true });
  const files: Record<string, string> = {};
  for (const [index, path] of paths.entries()) {
    const blob = `${index + 1}.snap`;
    writeFileSync(join(seat, blob), before[path] ?? "");
    files[path] = blob;
  }
  const manifest: Manifest = { at: Date.now(), applied, files };
  writeFileSync(join(seat, "manifest.json"), JSON.stringify(manifest));
  for (const stale of dirs().slice(0, -CAP))
    rmSync(join(home(), stale), { recursive: true, force: true });
  return { id, at: manifest.at, applied, files: paths };
}

/**
 * 回退到第 `to` 步之前（不传 `to` 表示回退最近一步）。
 *
 * 同一个文件可能在 N、N+1、N+2 中均被修改，需写回的是最早的那一份，其余都是它之后的
 * 状态。因此从 N 向新遍历，同一路径只取首次遇到的内容。
 *
 * 回退完成后删除 N 及其之后的层：它们描述的状态已不存在，保留会使连续两次回退
 * 到达一个从未存在过的混合状态。
 */
export function rewind(
  to?: string,
):
  | { ok: true; files: string[]; dropped: string[] }
  | { ok: false; reason: string } {
  const all = dirs();
  if (!all.length) return { ok: false, reason: "还没有任何保存历史" };
  const target = to ?? all[all.length - 1] ?? "";
  const from = all.indexOf(target);
  if (from < 0) return { ok: false, reason: `历史里没有 ${target} 这一步` };
  const merged: Record<string, string> = {};
  for (const id of all.slice(from)) {
    const manifest = manifestOf(id);
    if (!manifest) continue;
    for (const [path, blob] of Object.entries(manifest.files)) {
      if (path in merged) continue;
      try {
        merged[path] = readFileSync(join(home(), id, blob), "utf8");
      } catch {
        /* 缺失一份即少还原一份，不使整批操作失败 */
      }
    }
  }
  const files = restore(merged);
  const dropped = all.slice(from);
  for (const id of dropped)
    rmSync(join(home(), id), { recursive: true, force: true });
  return { ok: true, files, dropped };
}
