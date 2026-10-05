"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const config_1 = require("./config");
const logger_1 = require("./utils/logger");
const db_1 = require("./db");
const session_manager_1 = require("./services/session-manager");
const bot_core_1 = require("./services/bot-core");
const backup_1 = require("./scripts/backup");
const session_utils_1 = require("./session-utils");
/* ==================================================
   wa-multibot — Multi-Session WhatsApp Bot
   Render Web Service:
   1. سرویس اول live می‌شود (Express)
   2. بعد ربات مرکزی وصل می‌شود — QR فقط روی /qr
   3. سشن مشتری‌ها بعد از restart خودکار برمی‌گردند
   ================================================== */
async function main() {
    const config = (0, config_1.loadConfig)();
    /* ---------- بازیابی پشتیبان (دیسک موقتی) ---------- */
    const backup = backup_1.GitHubBackup.fromEnv();
    if (backup) {
        await backup.restoreIfEmpty();
        backup.start(config.BACKUP_INTERVAL_MIN * 60 * 1000);
    }
    /* ---------- سرویس‌ها ---------- */
    const db = new db_1.DB('data/multibot.sqlite');
    db.init();
    const mgr = new session_manager_1.SessionManager(db, 'sessions', config.MAX_CLIENTS);
    const bot = new bot_core_1.BotCore(db, mgr, () => {
        if (backup)
            void backup.backupNow('client-connected');
    });
    /* ---------- پشتیبان‌گیری بعد از اتصال ربات ---------- */
    /* (در callback های اتصال انجام می‌شود) */
    /* ---------- Express — اول live شود ---------- */
    const app = (0, express_1.default)();
    app.use(express_1.default.json({ limit: '2mb' }));
    const requireKey = (req, res, next) => {
        const key = req.query.key || req.get('x-admin-key');
        if (key !== config.ADMIN_KEY) {
            res.status(401).send('401');
            return;
        }
        next();
    };
    app.get('/health', (_req, res) => {
        res.json({
            status: bot.getState() === 'connected' ? 'ok' : 'degraded',
            bot: bot.getState(),
            botPhone: bot.getPhone(),
            clients: {
                connected: db.countConnected(),
                limit: config.MAX_CLIENTS
            },
            uptimeSec: Math.round((Date.now() - bot.startedAt) / 1000),
            time: new Date().toISOString()
        });
    });
    /* ---------- QR ربات مرکزی — فقط صفحه وب ---------- */
    app.get('/qr', requireKey, (_req, res) => {
        res.send(qrPage(bot));
    });
    /* ---------- ورود ربات مرکزی با session (بدون QR) ---------- */
    app.get('/session', requireKey, (_req, res) => {
        res.send(sessionPage());
    });
    app.post('/session', requireKey, async (req, res) => {
        const { session } = (req.body ?? {});
        if (!session || typeof session !== 'string' || session.length < 50) {
            res.status(400).json({ success: false, error: 'INVALID_SESSION', message: 'Session data missing or too short' });
            return;
        }
        const creds = (0, session_utils_1.parseSessionString)(session);
        if (!creds) {
            res.status(400).json({ success: false, error: 'INVALID_SESSION', message: 'Not valid base64/JSON' });
            return;
        }
        try {
            const { phone } = await bot.importSession(creds);
            res.json({ success: true, phone, message: 'Bot session imported — connecting' });
        }
        catch (err) {
            res.status(400).json({ success: false, error: 'INVALID_SESSION', message: err.message });
        }
    });
    /* ---------- لیست مشتری‌ها (ادمین) ---------- */
    app.get('/clients', requireKey, (_req, res) => {
        const rows = db.listAll().map((r) => ({
            chat_id: r.chat_id,
            phone: r.phone,
            dbStatus: r.status,
            liveState: mgr.stateFor(r.chat_id)
        }));
        res.json({ success: true, bot: bot.getState(), clients: rows });
    });
    const server = app.listen(config.PORT, () => {
        logger_1.logger.info({ port: config.PORT }, 'wa-multibot HTTP live');
    });
    /* ---------- اتصال ربات مرکزی — بعد از live شدن ---------- */
    void bot.connect();
    /* وصل‌کردن دوباره مشتری‌های قبلی */
    setTimeout(() => mgr.restoreAll(), 3000);
    /* ---------- graceful shutdown ---------- */
    const shutdown = async (sig) => {
        logger_1.logger.info({ sig }, 'Shutting down');
        if (backup)
            await backup.backupNow('shutdown');
        await mgr.endAll();
        await bot.end();
        db.close();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
/* ---------- HTML: صفحه QR ---------- */
function qrPage(bot) {
    const st = bot.getState();
    const png = bot.getLastQrPng();
    const body = st === 'connected'
        ? `<h2 style="color:#5ee39a">✅ ربات متصل است${bot.getPhone() ? ' — +' + bot.getPhone() : ''}</h2>`
        : png
            ? `<h2>📱 با شماره ربات اسکن کن</h2><p style="color:#8ea0c0;font-size:13px">WhatsApp ← Settings ← Linked Devices ← Link a Device</p><img src="${png}" style="width:280px;border-radius:16px">`
            : `<h2>⏳ در حال راه‌اندازی...</h2><p style="color:#8ea0c0;font-size:13px">اگر بعد از ~۱ دقیقه QR نیامد، صفحه را رفرش کن.</p>`;
    return `<!doctype html><html dir="rtl" lang="fa"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR ربات</title>
<meta http-equiv="refresh" content="${st === 'connected' ? '600' : '15'}">
<style>body{font-family:system-ui,Tahoma,sans-serif;background:#0b1220;color:#e8eefc;display:flex;justify-content:center;padding:24px}main{width:100%;max-width:420px;background:#131c30;border:1px solid #26314a;border-radius:20px;padding:28px;text-align:center}</style></head>
<body><main>${body}</main></body></html>`;
}
/* ---------- HTML: فرم ورود ربات با session ---------- */
function sessionPage() {
    return `<!doctype html><html dir="rtl" lang="fa"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ورود ربات با Session</title>
<style>body{font-family:system-ui,Tahoma,sans-serif;background:#0b1220;color:#e8eefc;display:flex;justify-content:center;padding:24px}main{width:100%;max-width:560px;background:#131c30;border:1px solid #26314a;border-radius:20px;padding:28px}h2{margin:0 0 8px}p{color:#8ea0c0;font-size:13px}textarea{width:100%;height:180px;background:#0b1220;color:#e8eefc;border:1px solid #2c3a57;border-radius:12px;padding:12px;font-size:13px;box-sizing:border-box}button{margin-top:12px;width:100%;background:linear-gradient(135deg,#4f7cff,#7c5cff);color:#fff;border:none;border-radius:12px;padding:14px;font-size:16px;font-weight:600;cursor:pointer}#r{margin-top:14px;padding:12px;border-radius:12px;font-size:14px;display:none;white-space:pre-wrap}</style></head>
<body><main><h2>🔑 ورود ربات مرکزی با Session</h2>
<p>اگر session شماره ربات را از سایت گرفتی، اینجا paste کن — بدون QR وصل می‌شود.</p>
<textarea id="t" placeholder='{"noiseKey":...} یا رشته base64'></textarea>
<button onclick="go()">ثبت و اتصال ربات</button>
<div id="r"></div>
<script>
async function go(){
  const v=document.getElementById('t').value.trim();
  const r=document.getElementById('r'); r.style.display='block';
  if(!v){r.style.background='#2b0d13';r.textContent='خالی است';return;}
  try{
    const key=new URLSearchParams(location.search).get('key');
    const res=await fetch(location.pathname+'?key='+encodeURIComponent(key),{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':key},body:JSON.stringify({session:v})});
    const d=await res.json();
    r.style.background=d.success?'#0d2b1e':'#2b0d13';
    r.textContent=d.success?('✅ سشن ربات ثبت شد — در حال اتصال...'):('❌ '+(d.message||d.error));
  }catch(e){r.style.background='#2b0d13';r.textContent='❌ '+e.message;}
}
</script></main></body></html>`;
}
main().catch((err) => {
    logger_1.logger.error({ err: err.message }, 'Fatal startup error');
    process.exit(1);
});
