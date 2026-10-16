import { describe, it, expect, vi } from 'vitest';
import {
    BroadcastRecipient,
    BroadcastUser,
    BROADCAST_BATCH_DELAY_MS,
    BROADCAST_BATCH_SIZE,
    buildBroadcastConfirmText,
    buildUserDetailText,
    buildUsersOverviewText,
    chunkBroadcastBatches,
    escapeHtml,
    paginateUsers,
    personalizeBroadcastText,
    relativeTime,
    resolveBroadcastRecipients,
    sendBroadcast,
    USERS_PER_PAGE
} from '../src/api/telegram-broadcast';

// ---------- داده‌ی نمونه ----------

function makeUser(overrides: Partial<BroadcastUser> = {}): BroadcastUser {
    return {
        id: crypto.randomUUID(),
        name: 'John',
        active: true,
        ...overrides
    };
}

// ---------- escapeHtml ----------

describe('escapeHtml', () => {
    it('escapes &, < and > for Telegram HTML parse mode', () => {
        expect(escapeHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
    });

    it('leaves safe strings untouched', () => {
        expect(escapeHtml('Ali — موبایل 123')).toBe('Ali — موبایل 123');
    });
});

// ---------- resolveBroadcastRecipients ----------

describe('resolveBroadcastRecipients', () => {
    it('includes the admin first, then only active Telegram-linked users', () => {
        const linked = makeUser({ telegramChatId: '222' });
        const unlinked = makeUser({ telegramChatId: undefined });
        const revoked = makeUser({ active: false, telegramChatId: '333' });

        const recipients = resolveBroadcastRecipients([linked, unlinked, revoked], '111', () => 'L');

        expect(recipients).toHaveLength(2);
        expect(recipients[0]).toMatchObject({ chatId: '111', name: 'Admin', link: 'L', uuid: '' });
        expect(recipients[1]).toMatchObject({ chatId: '222', name: 'John', link: 'L', uuid: linked.id });
    });

    it('builds the personal link per user via the callback', () => {
        const a = makeUser({ telegramChatId: '1' });
        const b = makeUser({ name: 'Bob', telegramChatId: '2' });

        const recipients = resolveBroadcastRecipients([a, b], '9', (id) => `sub/${id}`);

        expect(recipients[1].link).toBe(`sub/${a.id}`);
        expect(recipients[2].link).toBe(`sub/${b.id}`);
        expect(recipients[0].link).toBe('sub/'); // ادمین — بدون userId
    });

    it('deduplicates by chatId (admin who is also a linked user gets one message)', () => {
        const self = makeUser({ telegramChatId: '111' });

        const recipients = resolveBroadcastRecipients([self], '111', () => 'L');

        expect(recipients).toHaveLength(1);
        expect(recipients[0].name).toBe('Admin');
    });

    it('returns only the admin when no user is linked', () => {
        const recipients = resolveBroadcastRecipients([makeUser()], '777', () => 'L');
        expect(recipients).toHaveLength(1);
        expect(recipients[0].chatId).toBe('777');
    });

    it('handles an empty admin chat id gracefully', () => {
        const recipients = resolveBroadcastRecipients([], '', () => 'L');
        expect(recipients).toHaveLength(0);
    });
});

// ---------- personalizeBroadcastText ----------

describe('personalizeBroadcastText', () => {
    const vars = { name: 'Ali', link: 'https://x/sub/a', uuid: 'u-123' };

    it('replaces all supported placeholders', () => {
        const text = 'Hi {name}! Your link: {link} (id: {uuid})';
        expect(personalizeBroadcastText(text, vars))
            .toBe('Hi Ali! Your link: https://x/sub/a (id: u-123)');
    });

    it('replaces repeated placeholders', () => {
        expect(personalizeBroadcastText('{name} — {name}', vars)).toBe('Ali — Ali');
    });

    it('leaves unknown tokens intact', () => {
        expect(personalizeBroadcastText('Hi {NAME} {email} {name}', vars)).toBe('Hi {NAME} {email} Ali');
    });

    it('returns the text unchanged when no placeholder exists', () => {
        expect(personalizeBroadcastText('Maintenance tonight!', vars)).toBe('Maintenance tonight!');
    });
});

// ---------- chunkBroadcastBatches ----------

describe('chunkBroadcastBatches', () => {
    it('splits into batches of the default size', () => {
        const items = Array.from({ length: 25 }, (_, i) => i);
        const batches = chunkBroadcastBatches(items);

        expect(batches).toHaveLength(3);
        expect(batches[0]).toHaveLength(BROADCAST_BATCH_SIZE);
        expect(batches[1]).toHaveLength(BROADCAST_BATCH_SIZE);
        expect(batches[2]).toHaveLength(5);
        expect(batches.flat()).toEqual(items);
    });

    it('returns one batch for small inputs and empty for none', () => {
        expect(chunkBroadcastBatches([1, 2])).toEqual([[1, 2]]);
        expect(chunkBroadcastBatches([])).toEqual([]);
    });

    it('guards against a zero/negative size', () => {
        expect(chunkBroadcastBatches([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    });
});

// ---------- relativeTime ----------

describe('relativeTime', () => {
    const now = 1_700_000_000_000;

    it('formats the granularities correctly', () => {
        expect(relativeTime(now - 30_000, now)).toBe('just now');
        expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
        expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
        expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
    });

    it('falls back to an ISO date for very old timestamps', () => {
        expect(relativeTime(now - 60 * 86_400_000, now)).toBe(new Date(now - 60 * 86_400_000).toISOString().slice(0, 10));
    });

    it('returns — for invalid, zero and future timestamps', () => {
        expect(relativeTime(undefined, now)).toBe('—');
        expect(relativeTime(0, now)).toBe('—');
        expect(relativeTime(Number.NaN, now)).toBe('—');
        expect(relativeTime(now + 1000, now)).toBe('—');
    });
});

// ---------- paginateUsers ----------

describe('paginateUsers', () => {
    it('slices the requested page and clamps out-of-range pages', () => {
        const items = Array.from({ length: 12 }, (_, i) => i);

        const first = paginateUsers(items, 1);
        expect(first.slice).toHaveLength(USERS_PER_PAGE);
        expect(first.totalPages).toBe(3);

        const last = paginateUsers(items, 99);
        expect(last.page).toBe(3);
        expect(last.slice).toHaveLength(2);

        const zero = paginateUsers(items, 0);
        expect(zero.page).toBe(1);
    });

    it('always returns at least one page even for empty input', () => {
        expect(paginateUsers([], 1)).toEqual({ slice: [], page: 1, totalPages: 1 });
    });
});

// ---------- متن‌های UI ----------

describe('buildUsersOverviewText', () => {
    it('summarizes counts, fetch totals and 24h activity', () => {
        const now = Date.now();
        const users = [
            makeUser({ fetchCount: 10, lastFetchedAt: now - 3_600_000, telegramChatId: '1' }),
            makeUser({ name: 'Bob', fetchCount: 3, lastFetchedAt: now - 90 * 86_400_000 }),
            makeUser({ name: 'Revoked', active: false, fetchCount: 2 })
        ];

        const text = buildUsersOverviewText(users, now);

        expect(text).toContain('Total: <b>3</b>');
        expect(text).toContain('Active: <b>2</b>');
        expect(text).toContain('Revoked: <b>1</b>');
        expect(text).toContain('Telegram-linked: <b>1</b>');
        expect(text).toContain('Fetches recorded: <b>15</b>');
        expect(text).toContain('Active in 24h: <b>1</b>');
        expect(text).toContain('Most active');
        expect(text).toContain('John — 10');
    });

    it('skips the most-active section when nobody has fetches', () => {
        const text = buildUsersOverviewText([makeUser()]);
        expect(text).not.toContain('Most active');
    });

    it('escapes user names in HTML', () => {
        const text = buildUsersOverviewText([makeUser({ name: '<b>Evil</b>', fetchCount: 5 })]);
        expect(text).not.toContain('<b>Evil</b> —');
        expect(text).toContain('&lt;b&gt;Evil&lt;/b&gt;');
    });
});

describe('buildUserDetailText', () => {
    it('shows status, fetches, last fetch and chat link state', () => {
        const now = Date.now();
        const user = makeUser({ fetchCount: 7, lastFetchedAt: now - 5 * 60_000, telegramChatId: '999' });

        const text = buildUserDetailText(user, now);
        expect(text).toContain('🟢 Active');
        expect(text).toContain('Recorded fetches: <b>7</b>');
        expect(text).toContain('5m ago');
        expect(text).toContain('<code>999</code>');
    });

    it('marks revoked users and missing chats', () => {
        const text = buildUserDetailText(makeUser({ active: false }), Date.now());
        expect(text).toContain('🔴 Revoked');
        expect(text).toContain('— not linked —');
    });
});

describe('buildBroadcastConfirmText', () => {
    it('reports personalization when placeholders exist', () => {
        const text = buildBroadcastConfirmText('Hi {name}, link: {link}', 5, { name: 'X', link: 'L', uuid: '' });
        expect(text).toContain('Recipients: <b>5</b>');
        expect(text).toContain('personalized per user');
        expect(text).toContain('Hi X, link: L');
    });

    it('notes a plain broadcast without placeholders', () => {
        const text = buildBroadcastConfirmText('Maintenance!', 2, { name: 'X', link: 'L', uuid: '' });
        expect(text).toContain('Same message for everyone');
    });

    it('escapes the preview so HTML markup cannot break the message', () => {
        const text = buildBroadcastConfirmText('<img src=x onerror=alert(1)>', 1, { name: 'X', link: 'L', uuid: '' });
        expect(text).toContain('&lt;img');
        expect(text).not.toContain('<img');
    });
});

// ---------- sendBroadcast ----------

describe('sendBroadcast', () => {
    function makeRecipients(n: number): BroadcastRecipient[] {
        return Array.from({ length: n }, (_, i) => ({
            chatId: String(i + 1),
            name: `User ${i + 1}`,
            link: `https://x/${i + 1}`,
            uuid: `u${i + 1}`
        }));
    }

    it('personalizes the template per recipient and reports full success', async () => {
        const sent: { chatId: string; text: string }[] = [];
        const sender = vi.fn(async (chatId: string, text: string) => {
            sent.push({ chatId, text });
            return true;
        });

        const result = await sendBroadcast(
            makeRecipients(3),
            'Hello {name}, your link: {link}',
            sender
        );

        expect(result).toEqual({ sent: 3, failed: 0, failedChats: [] });
        expect(sender).toHaveBeenCalledTimes(3);
        expect(sent[0].text).toBe('Hello User 1, your link: https://x/1');
        expect(sent[2].chatId).toBe('3');
    });

    it('counts failures independently and keeps delivering to the rest', async () => {
        const sender = vi.fn(async (chatId: string) => chatId !== '2');

        const result = await sendBroadcast(makeRecipients(4), 'plain', sender);

        expect(result.sent).toBe(3);
        expect(result.failed).toBe(1);
        expect(result.failedChats).toEqual(['2']);
        expect(sender).toHaveBeenCalledTimes(4); // شکست جریان را متوقف نمی‌کند
    });

    it('treats sender exceptions as a per-recipient failure', async () => {
        const sender = vi.fn(async (chatId: string) => {
            if (chatId === '1') throw new Error('network down');
            return true;
        });

        const result = await sendBroadcast(makeRecipients(2), 'plain', sender);

        expect(result.sent).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.failedChats).toEqual(['1']);
    });

    it('respects the batch size and pauses between batches', async () => {
        vi.useFakeTimers();
        try {
            const sender = vi.fn(async () => true);
            const recipients = makeRecipients(BROADCAST_BATCH_SIZE + 3); // ۲ بچ

            const promise = sendBroadcast(recipients, 'x', sender);

            // بچ اول بلافاصله اجرا شده
            await vi.advanceTimersByTimeAsync(0);
            expect(sender).toHaveBeenCalledTimes(BROADCAST_BATCH_SIZE);

            // بچ دوم بعد از مکث بین بچ‌ها
            await vi.advanceTimersByTimeAsync(BROADCAST_BATCH_DELAY_MS);
            await promise;

            expect(sender).toHaveBeenCalledTimes(BROADCAST_BATCH_SIZE + 3);
        } finally {
            vi.useRealTimers();
        }
    });
});
