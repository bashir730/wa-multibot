import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  type WASocket,
  type WAMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { logger, silentLogger } from '../utils/logger';
import { DB } from '../db';
import { SessionManager } from './session-manager';
import { looksLikeSession, parseSessionString, isValidCreds } from '../session-utils';

/* ==================================================
   BotCore — ربات مرکزی
   فقط پیام‌های چت خصوصی را می‌خواند و به مشتری‌ها
   جواب می‌دهد. QR فقط از طریق صفحه وب /qr در دسترس است
   و هرگز در لاگ چاپ نمی‌شود.
   ================================================== */

export type BotState = 'disconnected' | 'connecting' | 'connected' | 'logged_out';

const HELP = `🤖 *wa-multibot*

این ربات روی اکانت *خودت* دستور اجرا می‌کند.

*نحوه اتصال:*
رشته سشن واتساپ‌ات را که از سایت گرفتی، همینجا بفرست (بدون هیچ دستوری) تا وصلت کنم.

*دستورها:*
1. *منو* — همین راهنما
2. *وضعیت* — وضعیت اتصال اکانت تو
3. *ارسال شماره متن* — از اکانت خودت پیام می‌فرستد، مثال: ارسال +93712345678 سلام
4. *قطع* — قطع‌کردن اکانت از ربات`;

export class BotCore {
  public state: BotState = 'disconnected';
  public phone: string | null = null;
  public startedAt = Date.now();

  private lastQr: string | null = null;
  private lastQrPng: string | null = null; /* data-url برای صفحه /qr */
  private sock: WASocket | null = null;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly sessionDir: string;

  constructor(
    private readonly db: DB,
    private readonly mgr: SessionManager,
    private readonly onClientConnected: () => void
  ) {
    this.sessionDir = path.resolve(process.cwd(), 'sessions', '__bot');
  }

  /* ---------- state صفحات وب ---------- */
  getLastQrPng(): string | null {
    return this.lastQrPng;
  }
  getState(): BotState {
    return this.state;
  }
  getPhone(): string | null {
    return this.phone;
  }

  /* ورود ربات مرکزی با session (بدون QR) */
  async importSession(creds: unknown): Promise<{ phone: string | null }> {
    if (!isValidCreds(creds)) throw new Error('ساختار سشن نامعتبر است');
    await this.end();
    fs.rmSync(this.sessionDir, { recursive: true, force: true });
    fs.mkdirSync(this.sessionDir, { recursive: true });
    fs.writeFileSync(path.join(this.sessionDir, 'creds.json'), JSON.stringify(creds, null, 2));
    void this.connect();
    const phone = creds && typeof creds === 'object' ? (creds as { me?: { id?: string } }).me?.id?.split(':')[0].split('@')[0] ?? null : null;
    return { phone };
  }

  async connect(): Promise<void> {
    if (this.connecting || this.state === 'connected') return;
    this.connecting = true;
    this.state = 'connecting';

    try {
      fs.mkdirSync(this.sessionDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);

      let version: [number, number, number] | undefined;
      try {
        version = (await fetchLatestWaWebVersion({})).version;
      } catch { /* default */ }

      const sock = makeWASocket({
        version,
        logger: silentLogger,
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
          QRCode.toDataURL(qr)
            .then((url) => { this.lastQrPng = url; })
            .catch(() => { this.lastQrPng = null; });
          logger.info('Bot authentication required — scan QR on the /qr page');
        }

        if (connection === 'open') {
          this.connecting = false;
          this.lastQr = null;
          this.lastQrPng = null;
          this.state = 'connected';
          this.phone = String(sock.user?.id ?? '').split(':')[0].split('@')[0];
          logger.info({ phone: this.phone }, 'Central bot connected');
          this.onClientConnected();
        }

        if (connection === 'close') {
          const boom = lastDisconnect?.error ? new Boom(lastDisconnect.error) : null;
          const code = boom?.output?.statusCode;
          this.sock = null;
          this.connecting = false;

          if (code === DisconnectReason.loggedOut) {
            this.state = 'logged_out';
            logger.warn('Bot session logged out — cleared, new QR will be issued');
            try { fs.rmSync(this.sessionDir, { recursive: true, force: true }); } catch { /* ignore */ }
            this.scheduleReconnect(3000);
            return;
          }

          this.state = 'disconnected';
          this.phone = null;
          logger.warn({ code }, 'Central bot disconnected');
          this.scheduleReconnect();
        }
      });

      /* ---------- پیام‌های مشتری‌ها ---------- */
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const m of messages) {
          try { await this.handle(m); } catch (err) {
            logger.warn({ err: (err as Error).message }, 'message handler error');
          }
        }
      });
    } catch (err) {
      this.connecting = false;
      this.state = 'disconnected';
      logger.error({ err: (err as Error).message }, 'Bot connect failed');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.reconnectTimer) return;
    const delay = delayMs ?? 5000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  async end(): Promise<void> {
    if (this.sock) {
      try { await this.sock.end(undefined); } catch { /* ignore */ }
      this.sock = null;
    }
  }

  async reply(jid: string, text: string): Promise<void> {
    if (!this.sock || this.state !== 'connected') return;
    try {
      await this.sock.sendMessage(jid, { text });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'reply failed');
    }
  }

  /* ---------- منطق پیام ---------- */
  private async handle(m: WAMessage): Promise<void> {
    if (!m.message || m.key.fromMe) return;
    const jid = m.key.remoteJid ?? '';
    if (!jid.endsWith('@s.whatsapp.net')) return; /* فقط چت خصوصی */

    const text = extractText(m.message);
    if (!text) return;

    /* 1) رشته سشن؟ */
    if (looksLikeSession(text)) {
      await this.handleSession(jid, text);
      return;
    }

    /* 2) دستور */
    await this.handleCommand(jid, text.trim());
  }

  private async handleSession(jid: string, text: string): Promise<void> {
    const creds = parseSessionString(text);
    if (!creds || !isValidCreds(creds)) {
      await this.reply(jid, '❌ سشن نامعتبر است — رشته سشن کامل را از سایت بگیر و دوباره بفرست');
      return;
    }
    await this.reply(jid, '🔄 در حال بررسی و اتصال سشن... چند ثانیه صبر کن');
    try {
      const { phone } = await this.mgr.connectClient(jid, creds);
      this.onClientConnected();
      await this.reply(
        jid,
        `✅ *متصل شد!*\n\nشماره: +${phone}\nاز اینجا دستورها روی اکانت خودت اجرا می‌شود.\nبرای دیدن دستورها بفرست: *منو*`
      );
    } catch (err) {
      await this.reply(jid, `❌ ${(err as Error).message}`);
    }
  }

  private async handleCommand(jid: string, text: string): Promise<void> {
    const cmd = text.replace(/^[.!\/]+/, '').toLowerCase();
    const firstWord = cmd.split(/\s+/)[0];

    /* منو برای همه */
    if (['منو', 'menu', 'start', 'شروع', 'سلام', 'hi', 'hello', 'help'].includes(firstWord)) {
      await this.reply(jid, HELP);
      return;
    }

    const row = this.db.getByChat(jid);
    if (!row) {
      await this.reply(
        jid,
        'این ربات روی اکانت *خودت* دستور اجرا می‌کند.\n\nاول رشته سشن واتساپ‌ات را که از سایت گرفتی همینجا بفرست تا وصلت کنم. 🚀'
      );
      return;
    }

    /* اتصال دوباره خودکار اگر سشن روی دیسک هست ولی وصل نیست */
    if (!this.mgr.isConnected(jid) && fs.existsSync(path.join(this.mgr.dirFor(jid), 'creds.json'))) {
      await this.reply(jid, '🔄 اکانتت وصل نبود — در حال وصل‌کردن دوباره...');
      try {
        await this.mgr.connectClient(jid);
      } catch { /* پایین خطا می‌دهیم */ }
    }

    const sock = this.mgr.socketFor(jid);

    if (firstWord === 'وضعیت' || firstWord === 'status') {
      if (!sock) {
        await this.reply(jid, `❌ اکانت شما وصل نیست.\nسشن جدید از سایت بگیر و بفرست تا دوباره وصل کنم.`);
      } else {
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
      } catch (err) {
        await this.reply(jid, `❌ ارسال شکست خورد: ${(err as Error).message}`);
      }
      return;
    }

    await this.reply(jid, 'دستور شناخته نشد — *منو* بفرست.');
  }
}

function extractText(message: NonNullable<WAMessage['message']>): string | null {
  const c = message.conversation;
  if (c) return c;
  const e = (message as { extendedTextMessage?: { text?: string } }).extendedTextMessage?.text;
  if (e) return e;
  const ic = (message as { imageMessage?: { caption?: string } }).imageMessage?.caption;
  if (ic) return ic;
  const vc = (message as { videoMessage?: { caption?: string } }).videoMessage?.caption;
  if (vc) return vc;
  return null;
}
