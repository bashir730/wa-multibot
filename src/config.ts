import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default('production'),
  LOG_LEVEL: z.string().default('info'),
  /* کلید ادمین برای صفحات /qr و /session و /clients */
  ADMIN_KEY: z.string().min(16, 'ADMIN_KEY must be at least 16 chars'),
  /* پشتیبان GitHub (پایداری روی دیسک موقتی Render) */
  GITHUB_BACKUP_TOKEN: z.string().optional(),
  GITHUB_BACKUP_REPO: z.string().optional(),
  BACKUP_INTERVAL_MIN: z.coerce.number().default(10),
  /* حداکثر تعداد session مشتری همزمان (محدودیت رم) */
  MAX_CLIENTS: z.coerce.number().default(10)
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(): AppConfig {
  return schema.parse(process.env);
}
