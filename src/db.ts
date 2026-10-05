import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/* ==================================================
   DB — ثبت مشتری‌ها و وضعیت session آن‌ها
   chat_id = شماره JID فرستنده پیام به ربات
   ================================================== */

export interface ClientRow {
  id: number;
  chat_id: string;
  phone: string | null;
  status: string; /* connected | disconnected | logged_out | invalid */
  created_at: string;
  updated_at: string;
}

export class DB {
  private db: Database.Database;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new Database(file);
  }

  init(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT UNIQUE NOT NULL,
        phone TEXT,
        status TEXT NOT NULL DEFAULT 'disconnected',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  upsertConnected(chatId: string, phone: string): void {
    this.db
      .prepare(
        `INSERT INTO clients (chat_id, phone, status) VALUES (?, ?, 'connected')
         ON CONFLICT(chat_id) DO UPDATE SET
           phone = excluded.phone,
           status = 'connected',
           updated_at = datetime('now')`
      )
      .run(chatId, phone);
  }

  setStatus(chatId: string, status: string): void {
    this.db
      .prepare(
        `INSERT INTO clients (chat_id, status) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`
      )
      .run(chatId, status);
  }

  getByChat(chatId: string): ClientRow | undefined {
    return this.db.prepare('SELECT * FROM clients WHERE chat_id = ?').get(chatId) as ClientRow | undefined;
  }

  listConnected(): ClientRow[] {
    return this.db
      .prepare(`SELECT * FROM clients WHERE status = 'connected' ORDER BY id`)
      .all() as ClientRow[];
  }

  listAll(): ClientRow[] {
    return this.db.prepare('SELECT * FROM clients ORDER BY id DESC').all() as ClientRow[];
  }

  countConnected(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM clients WHERE status = 'connected'`).get() as { c: number }).c;
  }

  delete(chatId: string): void {
    this.db.prepare('DELETE FROM clients WHERE chat_id = ?').run(chatId);
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
