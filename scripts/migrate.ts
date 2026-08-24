import { mkdir } from "node:fs/promises";
import { openDatabase, migrateDatabase, closeDatabase } from "@luoli/db";
import { loadConfig } from "@luoli/core";

const config = await loadConfig({ requireOwner: false });
await mkdir("data", { recursive: true, mode: 0o700 });
const db = openDatabase(config.db.path);
migrateDatabase(db);
closeDatabase(db);
process.stdout.write(`Migrated ${config.db.path}\n`);
