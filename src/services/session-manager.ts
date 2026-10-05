import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  type WASocket
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import { logger, silentLogger } from '../utils/logger';
import { DB } from '../db';
import { isValidCreds, phoneFromCreds } from '../session-utils';

/* ==================================================
   SessionManager — یک instance بیلز جدا برای هر مشتری
   sessions/<chat_id>/  ← auth state هر مشتری
   ================================================== */

interface Entry {
  sock: WASocket;
  state: 'connecting' | 'connected';
  connectedAt: number;
}

export class SessionManager {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly db: DB,
    private readonly root = 'sessions',
    private readonly maxClients = 10
  ) {}

  dirFor(chatId: string): string {
    const safe = chatId.replace(/[^0-9@._-]/g, '_');
    return path.resolve(process.cwd(), this.root, safe);
  }

  stateFor(chatId: string): string {
    return this.entries.get(chatId)?.state ?? 'disconnected';
  }

  isConnected(chatId: string): boolean {
    return this.entries.get(chatId)?.state === 'connected';
  }

  socketFor(chatId: string): WASocket | null {
    const e = this.entries.get(chatId);
    return e && e.state === 'connected' ? e.sock : null;
  }

  connectedSince(chatId: string): number | null {
    const e = this.entries.get(chatId);
    return e && e.state === 'connected' ? e.connectedAt : null;
  }

  /**
   * اتصال session مشتری.
   * creds بدهد: اعتبارسنجی + جایگزینی + اتصال بدون QR.
   * creds ندهد: از auth state موجود روی دیسک وصل می‌شود.
   */
  async connectClient(chatId: string, creds?: unknown, timeoutMs = 30_000): Promise<{ phone: string }> {
    const dir = this.dirFor(chatId);

    if (creds) {
      if (!isValidCreds(creds)) throw new Error('ساختار سشن نامعتبر است — سشن کامل از سایت بگیر');
      if (!this.isConnected(chatId) && this.db.countConnected() >= this.maxClients) {
        throw new Error('ظرفیت ربات پر است — بعداً تلاش کن');
      }
      await this.endClient(chatId);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds, null, 2));
    } else {
      if (!fs.existsSync(path.join(dir, 'creds.json'))) {
        throw new Error('سشنی برای تو ذخیره نشده — اول رشته سشن را بفرست');
      }
      await this.endClient(chatId);
    }

    return this.spawn(chatId, timeoutMs);
  }

  /* ساخت socket و انتظار برای connection = open */
  private async spawn(chatId: string, timeoutMs: number): Promise<{ phone: string }> {
    const dir = this.dirFor(chatId);
    const { state, saveCreds } = await useMultiFileAuthState(dir);

    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestWaWebVersion({})).version;
    } catch { /* default */ }

    const sock = makeWASocket({
      version,
      logger: silentLogger,
      printQRInTerminal: false,
      auth: state,
      browser: ['wa-multibot', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    const entry: Entry = { sock, state: 'connecting', connectedAt: 0 };
    this.entries.set(chatId, entry);
    sock.ev.on('creds.update', saveCreds);

    return new Promise<{ phone: string }>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { sock.end(undefined); } catch { /* ignore */ }
        this.entries.delete(chatId);
        this.db.setStatus(chatId, 'invalid');
        reject(new Error('اتصال طول کشید — سشن احتمالاً نامعتبر یا منقضی است'));
      }, timeoutMs);

      sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect } = u;

        if (connection === 'open') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          entry.state = 'connected';
          entry.connectedAt = Date.now();
          const phone = String(sock.user?.id ?? '').split(':')[0].split('@')[0];
          this.db.upsertConnected(chatId, phone);
          logger.info({ chatId, phone }, 'Client session connected');
          /* رویدادهای pre-existing را فعال کن تا listeners بعد از resolve کار کنند */
          resolve({ phone });
          return;
        }

        if (connection === 'close') {
          const boom = lastDisconnect?.error ? new Boom(lastDisconnect.error) : null;
          const code = boom?.output?.statusCode;
          this.entries.delete(chatId);

          if (code === DisconnectReason.loggedOut) {
            /* سشن از سمت واتساپ حذف شده */
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
            this.db.setStatus(chatId, 'logged_out');
            logger.warn({ chatId }, 'Client session logged out — cleared');
          } else {
            this.db.setStatus(chatId, 'disconnected');
            logger.warn({ chatId, code }, 'Client session closed');
          }

          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(
              new Error(
                code === DisconnectReason.loggedOut
                  ? 'سشن از واتساپ حذف شده (logged out) — سشن جدید بگیر'
                  : 'اتصال برقرار نشد — سشن نامعتبر یا منقضی است'
              )
            );
          }
        }
      });
    });
  }

  /* وصل‌کردن دوباره همه مشتری‌های متصل قبلی (بعد از restart) */
  restoreAll(): void {
    for (const row of this.db.listConnected()) {
      if (fs.existsSync(path.join(this.dirFor(row.chat_id), 'creds.json'))) {
        this.connectClient(row.chat_id).catch(() => {});
      } else {
        this.db.setStatus(row.chat_id, 'disconnected');
      }
    }
  }

  async endClient(chatId: string): Promise<void> {
    const e = this.entries.get(chatId);
    if (e) {
      try { await e.sock.end(undefined); } catch { /* ignore */ }
      this.entries.delete(chatId);
    }
  }

  async endAll(): Promise<void> {
    for (const chatId of [...this.entries.keys()]) {
      await this.endClient(chatId);
    }
  }
}
