import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// هم‌راستا با paths در tsconfig.json — تا تست‌ها هم بتوانند از alias ها استفاده کنند
// فرم regex: دقیق و بدون تداخل پیشوند (مثل @auth در برابر @auth/*)
export default defineConfig({
    resolve: {
        alias: [
            { find: /^@auth$/, replacement: r('./src/auth/auth') },
            { find: /^@auth\/(.*)$/, replacement: r('./src/auth/$1') },
            { find: /^@settings$/, replacement: r('./src/settings/settings') },
            { find: /^@settings\/(.*)$/, replacement: r('./src/settings/$1') },
            { find: /^@kv$/, replacement: r('./src/settings/kv') },
            { find: /^@main$/, replacement: r('./src/settings/main') },
            { find: /^@validators$/, replacement: r('./src/settings/validators') },
            { find: /^@utils$/, replacement: r('./src/cores/utils') },
            { find: /^@common$/, replacement: r('./src/common/common') },
            { find: /^@handlers\/(.*)$/, replacement: r('./src/handlers/$1') },
            { find: /^@api\/(.*)$/, replacement: r('./src/api/$1') },
            { find: /^@protocols\/(.*)$/, replacement: r('./src/protocols/$1') },
            { find: /^@xray\/(.*)$/, replacement: r('./src/cores/xray/$1') },
            { find: /^@sing-box\/(.*)$/, replacement: r('./src/cores/sing-box/$1') },
            { find: /^@clash\/(.*)$/, replacement: r('./src/cores/clash/$1') },
            { find: /^@cores\/(.*)$/, replacement: r('./src/cores/$1') },
            { find: /^@workers$/, replacement: r('./src/workers') },
            { find: /^#types\/(.*)$/, replacement: r('./src/types/$1') }
        ]
    },
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts']
    }
});
