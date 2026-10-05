"use strict";
/* ==================================================
   Session Utils — تشخیص و اعتبارسنجی رشته سشن در چت
   مشتری بدون دستور، فقط رشته سشن را می‌فرستد.
   فرمت‌های پشتیبانی‌شده:
     1. JSON خام creds.json
     2. base64 همان JSON
     3. با پیشوند برچسب مثل "VeroBot!BASE64" یا "KnightBot!..."
   ================================================== */
Object.defineProperty(exports, "__esModule", { value: true });
exports.looksLikeSession = looksLikeSession;
exports.parseSessionString = parseSessionString;
exports.isValidCreds = isValidCreds;
exports.phoneFromCreds = phoneFromCreds;
/* آیا متن پیام شبیه رشته سشن است؟ (تشخیص قبل از parse) */
function looksLikeSession(text) {
    const t = text.trim();
    if (t.length < 120 || t.length > 300_000)
        return false;
    if (t.startsWith('{') && t.includes('"noiseKey"'))
        return true;
    /* base64 با فاصله/خط جدید + شاید پیشوند برچسب */
    return /^[A-Za-z0-9+/=\s!]{120,}$/.test(t);
}
/* رشته سشن را به آبجکت creds.json تبدیل می‌کند؛ نامعتبر بود null */
function parseSessionString(text) {
    let t = text.trim();
    /* پیشوند برچسب مثل "VeroBot!xxx" — بخش بعد از ! را می‌گیریم */
    const bang = t.indexOf('!');
    if (bang > 0 && bang < 40)
        t = t.slice(bang + 1);
    t = t.replace(/\s+/g, '');
    /* 1) JSON مستقیم */
    try {
        const j = JSON.parse(t);
        if (j && typeof j === 'object')
            return j;
    }
    catch { /* ادامه — base64 */ }
    /* 2) base64 */
    try {
        const decoded = Buffer.from(t, 'base64').toString('utf-8');
        const j = JSON.parse(decoded);
        if (j && typeof j === 'object')
            return j;
    }
    catch { /* نامعتبر */ }
    return null;
}
/* اعتبارسنجی ساختاری creds.json بیلز */
function isValidCreds(o) {
    if (!o || typeof o !== 'object')
        return false;
    const c = o;
    return (typeof c.me?.id === 'string' &&
        !!c.noiseKey &&
        !!c.advSecretKey);
}
/* شماره تلفن از creds */
function phoneFromCreds(o) {
    const id = o.me?.id;
    if (!id)
        return null;
    return id.split(':')[0].split('@')[0] ?? null;
}
