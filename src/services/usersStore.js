import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, "../../data");
const dbPath = path.join(dataDir, "users.sqlite");

let dbPromise;

async function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    await fs.mkdir(dataDir, { recursive: true });
    const db = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        last_chat_id TEXT,
        last_chat_type TEXT,
        dm_verified INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
    await db.exec("ALTER TABLE users ADD COLUMN dm_verified INTEGER NOT NULL DEFAULT 0;").catch(() => {});
    return db;
  })();
  return dbPromise;
}

export async function upsertUser(from, chat) {
  if (!from?.id) return;
  const db = await getDb();
  const now = new Date().toISOString();
  await db.run(
    `
    INSERT INTO users (user_id, username, first_name, last_name, last_chat_id, last_chat_type, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      last_chat_id = excluded.last_chat_id,
      last_chat_type = excluded.last_chat_type,
      updated_at = excluded.updated_at;
    `,
    [
      from.id,
      from.username || null,
      from.first_name || null,
      from.last_name || null,
      chat?.id ? String(chat.id) : null,
      chat?.type || null,
      now
    ]
  );
}

export async function isDmVerified(userId) {
  if (!userId) return false;
  const db = await getDb();
  const row = await db.get("SELECT dm_verified FROM users WHERE user_id = ?", [userId]);
  return Number(row?.dm_verified || 0) === 1;
}

export async function setDmVerified(userId, verified) {
  if (!userId) return;
  const db = await getDb();
  await db.run(
    `
    INSERT INTO users (user_id, dm_verified, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      dm_verified = excluded.dm_verified,
      updated_at = excluded.updated_at;
    `,
    [userId, verified ? 1 : 0, new Date().toISOString()]
  );
}
