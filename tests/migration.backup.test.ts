import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase, recoverAfterCrash } from '@luoli/db';

describe('migration backup', () => {
  it('creates a pre-migration backup before applying a pending migration', () => {
    const database = './data/migration-backup/luoli.db'; const migrations = './data/migration-backup/migrations';
    rmSync(dirname(database), { recursive: true, force: true }); mkdirSync(migrations, { recursive: true });
    writeFileSync(`${migrations}/0001_init.sql`, 'CREATE TABLE one(id INTEGER);');
    const db = openDatabase(database); migrateDatabase(db, migrations);
    writeFileSync(`${migrations}/0002_next.sql`, 'CREATE TABLE two(id INTEGER);');
    migrateDatabase(db, migrations);
    const backups = readdirSync(resolve(dirname(database), 'backup')).filter((name) => name.includes('-pre-0002.db'));
    expect(backups).toHaveLength(1); expect(existsSync(resolve(dirname(database), 'backup', backups[0]!))).toBe(true);
    closeDatabase(db);
  });

  it('marks turns, tasks, agents and asks failed or timed out after restart', () => {
    const database = './data/recovery.test.db';
    rmSync(database, { force: true }); rmSync(`${database}-wal`, { force: true }); rmSync(`${database}-shm`, { force: true });
    const db = openDatabase(database); migrateDatabase(db);
    db.prepare("INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,trigger_message_id,trigger_reason,state) VALUES ('t','k','c','u','trusted',1,'mention','running')").run();
    db.prepare("INSERT INTO tasks(id,turn_id,chat_id,user_id,title,state,created_at,updated_at) VALUES ('task','t','c','u','x','running',1,1)").run();
    db.prepare("INSERT INTO agent_runs(id,turn_id,depth,kind,agent_name,model_alias,effective_role,state,started_at) VALUES ('run','t',0,'main','main','main','trusted','running',1)").run();
    db.prepare("INSERT INTO agent_messages(id,turn_id,from_run_id,to_run_id,kind,payload_json,state,created_at) VALUES ('ask','t','run','run','ask','{}','sent',1)").run();
    recoverAfterCrash(db);
    expect(db.prepare('SELECT state FROM turns WHERE id=\'t\'').pluck().get()).toBe('failed');
    expect(db.prepare('SELECT state FROM tasks WHERE id=\'task\'').pluck().get()).toBe('failed');
    expect(db.prepare('SELECT state FROM agent_runs WHERE id=\'run\'').pluck().get()).toBe('failed');
    expect(db.prepare('SELECT state FROM agent_messages WHERE id=\'ask\'').pluck().get()).toBe('timeout');
    closeDatabase(db);
  });
});
