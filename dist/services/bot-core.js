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
exports.BotCore = void 0;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const boom_1 = require("@hapi/boom");
const qrcode_1 = __importDefault(require("qrcode"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("../utils/logger");
const session_utils_1 = require("../session-utils");
const HELP = `🤖 *wa-multibot*

این ربات روی اکانت *خودت* دستور اجرا می‌کند.

*نحوه اتصال:*
رشته سشن واتساپ‌ات را که از سایت گرفتی، همینجا بفرست (بدون هیچ دستوری) تا وصلت کنم.

*دستورها:*
1. *منو* — همین راهنما
2. *وضعیت* — وضعیت اتصال اکانت تو
3. *ارسال شماره متن* — از اکانت خودت پیام می‌فرستد، مثال: ارسال +93712345678 سلام
4. *قطع* — قطع‌کردن اکانت از ربات`;
class BotCore {
    db;
    mgr;
    onClientConnected;
    state = 'disconnected';
    phone = null;
    startedAt = Date.now();
    lastQr = null;
    lastQrPng = null; /* data-url برای صفحه /qr */
    sock = null;
    connecting = false;
    reconnectTimer = null;
    sessionDir;
    constructor(db, mgr, onClientConnected) {
        this.db = db;
        this.mgr = mgr;
        this.onClientConnected = onClientConnected;
        this.sessionDir = path_1.default.resolve(process.cwd(), 'sessions', '__bot');
    }
    /* ---------- state صفحات وب ---------- */
    getLastQrPng() {
        return this.lastQrPng;
    }
    getState() {
        return this.state;
    }
    getPhone() {
        return this.phone;
    }
    /* ورود ربات مرکزی با session (بدون QR) */
    async importSession(creds) {
        if (!(0, session_utils_1.isValidCreds)(creds))
            throw new Error('ساختار سشن نامعتبر است');
        await this.end();
        fs_1.default.rmSync(this.sessionDir, { recursive: true, force: true });
        fs_1.default.mkdirSync(this.sessionDir, { recursive: true });
        fs_1.default.writeFileSync(path_1.default.join(this.sessionDir, 'creds.json'), JSON.stringify(creds, null, 2));
        void this.connect();
        const phone = creds && typeof creds === 'object' ? creds.me?.id?.split(':')[0].split('@')[0] ?? null : null;
        return { phone };
    }
    async connect() {
        if (this.connecting || this.state === 'connected')
            return;
        this.connecting = true;
        this.state = 'connecting';
        try {
            fs_1.default.mkdirSync(this.sessionDir, { recursive: true });
            const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(this.sessionDir);
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
                browser: ['wa-multibot-core', 'Chrome', '1.0.0'],
                markOnlineOnConnect: false,
                syncFullHistory: false
            });
            this.sock = sock;
            sock.ev.on('creds.update', saveCreds);
            sock.ev.on('connection.update', (u) => {
                const { connection, lastDisconnect, qr } = u;
                if (qr) {
                    /* QR فقط در حافظه برای صفحه وب — هرگز در لاگ */
                    this.state = 'connecting';
                    this.lastQr = qr;
                    qrcode_1.default.toDataURL(qr)
                        .then((url) => { this.lastQrPng = url; })
                        .catch(() => { this.lastQrPng = null; });
                    logger_1.logger.info('Bot authentication required — scan QR on the /qr page');
                }
                if (connection === 'open') {
                    this.connecting = false;
                    this.lastQr = null;
                    this.lastQrPng = null;
                    this.state = 'connected';
                    this.phone = String(sock.user?.id ?? '').split(':')[0].split('@')[0];
                    logger_1.logger.info({ phone: this.phone }, 'Central bot connected');
                    this.onClientConnected();
                }
                if (connection === 'close') {
                    const boom = lastDisconnect?.error ? new boom_1.Boom(lastDisconnect.error) : null;
                    const code = boom?.output?.statusCode;
                    this.sock = null;
                    this.connecting = false;
                    if (code === baileys_1.DisconnectReason.loggedOut) {
                        this.state = 'logged_out';
                        logger_1.logger.warn('Bot session logged out — cleared, new QR will be issued');
                        try {
                            fs_1.default.rmSync(this.sessionDir, { recursive: true, force: true });
                        }
                        catch { /* ignore */ }
                        this.scheduleReconnect(3000);
                        return;
                    }
                    this.state = 'disconnected';
                    this.phone = null;
                    logger_1.logger.warn({ code }, 'Central bot disconnected');
                    this.scheduleReconnect();
                }
            });
            /* ---------- پیام‌های مشتری‌ها ---------- */
            sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify')
                    return;
                for (const m of messages) {
                    try {
                        await this.handle(m);
                    }
                    catch (err) {
                        logger_1.logger.warn({ err: err.message }, 'message handler error');
                    }
                }
            });
        }
        catch (err) {
            this.connecting = false;
            this.state = 'disconnected';
            logger_1.logger.error({ err: err.message }, 'Bot connect failed');
            this.scheduleReconnect();
        }
    }
    scheduleReconnect(delayMs) {
        if (this.reconnectTimer)
            return;
        const delay = delayMs ?? 5000;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);
    }
    async end() {
        if (this.sock) {
            try {
                await this.sock.end(undefined);
            }
            catch { /* ignore */ }
            this.sock = null;
        }
    }
    async reply(jid, text) {
        if (!this.sock || this.state !== 'connected')
            return;
        try {
            await this.sock.sendMessage(jid, { text });
        }
        catch (err) {
            logger_1.logger.warn({ err: err.message }, 'reply failed');
        }
    }
    /* ---------- منطق پیام ---------- */
    async handle(m) {
        if (!m.message || m.key.fromMe)
            return;
        const jid = m.key.remoteJid ?? '';
        if (!jid.endsWith('@s.whatsapp.net'))
            return; /* فقط چت خصوصی */
        const text = extractText(m.message);
        if (!text)
            return;
        /* 1) رشته سشن؟ */
        if ((0, session_utils_1.looksLikeSession)(text)) {
            await this.handleSession(jid, text);
            return;
        }
        /* 2) دستور */
        await this.handleCommand(jid, text.trim());
    }
    async handleSession(jid, text) {
        const creds = (0, session_utils_1.parseSessionString)(text);
        if (!creds || !(0, session_utils_1.isValidCreds)(creds)) {
            await this.reply(jid, '❌ سشن نامعتبر است — رشته سشن کامل را از سایت بگیر و دوباره بفرست');
            return;
        }
        await this.reply(jid, '🔄 در حال بررسی و اتصال سشن... چند ثانیه صبر کن');
        try {
            const { phone } = await this.mgr.connectClient(jid, creds);
            this.onClientConnected();
            await this.reply(jid, `✅ *متصل شد!*\n\nشماره: +${phone}\nاز اینجا دستورها روی اکانت خودت اجرا می‌شود.\nبرای دیدن دستورها بفرست: *منو*`);
        }
        catch (err) {
            await this.reply(jid, `❌ ${err.message}`);
        }
    }
    async handleCommand(jid, text) {
        const cmd = text.replace(/^[.!\/]+/, '').toLowerCase();
        const firstWord = cmd.split(/\s+/)[0];
        /* منو برای همه */
        if (['منو', 'menu', 'start', 'شروع', 'سلام', 'hi', 'hello', 'help'].includes(firstWord)) {
            await this.reply(jid, HELP);
            return;
        }
        const row = this.db.getByChat(jid);
        if (!row) {
            await this.reply(jid, 'این ربات روی اکانت *خودت* دستور اجرا می‌کند.\n\nاول رشته سشن واتساپ‌ات را که از سایت گرفتی همینجا بفرست تا وصلت کنم. 🚀');
            return;
        }
        /* اتصال دوباره خودکار اگر سشن روی دیسک هست ولی وصل نیست */
        if (!this.mgr.isConnected(jid) && fs_1.default.existsSync(path_1.default.join(this.mgr.dirFor(jid), 'creds.json'))) {
            await this.reply(jid, '🔄 اکانتت وصل نبود — در حال وصل‌کردن دوباره...');
            try {
                await this.mgr.connectClient(jid);
            }
            catch { /* پایین خطا می‌دهیم */ }
        }
        const sock = this.mgr.socketFor(jid);
        if (firstWord === 'وضعیت' || firstWord === 'status') {
            if (!sock) {
                await this.reply(jid, `❌ اکانت شما وصل نیست.\nسشن جدید از سایت بگیر و بفرست تا دوباره وصل کنم.`);
            }
            else {
                const since = this.mgr.connectedSince(jid) ?? Date.now();
                const mins = Math.round((Date.now() - since) / 60000);
                await this.reply(jid, `✅ متصل — شماره: +${row.phone ?? '؟'}\n⏱ مدت اتصال: ${mins} دقیقه`);
            }
            return;
        }
        if (firstWord === 'قطع' || firstWord === 'disconnect' || firstWord === 'logout' || firstWord === 'خروج') {
            await this.mgr.endClient(jid);
            this.db.setStatus(jid, 'disconnected');
            await this.reply(jid, '🔌 اکانت تو از ربات قطع شد.\nبرای اتصال دوباره، سشن بفرست.');
            return;
        }
        /* ارسال پیام از اکانت مشتری */
        if (firstWord === 'ارسال' || firstWord === 'send') {
            const rest = text.replace(/^\S+\s+/, '').trim();
            const match = rest.match(/^(\+?[0-9]{7,15})\s+([\s\S]+)$/);
            if (!sock) {
                await this.reply(jid, '❌ اکانت شما وصل نیست — اول سشن بفرست.');
                return;
            }
            if (!match) {
                await this.reply(jid, 'فرمت درست:\n*ارسال شماره متن*\nمثال: ارسال +93712345678 سلام از طرف من');
                return;
            }
            const to = `${match[1].replace('+', '')}@s.whatsapp.net`;
            try {
                await sock.sendMessage(to, { text: match[2] });
                await this.reply(jid, `✅ پیام به +${match[1].replace('+', '')} از اکانت خودت ارسال شد.`);
            }
            catch (err) {
                await this.reply(jid, `❌ ارسال شکست خورد: ${err.message}`);
            }
            return;
        }
        await this.reply(jid, 'دستور شناخته نشد — *منو* بفرست.');
    }
}
exports.BotCore = BotCore;
function extractText(message) {
    const c = message.conversation;
    if (c)
        return c;
    const e = message.extendedTextMessage?.text;
    if (e)
        return e;
    const ic = message.imageMessage?.caption;
    if (ic)
        return ic;
    const vc = message.videoMessage?.caption;
    if (vc)
        return vc;
    return null;
}
