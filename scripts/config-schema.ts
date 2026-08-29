import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { configJsonSchema } from "@luoli/core";

const path = resolve("config/config.schema.json");
await mkdir(dirname(path), { recursive: true });
// 与 `GET /api/config/schema` 调用同一个函数：说明文字也在其中，两边只能同步修改。
await writeFile(path, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
process.stdout.write(`${path}\n`);
