import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname as pathDirname } from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { globSync } from 'glob';
import { minify as jsMinify } from 'terser';
import { minify as htmlMinify } from 'html-minifier';
import pkg from '../package.json' with { type: 'json' };
import { gzipSync } from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);

const ASSET_PATH = join(__dirname, '../src/assets');
const DIST_PATH = join(__dirname, '../dist/');
const WORKER_PATH = join(DIST_PATH, 'worker.js');
const FLASH_THEME_PATH = join(ASSET_PATH, 'flash-theme.css');

// سقف‌های Cloudflare (پس از فشرده‌سازی gzip): Free=3MB — Paid=10MB
const SIZE_LIMIT_FREE = 3 * 1024 * 1024;
const SIZE_LIMIT_PAID = 10 * 1024 * 1024;

const green = '\x1b[32m';
const yellow = '\x1b[33m';
const red = '\x1b[31m';
const reset = '\x1b[0m';

const success = `${green}✔${reset}`;
const warning = `${yellow}⚠${reset}`;
const failure = `${red}✗${reset}`;

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

async function processHtmlPages() {
    const indexFiles = globSync('**/index.html', { cwd: ASSET_PATH });
    const flashTheme = readFileSync(FLASH_THEME_PATH, 'utf8');
    const result = {};

    for (const relativeIndexPath of indexFiles) {
        const dir = pathDirname(relativeIndexPath);
        const base = (file) => join(ASSET_PATH, dir, file);

        const indexHtml = readFileSync(base('index.html'), 'utf8');
        let html = indexHtml.replaceAll('__VERSION__', pkg.version);

        if (dir !== 'error') {
            const css = readFileSync(base('style.css'), 'utf8');

            const script = readFileSync(base('script.js'), 'utf8');
            const { code } = await jsMinify(script);

            // CSS اصلی + تم Flash — تم بعد از CSS اصلی میاد تا override کنه
            html = html
                .replace('/* CSS_PLACEHOLDER */', () => css + '\n' + flashTheme)
                .replace('/* JS_PLACEHOLDER */', () => code);
        }

        const minifiedHtml = htmlMinify(html, {
            collapseWhitespace: true,
            removeAttributeQuotes: true,
            minifyCSS: true
        });

        const compressed = gzipSync(minifiedHtml, { level: 9 });
        result[dir] = compressed.toString('base64');
    }

    console.log(`${success} Assets bundled successfully!`);
    return result;
}

async function buildWorker() {
    const htmls = await processHtmlPages();
    const faviconBase64 = readFileSync(join(ASSET_PATH, 'favicon.ico')).toString('base64');

    const code = await build({
        entryPoints: [join(__dirname, '../src/worker.ts')],
        bundle: true,
        format: 'esm',
        write: false,
        external: [
            'cloudflare:sockets',
            'node:crypto'
        ],
        platform: 'browser',
        target: 'esnext',
        loader: { '.ts': 'ts' },
        define: { VERSION: `"${pkg.version}"` }
    });

    console.log(`${success} Worker built successfully!`);

    const { code: script } = await jsMinify(code.outputFiles[0].text, {
        module: true,
        output: {
            comments: false
        },
        compress: {
            dead_code: true,
            unused: true
        }
    });

    console.log(`${success} Worker minified successfully!`);

    const scriptBytes = Buffer.byteLength(script, 'utf8');
    const base64Gzip = gzipSync(script, { level: 9 }).toString('base64');

    const embededContents = {
        SOURCE_CONTENT: base64Gzip,
        PANEL_HTML_CONTENT: htmls['panel'],
        LOGIN_HTML_CONTENT: htmls['login'],
        ERROR_HTML_CONTENT: htmls['error'],
        PROXY_IP_HTML_CONTENT: htmls['proxy-ip'],
        ICON_CONTENT: faviconBase64
    };

    const worker = `Object.assign(globalThis, ${JSON.stringify(embededContents)});${script}`;

    mkdirSync(DIST_PATH, { recursive: true });
    writeFileSync(WORKER_PATH, worker, 'utf8');

    reportSize(worker, scriptBytes, base64Gzip, embededContents);
    console.log(`${success} Done! → ${WORKER_PATH}`);
}

function reportSize(worker, scriptBytes, sourceContent, embededContents) {
    const rawBytes = Buffer.byteLength(worker, 'utf8');
    const gzipBytes = gzipSync(worker, { level: 9 }).length;

    const htmlBytes = Object.entries(embededContents)
        .filter(([key]) => key.endsWith('_HTML_CONTENT'))
        .reduce((sum, [, value]) => sum + Buffer.byteLength(value, 'utf8'), 0);

    console.log('\n📊 Bundle size report:');
    console.log(`   worker code    : ${kb(scriptBytes)}`);
    console.log(`   SOURCE_CONTENT : ${kb(Buffer.byteLength(sourceContent, 'utf8'))}`);
    console.log(`   HTML embeds    : ${kb(htmlBytes)}`);
    console.log(`   ─────────────────────────────`);
    console.log(`   total (raw)    : ${kb(rawBytes)}`);
    console.log(`   total (gzip)   : ${kb(gzipBytes)} ← چیزی که Cloudflare می‌سنجه`);

    if (gzipBytes > SIZE_LIMIT_FREE) {
        console.log(`${warning} بزرگ‌تر از سقف پلن Free (${kb(SIZE_LIMIT_FREE)}) — نیاز به پلن Paid.`);
        if (gzipBytes > SIZE_LIMIT_PAID) {
            console.error(`${failure} بزرگ‌تر از سقف پلن Paid (${kb(SIZE_LIMIT_PAID)})!`);
            process.exit(1);
        }
    }
}

buildWorker().catch(err => {
    console.error(`${failure} Build failed:`, err);
    process.exit(1);
});