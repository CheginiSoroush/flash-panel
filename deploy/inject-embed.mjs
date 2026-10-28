#!/usr/bin/env node
/**
 * تزریق EMBEDED_SETTINGS به باندل پنل — مرحله‌ی بین build و deploy.
 *
 * چرا لازم است؟
 *   build خروجی با تنظیمات پیش‌فرض می‌سازد (repo عمومی است و نباید هویت
 *   داخل سورس باشد). هویت واقعی پنل (securePath / vlUUID / trPass / mainDomain
 *   / accID / fallback) فقط از secret مربوط به CI می‌آید و همین‌جا به ابتدای
 *   باندل prepend می‌شود — دقیقاً همان کاری که ابزار rescue و موتور self-update
 *   خود پنل انجام می‌دهند.
 *
 * fail-closed:
 *   - PANEL_EMBED_JSON نباشد → خطا و خروج non-zero (هرگز با تنظیمات پیش‌فرض
 *     روی ورکر زنده دیپلوی نکن — هویت پنل پاک می‌شود!)
 *   - کلیدهای اجباری نباشد → خطا
 *   - apiToken غیر خالی → خطا (سیاست v0.8.12+: هیچ اعتبارنامه‌ای در آرتیفکت)
 */
import { readFileSync, writeFileSync } from 'node:fs';

const REQUIRED_KEYS = ['accID', 'vlUUID', 'trPass', 'securePath', 'mainDomain'];

const raw = process.env.PANEL_EMBED_JSON;
if (!raw || !raw.trim()) {
    console.error('❌ PANEL_EMBED_JSON is empty — refusing to deploy defaults over the live panel identity.');
    process.exit(1);
}

let embed;
try {
    embed = JSON.parse(raw);
} catch (e) {
    console.error('❌ PANEL_EMBED_JSON is not valid JSON:', e.message);
    process.exit(1);
}

const missing = REQUIRED_KEYS.filter((k) => !embed[k]);
if (missing.length) {
    console.error('❌ PANEL_EMBED_JSON missing required keys:', missing.join(', '));
    process.exit(1);
}

if (embed.apiToken && embed.apiToken !== '') {
    console.error('❌ PANEL_EMBED_JSON contains a non-empty apiToken — credentials must never ship in the artifact (v0.8.12+ policy). Token lives in KV (cfApiToken).');
    process.exit(1);
}

const dist = readFileSync('dist/worker.js', 'utf8');
const header =
    `// Flash Panel ci-deploy ${new Date().toISOString()}\n` +
    '// @ts-nocheck\n' +
    `Object.assign(globalThis, {"EMBEDED_SETTINGS":${JSON.stringify(embed)}});\n`;

writeFileSync('dist/worker-deploy.js', header + dist);
console.log(`✅ EMBEDED_SETTINGS injected (securePath=${embed.securePath.slice(0, 3)}***, mainDomain=${embed.mainDomain}) → dist/worker-deploy.js (${header.length + dist.length} bytes)`);
