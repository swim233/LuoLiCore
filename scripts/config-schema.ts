import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { configSchema } from '@luoli/core';

const path = resolve('config/config.schema.json');
await mkdir(dirname(path), { recursive: true });
await writeFile(path, `${JSON.stringify(zodToJsonSchema(configSchema, 'LuoLiConfig'), null, 2)}\n`);
process.stdout.write(`${path}\n`);
