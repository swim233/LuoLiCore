import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

// tsc 以 rootDir='.' 编译整个 workspace，产物位于 dist/packages/<name>/src/，而各包的
// package.json exports 指向 packages/<name>/dist/index.js，两者不一致会使 node 在宿主上解析
// @luoli/* 时报 ERR_MODULE_NOT_FOUND。将产物移动到 exports 声明的位置，宿主与容器共用同一套布局。
const PACKAGES = ["shared", "db", "core", "server", "telegram", "plugin-sdk", "sdk-client"];

for (const name of PACKAGES) {
  const from = resolve("dist/packages", name, "src");
  const to = resolve("packages", name, "dist");
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
}
process.stdout.write(
  `postbuild: ${PACKAGES.length} 个包的产物已就位（packages/<name>/dist/）\n`,
);
