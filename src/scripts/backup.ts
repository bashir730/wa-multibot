import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { logger } from '../utils/logger';

/* ==================================================
   GitHubBackup — پایداری روی دیسک موقتی (Render free)
   دیسک Render بعد از restart/deploy پاک می‌شود؛
   session واتساپ و دیتابیس هر چند دقیقه به یک
   ریپوی خصوصی GitHub به‌صورت tar.gz پشتیبان می‌شود
   و در startup بازیابی می‌گردد.

   env:
     GITHUB_BACKUP_TOKEN  (pat با دسترسی repo به ریپوی backup)
     GITHUB_BACKUP_REPO   (مثل "bashir730/otp-service-backup")
   ================================================== */

export interface BackupOptions {
  token: string;
  repo: string; // owner/name
}

const FILE_PATH = 'backup.tar.gz';

function tarCreate(outFile: string, dirs: string[]): void {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const args = ['czf', outFile];
  for (const d of dirs) args.push(d);
  execFileSync('tar', args, { cwd: process.cwd() });
}

function tarExtract(file: string): void {
  execFileSync('tar', ['xzf', file], { cwd: process.cwd() });
}

export class GitHubBackup {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: BackupOptions) {}

  static fromEnv(): GitHubBackup | null {
    const token = process.env.GITHUB_BACKUP_TOKEN;
    const repo = process.env.GITHUB_BACKUP_REPO;
    if (!token || !repo) return null;
    return new GitHubBackup({ token, repo });
  }

  private api(url: string, init?: RequestInit): Promise<Response> {
    return fetch(`https://api.github.com${url}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'wa-multibot-backup',
        ...(init?.headers ?? {})
      }
    });
  }

  /* ---------- restore در startup (اگر فایل‌ها نیستند) ---------- */
  async restoreIfEmpty(): Promise<boolean> {
    const sessionMissing = !fs.existsSync(path.join(process.cwd(), 'sessions'));
    const dbMissing = !fs.existsSync(path.join(process.cwd(), 'data/multibot.sqlite'));
    if (!sessionMissing && !dbMissing) return false;

    logger.info({ repo: this.opts.repo }, 'Restoring backup from GitHub (fresh disk detected)');
    try {
      const res = await this.api(`/repos/${this.opts.repo}/contents/${FILE_PATH}`, {
        headers: { Accept: 'application/vnd.github.raw' }
      });
      if (!res.ok) {
        if (res.status === 404) {
          logger.info('No backup found yet — starting fresh');
          return false;
        }
        logger.warn({ status: res.status }, 'Backup download failed');
        return false;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const tmp = path.join(osTmp(), 'multibot-restore.tar.gz');
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, buf);
      tarExtract(tmp);
      fs.unlinkSync(tmp);
      logger.info('Backup restored (session + database)');
      return true;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Backup restore failed — starting fresh');
      return false;
    }
  }

  /* ---------- پشتیبان‌گیری: auth/ + data/ ---------- */
  async backupNow(reason = 'auto'): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const dirs = ['sessions', 'data'].filter((d) => fs.existsSync(path.join(process.cwd(), d)));
      if (dirs.length === 0) return false;

      const tmp = path.join(osTmp(), 'multibot-backup.tar.gz');
      tarCreate(tmp, dirs);
      const content = fs.readFileSync(tmp).toString('base64');
      fs.unlinkSync(tmp);

      /* sha فایل فعلی برای update */
      const cur = await this.api(`/repos/${this.opts.repo}/contents/${FILE_PATH}`);
      const body: Record<string, unknown> = {
        message: `backup ${new Date().toISOString()} (${reason})`,
        content
      };
      if (cur.ok) {
        const meta = (await cur.json()) as { sha: string };
        body.sha = meta.sha;
      } else if (cur.status !== 404) {
        logger.warn({ status: cur.status }, 'Backup sha lookup failed');
        return false;
      }

      const put = await this.api(`/repos/${this.opts.repo}/contents/${FILE_PATH}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!put.ok) {
        logger.warn({ status: put.status }, 'Backup upload failed');
        return false;
      }
      logger.info({ reason, bytes: content.length }, 'Backup uploaded to GitHub');
      return true;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Backup failed');
      return false;
    } finally {
      this.running = false;
    }
  }

  /* ---------- زمان‌بندی دوره‌ای ---------- */
  start(intervalMs = 10 * 60 * 1000): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.backupNow('interval');
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function osTmp(): string {
  return path.join(require('os').tmpdir(), `wa-multibot-${process.pid}`);
}
