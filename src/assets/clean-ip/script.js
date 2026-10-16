loadEndpoints();

let currentOrder = [];

async function loadEndpoints() {
    const tableBody = document.querySelector("#endpoint-table tbody");

    try {
        const res = await fetch("./clean-ip/get");
        const { success, body, message } = await res.json();

        if (!success) {
            throw new Error(`Fetching endpoints failed at ${res.url} - ${message}`);
        }

        const entries = [
            ...body.cleanIPs.map(addr => ({ addr, source: 'Clean IP' })),
            ...body.customCdnAddrs.map(addr => ({ addr, source: 'Custom CDN' }))
        ];

        currentOrder = entries.map(e => e.addr);

        if (!entries.length) {
            const cell = elm('td', {
                textContent: 'No Clean IPs configured — add some in Settings, or run Auto-optimize',
                colSpan: '5'
            });
            const row = elm('tr', {}, [cell]);

            tableBody.innerHTML = '';
            tableBody.appendChild(row);
            return;
        }

        tableBody.innerHTML = '';

        entries.forEach((item, index) => {
            const indexCell = elm('td', { textContent: String(index + 1) });

            const copyIcon = createIcon('content_copy', 'Copy to clipboard');
            const addrText = document.createTextNode(` ${item.addr}`);
            const testIcon = createIcon('flash_on', 'Test endpoint');
            const addrCell = elm('td', { className: 'mono' }, [copyIcon, addrText, testIcon]);

            const sourceCell = elm('td', {}, [
                elm('span', { className: `src-tag ${item.source === 'Custom CDN' ? 'cdn' : ''}`, textContent: item.source })
            ]);

            const healthRateCell = elm('td', { textContent: '-' });
            const avgLatencyCell = elm('td', { textContent: '-' });

            copyIcon.addEventListener('click', () => copyToClipboard(item.addr));
            testIcon.addEventListener('click', () => testEndpoint(item.addr, healthRateCell, avgLatencyCell));
            const row = elm('tr', {}, [indexCell, addrCell, sourceCell, healthRateCell, avgLatencyCell]);
            tableBody.appendChild(row);
        });

    } catch (err) {
        const cell = elm('td', { colSpan: '5', textContent: `Error: ${err.message}` });
        const row = elm('tr', {}, [cell]);
        tableBody.innerHTML = '';
        tableBody.appendChild(row);
        console.error(err);
    }
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text)
        .then(() => alert('✅ Copied to clipboard:\n\n' + text))
        .catch(error => console.error('Failed to copy:', error));
}

// ---------- تست دسته‌ای + بهینه‌سازی خودکار ضد ۴۰۳ ----------

const testAllBtn = document.getElementById('testAllBtn');
const optimizeBtn = document.getElementById('optimizeBtn');
const includeDiscovered = document.getElementById('includeDiscovered');
const autoStatus = document.getElementById('autoStatus');
const testResults = document.getElementById('testResults');

function setAutoStatus(text, kind = '') {
    autoStatus.textContent = text;
    autoStatus.className = `auto-status ${kind}`.trim();
}

function renderTestResults(results, bestTarget) {
    const tbody = testResults.querySelector('tbody');
    tbody.innerHTML = '';
    testResults.hidden = !results.length;

    results.forEach((item, index) => {
        const isBest = bestTarget && item.target === bestTarget && item.ok;

        const indexCell = elm('td', { textContent: String(index + 1) });

        const targetCell = elm('td', { className: 'mono' }, [
            document.createTextNode(item.target),
            isBest ? elm('span', { className: 'best-tag', textContent: ' ⚡ best' }) : null
        ].filter(Boolean));

        const healthCell = elm('td', {
            className: item.ok ? 'ok' : 'bad',
            textContent: item.ok ? item.successRate : 'unhealthy'
        });

        const latencyCell = elm('td', {
            textContent: item.avgLatencyMs != null ? `${item.avgLatencyMs} ms` : '—'
        });

        const row = elm('tr', { className: isBest ? 'best-row' : '' },
            [indexCell, targetCell, healthCell, latencyCell]);
        tbody.appendChild(row);
    });
}

async function runTestAll() {
    testAllBtn.disabled = true;
    setAutoStatus('Testing all endpoints…', 'busy');

    try {
        const res = await fetch('./clean-ip/test-all', { cache: 'no-store' });
        const { success, body, message } = await res.json();
        if (!success) throw new Error(message || `status ${res.status}`);

        renderTestResults(body.results || [], body.best);

        if (body.best) {
            setAutoStatus(`Best: ${body.best}`, 'ok');
        } else {
            setAutoStatus('No healthy endpoint found — run Auto-optimize', 'err');
        }
    } catch (error) {
        setAutoStatus(`Test failed: ${error.message}`, 'err');
    } finally {
        testAllBtn.disabled = false;
    }
}

async function runAutoOptimize() {
    const discover = includeDiscovered?.checked !== false;
    const proceed = confirm(
        'Auto-optimize will:\n' +
        (discover ? ' • fetch fresh candidate IPs from public aggregators\n' : '') +
        ' • test every configured Clean IP\n' +
        ' • reorder the list healthy-first (fastest on top)\n' +
        (discover ? ' • add up to 5 newly discovered healthy IPs\n' : '') +
        ' • redeploy the worker with the new order\n\nContinue?'
    );
    if (!proceed) return;

    optimizeBtn.disabled = true;
    setAutoStatus('Discovering + testing + redeploying… (up to ~2 min)', 'busy');

    try {
        const res = await fetch('./clean-ip/auto-apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ includeDiscovered: discover })
        });
        const { success, body, message } = await res.json();
        if (body?.results) renderTestResults(body.results, body.best ?? null);

        if (!success) {
            setAutoStatus(message || 'Auto-optimize failed', 'err');
            return;
        }

        if (body.applied) {
            setAutoStatus(
                `✅ Optimized — new order: ${body.cleanIPs?.slice(0, 3).join(', ')}${body.cleanIPs?.length > 3 ? '…' : ''} (redeployed)`,
                'ok'
            );
            loadEndpoints();
        } else {
            setAutoStatus(`✅ Already optimal — no redeploy needed`, 'ok');
        }
    } catch (error) {
        setAutoStatus(`Auto-optimize failed: ${error.message}`, 'err');
    } finally {
        optimizeBtn.disabled = false;
    }
}

if (testAllBtn) testAllBtn.addEventListener('click', runTestAll);
if (optimizeBtn) optimizeBtn.addEventListener('click', runAutoOptimize);

async function testEndpoint(addr, healthyCell, avgLatencyCell) {
    document.body.classList.add('is-loading');
    try {
        const res = await fetch(`./clean-ip/test?target=${encodeURIComponent(addr)}`, { cache: 'no-store' });
        const { success, body, message } = await res.json();
        if (!success) throw new Error(message || `status ${res.status}`);

        healthyCell.textContent = body.ok ? body.successRate : 'unhealthy';
        avgLatencyCell.textContent = body.avgLatencyMs != null ? body.avgLatencyMs : '—';
    } catch (error) {
        console.error(`Failed to test endpoint: ${error}`);
    } finally {
        document.body.classList.remove('is-loading');
    }
}

function elm(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...[].concat(children));
    return node;
}

const createIcon = (text, title) => elm('span', {
    className: 'material-symbols-rounded',
    textContent: text,
    title
});
