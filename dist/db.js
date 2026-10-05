"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DB = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
class DB {
    db;
    constructor(file) {
        fs_1.default.mkdirSync(path_1.default.dirname(path_1.default.resolve(file)), { recursive: true });
        this.db = new better_sqlite3_1.default(file);
    }
    init() {
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
    upsertConnected(chatId, phone) {
        this.db
            .prepare(`INSERT INTO clients (chat_id, phone, status) VALUES (?, ?, 'connected')
         ON CONFLICT(chat_id) DO UPDATE SET
           phone = excluded.phone,
           status = 'connected',
           updated_at = datetime('now')`)
            .run(chatId, phone);
    }
    setStatus(chatId, status) {
        this.db
            .prepare(`INSERT INTO clients (chat_id, status) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`)
            .run(chatId, status);
    }
    getByChat(chatId) {
        return this.db.prepare('SELECT * FROM clients WHERE chat_id = ?').get(chatId);
    }
    listConnected() {
        return this.db
            .prepare(`SELECT * FROM clients WHERE status = 'connected' ORDER BY id`)
            .all();
    }
    listAll() {
        return this.db.prepare('SELECT * FROM clients ORDER BY id DESC').all();
    }
    countConnected() {
        return this.db.prepare(`SELECT COUNT(*) AS c FROM clients WHERE status = 'connected'`).get().c;
    }
    delete(chatId) {
        this.db.prepare('DELETE FROM clients WHERE chat_id = ?').run(chatId);
    }
    close() {
        try {
            this.db.close();
        }
        catch { /* ignore */ }
    }
}
exports.DB = DB;
