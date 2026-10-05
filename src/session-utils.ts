/* ==================================================
   Session Utils — تشخیص و اعتبارسنجی رشته سشن در چت
   مشتری بدون دستور، فقط رشته سشن را می‌فرستد.
   فرمت‌های پشتیبانی‌شده:
     1. JSON خام creds.json
     2. base64 همان JSON
     3. با پیشوند برچسب مثل "VeroBot!BASE64" یا "KnightBot!..."
   ================================================== */

/* آیا متن پیام شبیه رشته سشن است؟ (تشخیص قبل از parse) */
export function looksLikeSession(text: string): boolean {
  const t = text.trim();
  if (t.length < 120 || t.length > 300_000) return false;
  if (t.startsWith('{') && t.includes('"noiseKey"')) return true;
  /* base64 با فاصله/خط جدید + شاید پیشوند برچسب */
  return /^[A-Za-z0-9+/=\s!]{120,}$/.test(t);
}

/* رشته سشن را به آبجکت creds.json تبدیل می‌کند؛ نامعتبر بود null */
export function parseSessionString(text: string): Record<string, unknown> | null {
  let t = text.trim();

  /* پیشوند برچسب مثل "VeroBot!xxx" — بخش بعد از ! را می‌گیریم */
  const bang = t.indexOf('!');
  if (bang > 0 && bang < 40) t = t.slice(bang + 1);

  t = t.replace(/\s+/g, '');

  /* 1) JSON مستقیم */
  try {
    const j = JSON.parse(t);
    if (j && typeof j === 'object') return j as Record<string, unknown>;
  } catch { /* ادامه — base64 */ }

  /* 2) base64 */
  try {
    const decoded = Buffer.from(t, 'base64').toString('utf-8');
    const j = JSON.parse(decoded);
    if (j && typeof j === 'object') return j as Record<string, unknown>;
  } catch { /* نامعتبر */ }

  return null;
}

/* اعتبارسنجی ساختاری creds.json بیلز */
export function isValidCreds(o: unknown): boolean {
  if (!o || typeof o !== 'object') return false;
  const c = o as { me?: { id?: unknown }; noiseKey?: unknown; advSecretKey?: unknown };
  return (
    typeof c.me?.id === 'string' &&
    !!c.noiseKey &&
    !!c.advSecretKey
  );
}

/* شماره تلفن از creds */
export function phoneFromCreds(o: Record<string, unknown>): string | null {
  const id = (o.me as { id?: string } | undefined)?.id;
  if (!id) return null;
  return id.split(':')[0].split('@')[0] ?? null;
}
