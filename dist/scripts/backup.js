"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubBackup = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const logger_1 = require("../utils/logger");
const FILE_PATH = 'backup.tar.gz';
function tarCreate(outFile, dirs) {
    fs_1.default.mkdirSync(path_1.default.dirname(outFile), { recursive: true });
    const args = ['czf', outFile];
    for (const d of dirs)
        args.push(d);
    (0, child_process_1.execFileSync)('tar', args, { cwd: process.cwd() });
}
function tarExtract(file) {
    (0, child_process_1.execFileSync)('tar', ['xzf', file], { cwd: process.cwd() });
}
class GitHubBackup {
    opts;
    timer = null;
    running = false;
    constructor(opts) {
        this.opts = opts;
    }
    static fromEnv() {
        const token = process.env.GITHUB_BACKUP_TOKEN;
        const repo = process.env.GITHUB_BACKUP_REPO;
        if (!token || !repo)
            return null;
        return new GitHubBackup({ token, repo });
    }
    api(url, init) {
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
    async restoreIfEmpty() {
        const sessionMissing = !fs_1.default.existsSync(path_1.default.join(process.cwd(), 'sessions'));
        const dbMissing = !fs_1.default.existsSync(path_1.default.join(process.cwd(), 'data/multibot.sqlite'));
        if (!sessionMissing && !dbMissing)
            return false;
        logger_1.logger.info({ repo: this.opts.repo }, 'Restoring backup from GitHub (fresh disk detected)');
        try {
            const res = await this.api(`/repos/${this.opts.repo}/contents/${FILE_PATH}`, {
                headers: { Accept: 'application/vnd.github.raw' }
            });
            if (!res.ok) {
                if (res.status === 404) {
                    logger_1.logger.info('No backup found yet — starting fresh');
                    return false;
                }
                logger_1.logger.warn({ status: res.status }, 'Backup download failed');
                return false;
            }
            const buf = Buffer.from(await res.arrayBuffer());
            const tmp = path_1.default.join(osTmp(), 'multibot-restore.tar.gz');
            fs_1.default.mkdirSync(path_1.default.dirname(tmp), { recursive: true });
            fs_1.default.writeFileSync(tmp, buf);
            tarExtract(tmp);
            fs_1.default.unlinkSync(tmp);
            logger_1.logger.info('Backup restored (session + database)');
            return true;
        }
        catch (err) {
            logger_1.logger.warn({ err: err.message }, 'Backup restore failed — starting fresh');
            return false;
        }
    }
    /* ---------- پشتیبان‌گیری: auth/ + data/ ---------- */
    async backupNow(reason = 'auto') {
        if (this.running)
            return false;
        this.running = true;
        try {
            const dirs = ['sessions', 'data'].filter((d) => fs_1.default.existsSync(path_1.default.join(process.cwd(), d)));
            if (dirs.length === 0)
                return false;
            const tmp = path_1.default.join(osTmp(), 'multibot-backup.tar.gz');
            tarCreate(tmp, dirs);
            const content = fs_1.default.readFileSync(tmp).toString('base64');
            fs_1.default.unlinkSync(tmp);
            /* sha فایل فعلی برای update */
            const cur = await this.api(`/repos/${this.opts.repo}/contents/${FILE_PATH}`);
            const body = {
                message: `backup ${new Date().toISOString()} (${reason})`,
                content
            };
            if (cur.ok) {
                const meta = (await cur.json());
                body.sha = meta.sha;
            }
            else if (cur.status !== 404) {
                logger_1.logger.warn({ status: cur.status }, 'Backup sha lookup failed');
                return false;
            }
            const put = await this.api(`/repos/${this.opts.repo}/contents/${FILE_PATH}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!put.ok) {
                logger_1.logger.warn({ status: put.status }, 'Backup upload failed');
                return false;
            }
            logger_1.logger.info({ reason, bytes: content.length }, 'Backup uploaded to GitHub');
            return true;
        }
        catch (err) {
            logger_1.logger.warn({ err: err.message }, 'Backup failed');
            return false;
        }
        finally {
            this.running = false;
        }
    }
    /* ---------- زمان‌بندی دوره‌ای ---------- */
    start(intervalMs = 10 * 60 * 1000) {
        this.stop();
        this.timer = setInterval(() => {
            void this.backupNow('interval');
        }, intervalMs);
        this.timer.unref();
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
exports.GitHubBackup = GitHubBackup;
function osTmp() {
    return path_1.default.join(require('os').tmpdir(), `wa-multibot-${process.pid}`);
}
