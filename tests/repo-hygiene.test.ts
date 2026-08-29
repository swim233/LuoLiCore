import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUNDLED_SKILLS } from '@luoli/core';

/**
 * `.gitignore` 与代码之间的两条一致性。
 *
 * `skills/` / `plugins/` / `memory/` 都是**运行时目录**：模型能往里写（`write_skill` /
 * `install_skill` / `write_plugin` / `memory_write`），装包能往里放几 MB 的二进制，
 * 而随包发的那几份说明文档是版本库的内容。这条边界只写在 `.gitignore` 里，没有任何断言 ——
 * 于是它必然会漂：加第五份随包 skill 而忘了改白名单，表现是**它悄悄不进版本库**，
 * 而 `git status` 干干净净，一次提交、一次 `docker build` 都不会报任何东西。
 */

const IGNORE = '.gitignore';

function ignoreLines(): string[] {
  return readFileSync(IGNORE, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

describe('版本库卫生', () => {
  it('.gitignore 的 skills 白名单等于 BUNDLED_SKILLS', () => {
    const lines = ignoreLines();
    expect(lines, '`skills/*` 那条不在了 —— 装进来的包与模型写的 skill 会重新开始进版本库').toContain('skills/*');
    const allowed = lines
      .filter((line) => line.startsWith('!skills/') && line.endsWith('/'))
      .map((line) => line.slice('!skills/'.length, -1));
    // 两个方向都要：少一条 = 那份随包 skill 不进版本库；多一条 = 一个装进来的包被当成随包的提交上去。
    expect([...allowed].sort()).toEqual([...BUNDLED_SKILLS].sort());
  });

  it('随包那几份 skill 真的在盘上，且没有 .package.json', () => {
    for (const name of BUNDLED_SKILLS) {
      expect(existsSync(`skills/${name}/SKILL.md`), `skills/${name}/SKILL.md 不在盘上，而 .gitignore 把它当随包的放行了`).toBe(true);
      // `sourceOf()` 靠 `.package.json` 的有无区分 package 与 local；随包那几份多出这个文件的话，
      // 它们会被判成 `package` —— 界面上那个「未审阅」徽标会挂在四份说明文档上。
      expect(existsSync(`skills/${name}/.package.json`), `skills/${name} 里有 .package.json，它会被 sourceOf() 判成装包进来的`).toBe(false);
    }
  });

  /**
   * `docker/Dockerfile` 里 `COPY skills ./skills` 与 `COPY memory ./memory` 是**硬要求**：
   * 构建上下文里找不到目录会当场失败。而 `skills/*` 被忽略之后，让它继续存在于版本库里的
   * 只有那几份随包 skill 与这个 `.gitkeep` —— 哪天随包 skill 被全部摘掉，`.gitkeep` 就是
   * 最后一道。`memory/` 由 `CHARACTER.md` / `ASSIST.md` 撑着（见下一条），不额外要求。
   *
   * `plugins/` / `data/` / `logs/` 只被 `RUN mkdir -p`，构建不依赖它们；`plugins/.gitkeep`
   * 是为了 compose 绑挂 `./plugins` 时宿主上已经有这个目录（否则 docker 会用 root 建出来）。
   * `data/` 与 `logs/` 那两条 `!…/.gitkeep` 例外**目前指向不存在的文件**，属既有状态，
   * 不在这里断言（那两个目录构建时会被 `mkdir -p` 建出来，所以没有实际后果）。
   */
  it('skills/ 与 plugins/ 留了 .gitkeep', () => {
    for (const dir of ['skills', 'plugins']) {
      expect(existsSync(`${dir}/.gitkeep`), `${dir}/.gitkeep 不在，而 ${dir}/* 被忽略 —— 这个目录会从版本库里整个消失`).toBe(true);
    }
  });

  it('模型写的记忆被忽略，而人格与助手规则留在版本库里', () => {
    const lines = ignoreLines();
    // PUBMEMORY.md 由 `memory_write` 工具写，private/ 是每用户一份的私有记忆，
    // .forgotten/ 存的是「被遗忘的私有记忆正文」—— 最后这个进版本库是隐私问题而不只是噪音。
    for (const path of ['memory/PUBMEMORY.md', 'memory/private/', 'memory/.pending/', 'memory/.forgotten/']) {
      expect(lines, `${path} 不在忽略名单里`).toContain(path);
    }
    // 反方向：这两份是提示词文档（有真实编写提交、只经 WebUI 改），不该被顺手一起忽略掉。
    for (const kept of ['memory/CHARACTER.md', 'memory/ASSIST.md']) {
      expect(lines).not.toContain(kept);
      expect(existsSync(kept), `${kept} 不在盘上`).toBe(true);
    }
  });
});
