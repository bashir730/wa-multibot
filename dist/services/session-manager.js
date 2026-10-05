"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const boom_1 = require("@hapi/boom");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("../utils/logger");
const session_utils_1 = require("../session-utils");
class SessionManager {
    db;
    root;
    maxClients;
    entries = new Map();
    constructor(db, root = 'sessions', maxClients = 10) {
        this.db = db;
        this.root = root;
        this.maxClients = maxClients;
    }
    dirFor(chatId) {
        const safe = chatId.replace(/[^0-9@._-]/g, '_');
        return path_1.default.resolve(process.cwd(), this.root, safe);
    }
    stateFor(chatId) {
        return this.entries.get(chatId)?.state ?? 'disconnected';
    }
    isConnected(chatId) {
        return this.entries.get(chatId)?.state === 'connected';
    }
    socketFor(chatId) {
        const e = this.entries.get(chatId);
        return e && e.state === 'connected' ? e.sock : null;
    }
    connectedSince(chatId) {
        const e = this.entries.get(chatId);
        return e && e.state === 'connected' ? e.connectedAt : null;
    }
    /**
     * اتصال session مشتری.
     * creds بدهد: اعتبارسنجی + جایگزینی + اتصال بدون QR.
     * creds ندهد: از auth state موجود روی دیسک وصل می‌شود.
     */
    async connectClient(chatId, creds, timeoutMs = 30_000) {
        const dir = this.dirFor(chatId);
        if (creds) {
            if (!(0, session_utils_1.isValidCreds)(creds))
                throw new Error('ساختار سشن نامعتبر است — سشن کامل از سایت بگیر');
            if (!this.isConnected(chatId) && this.db.countConnected() >= this.maxClients) {
                throw new Error('ظرفیت ربات پر است — بعداً تلاش کن');
            }
            await this.endClient(chatId);
            fs_1.default.rmSync(dir, { recursive: true, force: true });
            fs_1.default.mkdirSync(dir, { recursive: true });
            fs_1.default.writeFileSync(path_1.default.join(dir, 'creds.json'), JSON.stringify(creds, null, 2));
        }
        else {
            if (!fs_1.default.existsSync(path_1.default.join(dir, 'creds.json'))) {
                throw new Error('سشنی برای تو ذخیره نشده — اول رشته سشن را بفرست');
            }
            await this.endClient(chatId);
        }
        return this.spawn(chatId, timeoutMs);
    }
    /* ساخت socket و انتظار برای connection = open */
    async spawn(chatId, timeoutMs) {
        const dir = this.dirFor(chatId);
        const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(dir);
        let version;
        try {
            version = (await (0, baileys_1.fetchLatestWaWebVersion)({})).version;
        }
        catch { /* default */ }
        const sock = (0, baileys_1.default)({
            version,
            logger: logger_1.silentLogger,
            printQRInTerminal: false,
            auth: state,
            browser: ['wa-multibot', 'Chrome', '1.0.0'],
            markOnlineOnConnect: false,
            syncFullHistory: false
        });
        const entry = { sock, state: 'connecting', connectedAt: 0 };
        this.entries.set(chatId, entry);
        sock.ev.on('creds.update', saveCreds);
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                try {
                    sock.end(undefined);
                }
                catch { /* ignore */ }
                this.entries.delete(chatId);
                this.db.setStatus(chatId, 'invalid');
                reject(new Error('اتصال طول کشید — سشن احتمالاً نامعتبر یا منقضی است'));
            }, timeoutMs);
            sock.ev.on('connection.update', (u) => {
                const { connection, lastDisconnect } = u;
                if (connection === 'open') {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    entry.state = 'connected';
                    entry.connectedAt = Date.now();
                    const phone = String(sock.user?.id ?? '').split(':')[0].split('@')[0];
                    this.db.upsertConnected(chatId, phone);
                    logger_1.logger.info({ chatId, phone }, 'Client session connected');
                    /* رویدادهای pre-existing را فعال کن تا listeners بعد از resolve کار کنند */
                    resolve({ phone });
                    return;
                }
                if (connection === 'close') {
                    const boom = lastDisconnect?.error ? new boom_1.Boom(lastDisconnect.error) : null;
                    const code = boom?.output?.statusCode;
                    this.entries.delete(chatId);
                    if (code === baileys_1.DisconnectReason.loggedOut) {
                        /* سشن از سمت واتساپ حذف شده */
                        try {
                            fs_1.default.rmSync(dir, { recursive: true, force: true });
                        }
                        catch { /* ignore */ }
                        this.db.setStatus(chatId, 'logged_out');
                        logger_1.logger.warn({ chatId }, 'Client session logged out — cleared');
                    }
                    else {
                        this.db.setStatus(chatId, 'disconnected');
                        logger_1.logger.warn({ chatId, code }, 'Client session closed');
                    }
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        reject(new Error(code === baileys_1.DisconnectReason.loggedOut
                            ? 'سشن از واتساپ حذف شده (logged out) — سشن جدید بگیر'
                            : 'اتصال برقرار نشد — سشن نامعتبر یا منقضی است'));
                    }
                }
            });
        });
    }
    /* وصل‌کردن دوباره همه مشتری‌های متصل قبلی (بعد از restart) */
    restoreAll() {
        for (const row of this.db.listConnected()) {
            if (fs_1.default.existsSync(path_1.default.join(this.dirFor(row.chat_id), 'creds.json'))) {
                this.connectClient(row.chat_id).catch(() => { });
            }
            else {
                this.db.setStatus(row.chat_id, 'disconnected');
            }
        }
    }
    async endClient(chatId) {
        const e = this.entries.get(chatId);
        if (e) {
            try {
                await e.sock.end(undefined);
            }
            catch { /* ignore */ }
            this.entries.delete(chatId);
        }
    }
    async endAll() {
        for (const chatId of [...this.entries.keys()]) {
            await this.endClient(chatId);
        }
    }
}
exports.SessionManager = SessionManager;
