import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

// tsc 用 rootDir='.' 编译整个 workspace，产物落在 dist/packages/<name>/src/，而各包的
// package.json exports 指向 packages/<name>/dist/index.js —— 两边对不上，node 在宿主上解析
// @luoli/* 会直接 ERR_MODULE_NOT_FOUND。把产物搬到 exports 声明的位置，宿主和容器共用一套布局。
const PACKAGES = ["shared", "db", "core", "server", "telegram", "plugin-sdk"];

for (const name of PACKAGES) {
  const from = resolve("dist/packages", name, "src");
  const to = resolve("packages", name, "dist");
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
}
process.stdout.write(
  `postbuild: ${PACKAGES.length} 个包的产物已就位（packages/<name>/dist/）\n`,
);
