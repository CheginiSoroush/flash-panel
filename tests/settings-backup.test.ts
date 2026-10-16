import { describe, expect, it } from 'vitest';
import {
    BACKUP_APP,
    BACKUP_KIND,
    buildSettingsBackup,
    mergeImportedSettings,
    parseImportedBot,
    parseImportedUsers,
    parseSettingsBackup,
    prepareImport,
    sanitizeImportedMain
} from '@api/settings-backup';
import { SUB_USERS_LIMIT, SubUser } from '@settings/sub-users';
import { KvSettings, MainSettings, TelegramBot } from '#types/settings';

// پیش‌فرض‌های حداقلی — تزریقی (ماژول به @settings وابسته نیست)
const defaults: KvSettings = {
    localDNS: '8.8.8.8',
    ports: [443],
    cleanIPs: ['example.com'],
    enableTFO: false,
    fragmentMode: 'custom',
    bestPingInterval: 30,
    customSubs: [],
    panelVersion: '9.9.9'
} as unknown as KvSettings;

const mainDefaults: Partial<MainSettings> = {
    vlUUID: '11111111-1111-4111-8111-111111111111',
    trPass: 'old-pass',
    securePath: 'old-path',
    proxyIPs: [],
    prefixes: []
};

const current: KvSettings = { ...defaults, localDNS: '1.1.1.1' } as KvSettings;

function makeUser(overrides: Partial<SubUser> = {}): SubUser {
    return {
        id: '22b0b7e8-8f2e-4c1a-9d3e-5a1b2c3d4e5f',
        name: 'John',
        createdAt: 1700000000000,
        active: true,
        ...overrides
    };
}

describe('settings backup — export', () => {
    it('metadata is complete and marked as secret-bearing', () => {
        const backup = buildSettingsBackup({
            settings: current,
            main: mainDefaults as MainSettings,
            subUsers: [makeUser()],
            telegramBot: { telegramBotToken: 't', telegramUserId: '1' },
            version: '0.4.0',
            now: new Date('2026-02-01T10:00:00Z')
        });

        expect(backup._meta.kind).toBe(BACKUP_KIND);
        expect(backup._meta.app).toBe(BACKUP_APP);
        expect(backup._meta.version).toBe('0.4.0');
        expect(backup._meta.exportedAt).toBe('2026-02-01T10:00:00.000Z');
        expect(backup._meta.includesSecrets).toBe(true);
        expect(backup._meta.excludes.length).toBeGreaterThan(0);
    });

    it('deep-clones — mutating sources after export does not affect the backup', () => {
        const settings: KvSettings = { ...current };
        const users = [makeUser()];
        const bot: TelegramBot = { telegramBotToken: 'tok', telegramUserId: '42' };

        const backup = buildSettingsBackup({
            settings, main: mainDefaults as MainSettings, subUsers: users, telegramBot: bot, version: '1'
        });

        settings.localDNS = 'mutated';
        users[0].name = 'mutated';
        bot.telegramBotToken = 'mutated';

        expect(backup.settings.localDNS).toBe('1.1.1.1');
        expect(backup.subUsers[0].name).toBe('John');
        expect(backup.telegramBot.telegramBotToken).toBe('tok');
    });

    it('null telegram bot becomes an empty bot object (stable shape)', () => {
        const backup = buildSettingsBackup({
            settings: current,
            main: mainDefaults as MainSettings,
            subUsers: [],
            telegramBot: null,
            version: '1'
        });

        expect(backup.telegramBot).toEqual({ telegramBotToken: '', telegramUserId: '' });
    });
});

describe('settings backup — parse', () => {
    const validBackup = () => buildSettingsBackup({
        settings: current,
        main: mainDefaults as MainSettings,
        subUsers: [makeUser()],
        telegramBot: null,
        version: '0.4.0'
    });

    it('accepts a valid backup', () => {
        const parsed = parseSettingsBackup(validBackup());
        expect(parsed).not.toBeNull();
        expect(parsed!.settings.localDNS).toBe('1.1.1.1');
    });

    it('rejects non-objects, arrays and foreign formats', () => {
        expect(parseSettingsBackup(null)).toBeNull();
        expect(parseSettingsBackup('str')).toBeNull();
        expect(parseSettingsBackup([1, 2])).toBeNull();
        expect(parseSettingsBackup({ settings: {} })).toBeNull();

        const foreign = { ...validBackup(), _meta: { ...validBackup()._meta, kind: 'other-panel-backup' } };
        expect(parseSettingsBackup(foreign)).toBeNull();

        const wrongApp = { ...validBackup(), _meta: { ...validBackup()._meta, app: 'other-app' } };
        expect(parseSettingsBackup(wrongApp)).toBeNull();
    });

    it('rejects backup without settings section', () => {
        const { settings, ...rest } = validBackup() as any;
        expect(parseSettingsBackup(rest)).toBeNull();
    });

    it('tolerates missing main/subUsers/telegramBot sections', () => {
        const backup = validBackup();
        const minimal = parseSettingsBackup({ _meta: backup._meta, settings: backup.settings });
        expect(minimal).not.toBeNull();
        expect(minimal!.main).toEqual({});
        expect(minimal!.subUsers).toBeUndefined();
    });
});

describe('settings backup — merge', () => {
    it('imports known keys and counts them', () => {
        const { merged, imported, skipped } = mergeImportedSettings(
            current,
            { localDNS: '9.9.9.9', bestPingInterval: 60 },
            defaults
        );

        expect(merged.localDNS).toBe('9.9.9.9');
        expect(merged.bestPingInterval).toBe(60);
        expect(imported).toBe(2);
        expect(skipped).toEqual([]);
    });

    it('skips unknown keys, managed keys and type-mismatched values', () => {
        const { merged, imported, skipped } = mergeImportedSettings(
            current,
            {
                evilKey: 'x',
                panelVersion: '0.0.1',
                ports: '443',           // string به‌جای array
                enableTFO: 'yes',       // string به‌جای boolean
                cleanIPs: null,
                localDNS: '8.8.4.4'     // تنها مقدار سالم
            },
            defaults
        );

        expect(imported).toBe(1);
        expect(skipped).toEqual(['evilKey', 'panelVersion', 'ports', 'enableTFO', 'cleanIPs']);
        expect(merged.ports).toEqual([443]);
        expect(merged.enableTFO).toBe(false);
        expect(merged.panelVersion).toBe('9.9.9');
        expect(merged.localDNS).toBe('8.8.4.4');
    });

    it('keeps current values for keys missing from the backup', () => {
        const { merged, imported } = mergeImportedSettings(current, { ports: [8443] }, defaults);
        expect(imported).toBe(1);
        expect(merged.ports).toEqual([8443]);
        expect(merged.localDNS).toBe('1.1.1.1');
    });

    it('accepts arrays and nested objects matching the reference shape', () => {
        const nestedDefaults = { remoteDnsHost: { isDomain: false, host: '', ipv4: [], ipv6: [] } } as unknown as KvSettings;
        const { merged, imported, skipped } = mergeImportedSettings(
            nestedDefaults,
            { remoteDnsHost: { isDomain: true, host: 'dns.example', ipv4: ['1.2.3.4'], ipv6: [] } },
            nestedDefaults
        );

        expect(imported).toBe(1);
        expect(skipped).toEqual([]);
        expect((merged as any).remoteDnsHost.host).toBe('dns.example');
    });

    it('deep-clones imported values', () => {
        const incoming = { cleanIPs: ['a.com'] };
        const { merged } = mergeImportedSettings(current, incoming, defaults);
        incoming.cleanIPs.push('b.com');
        expect(merged.cleanIPs).toEqual(['a.com']);
    });
});

describe('settings backup — imported main settings', () => {
    it('keeps only known fields with right types', () => {
        const main = sanitizeImportedMain({
            vlUUID: 'aaaaaaaabbbb4ccc8ddd000000000000'.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'),
            trPass: 'new-pass',
            securePath: 'new-path',
            proxyIPs: ['1.2.3.4', 'b.com'],
            prefixes: ['[2602:fc59:b0:64::]'],
            fallback: 'fallback.com:443',
            dohUrl: 'https://dns.google/dns-query',
            accID: 'leak?',       // ناشناخته — باید حذف شود
            apiToken: 'leak?',    // ناشناخته — باید حذف شود
            proxyIpMode: 123      // تایپ غلط — حذف
        } as any);

        expect(main.vlUUID).toContain('-');
        expect(main.trPass).toBe('new-pass');
        expect(main.securePath).toBe('new-path');
        expect(main.proxyIPs).toEqual(['1.2.3.4', 'b.com']);
        expect(main.prefixes).toEqual(['[2602:fc59:b0:64::]']);
        expect(main.fallback).toBe('fallback.com:443');
        expect(main.dohUrl).toBe('https://dns.google/dns-query');
        expect((main as any).accID).toBeUndefined();
        expect((main as any).apiToken).toBeUndefined();
        expect((main as any).proxyIpMode).toBeUndefined();
    });

    it('drops non-string-array proxyIPs', () => {
        const main = sanitizeImportedMain({ proxyIPs: [1, 2] } as any);
        expect(main.proxyIPs).toBeUndefined();
    });
});

describe('settings backup — imported users', () => {
    it('undefined section → null (list untouched)', () => {
        expect(parseImportedUsers(undefined)).toBeNull();
    });

    it('non-array section → empty list', () => {
        expect(parseImportedUsers('nope')).toEqual({ users: [], skipped: 0 });
    });

    it('keeps valid users, drops broken ones and reports the count', () => {
        const raw = [
            makeUser({ name: 'Alice' }),
            { id: 'not-a-uuid', name: 'Bad' },
            makeUser({ name: '   ' }),          // نام خالی بعد از trim
            null,
            makeUser({ id: makeUser().id, name: 'Bob' })
        ];

        const { users, skipped } = parseImportedUsers(raw)!;
        expect(users.map(u => u.name)).toEqual(['Alice', 'Bob']);
        expect(skipped).toBe(3);
    });

    it('sanitizes optional fields — active defaults true, chat/count/time validated', () => {
        const { users } = parseImportedUsers([
            makeUser({
                active: false,
                telegramChatId: 123456789 as any,
                fetchCount: 7.9 as any,
                lastFetchedAt: 1700000001000
            })
        ])!;

        const user = users[0];
        expect(user.active).toBe(false);
        expect(user.telegramChatId).toBe('123456789');
        expect(user.fetchCount).toBe(7);
        expect(user.lastFetchedAt).toBe(1700000001000);
    });

    it('invalid chat id drops the field, invalid createdAt falls back to now', () => {
        const before = Date.now();
        const { users } = parseImportedUsers([
            makeUser({ telegramChatId: '12' as any, createdAt: -5 as any })
        ])!;

        expect(users[0].telegramChatId).toBeUndefined();
        expect(users[0].createdAt).toBeGreaterThanOrEqual(before);
    });

    it(`enforces the hard limit of ${SUB_USERS_LIMIT} users`, () => {
        const raw = Array.from({ length: SUB_USERS_LIMIT + 25 }, (_, i) =>
            makeUser({ id: `22b0b7e8-8f2e-4c1a-9d3e-${String(i).padStart(12, '0')}`, name: `U${i}` })
        );

        const { users, skipped } = parseImportedUsers(raw)!;
        expect(users.length).toBe(SUB_USERS_LIMIT);
        expect(skipped).toBe(25);
    });
});

describe('settings backup — imported telegram bot', () => {
    it('accepts a bot with at least one filled field', () => {
        expect(parseImportedBot({ telegramBotToken: 'tok', telegramUserId: '' })).toEqual({
            telegramBotToken: 'tok',
            telegramUserId: ''
        });
        expect(parseImportedBot({ telegramBotToken: '', telegramUserId: '555' })).toEqual({
            telegramBotToken: '',
            telegramUserId: '555'
        });
    });

    it('rejects wrong shapes and fully-empty bots', () => {
        expect(parseImportedBot(null)).toBeNull();
        expect(parseImportedBot('bot')).toBeNull();
        expect(parseImportedBot({ telegramBotToken: 1, telegramUserId: '' })).toBeNull();
        expect(parseImportedBot({ telegramBotToken: '', telegramUserId: '' })).toBeNull();
    });
});

describe('settings backup — prepareImport (integration)', () => {
    it('combines settings merge, main sanitize, users and bot', () => {
        const backup = buildSettingsBackup({
            settings: { ...current, localDNS: '9.9.9.9', ports: [2053] },
            main: { ...mainDefaults, trPass: 'restored-pass' } as MainSettings,
            subUsers: [makeUser({ name: 'Restored' })],
            telegramBot: { telegramBotToken: 'tok', telegramUserId: '7' },
            version: '0.4.0'
        });

        const parsed = parseSettingsBackup(JSON.parse(JSON.stringify(backup)))!;
        const prepared = prepareImport(parsed, current, defaults);

        expect(prepared.settings.localDNS).toBe('9.9.9.9');
        expect(prepared.settings.ports).toEqual([2053]);
        expect(prepared.settings.trPass).toBe('restored-pass');
        expect(prepared.importedFields).toBeGreaterThanOrEqual(2);
        expect(prepared.users!.users[0].name).toBe('Restored');
        expect(prepared.bot!.telegramBotToken).toBe('tok');
    });

    it('settings round-trip survives JSON serialization', () => {
        const backup = buildSettingsBackup({
            settings: current,
            main: mainDefaults as MainSettings,
            subUsers: [makeUser()],
            telegramBot: null,
            version: '0.4.0'
        });

        const roundTrip = JSON.parse(JSON.stringify(backup));
        const prepared = prepareImport(parseSettingsBackup(roundTrip)!, current, defaults);
        expect(prepared.settings.localDNS).toBe('1.1.1.1');
    });
});
