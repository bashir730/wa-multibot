"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
require("dotenv/config");
const zod_1 = require("zod");
const schema = zod_1.z.object({
    PORT: zod_1.z.coerce.number().default(3000),
    NODE_ENV: zod_1.z.string().default('production'),
    LOG_LEVEL: zod_1.z.string().default('info'),
    /* کلید ادمین برای صفحات /qr و /session و /clients */
    ADMIN_KEY: zod_1.z.string().min(16, 'ADMIN_KEY must be at least 16 chars'),
    /* پشتیبان GitHub (پایداری روی دیسک موقتی Render) */
    GITHUB_BACKUP_TOKEN: zod_1.z.string().optional(),
    GITHUB_BACKUP_REPO: zod_1.z.string().optional(),
    BACKUP_INTERVAL_MIN: zod_1.z.coerce.number().default(10),
    /* حداکثر تعداد session مشتری همزمان (محدودیت رم) */
    MAX_CLIENTS: zod_1.z.coerce.number().default(10)
});
function loadConfig() {
    return schema.parse(process.env);
}
