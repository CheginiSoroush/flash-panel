import { handleTelegramWebhook, removeTelegramBot, setupTelegramWebhook } from '@api/telegram';
import { getGlobals, setSettings, loadApiToken } from '@settings';
import { fallback } from './utils';

export async function handleTelegram(request: Request, env: Env): Promise<Response> {
    await setSettings(env);
    // v0.8.16 — توکن CF فقط برای دستورهای CF-API ربات lazy لود می‌شود
    // (وب‌هوک‌های تلگرام کم‌تعدادند؛ بار KV روی مسیرهای پرترافیک نمی‌افتد)
    await loadApiToken(env);
    const { pathname } = getGlobals();
    const path = pathname.split('/')[3];

    switch (path) {
        case 'setup':
            return setupTelegramWebhook(request, env);
        
        case 'remove':
            return removeTelegramBot(request, env);

        case 'webhook':
            return handleTelegramWebhook(request, env);

        default:
            return fallback(request);
    }
}