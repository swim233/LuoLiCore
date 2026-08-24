import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { configJsonSchema } from "@luoli/core";

const path = resolve("config/config.schema.json");
await mkdir(dirname(path), { recursive: true });
// 与 `GET /api/config/schema` 走同一个函数：说明文字也在里面，两边只能一起变。
await writeFile(path, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
process.stdout.write(`${path}\n`);
