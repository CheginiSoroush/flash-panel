loadGeoData();

async function loadGeoData() {
    const tableBody = document.querySelector("#geo-table tbody");

    try {
        const res = await fetch("./proxy-ip/get");
        const { success, body, message } = await res.json();

        if (!success) {
            throw new Error(`Fetching Proxy IPs failed at ${res.url} - ${message}`);
        }

        if (!body.length) {
            const cell = elm('td', {
                textContent: 'Failed to get Proxy IPs',
                colSpan: '5'
            });
            const row = elm('tr', {}, [cell]);

            tableBody.innerHTML = '';
            tableBody.appendChild(row);
            return;
        }

        tableBody.innerHTML = '';

        body.forEach((item, index) => {
            const indexCell = elm('td', { textContent: String(index + 1) });

            const copyIcon = createIcon('content_copy', 'Copy to clipboard');
            const ipText = document.createTextNode(` ${item.ip || '-'}`);
            const testIcon = createIcon('flash_on', 'Test IP');
            const ipCell = elm('td', {}, [copyIcon, ipText, testIcon]);

            const healthRateCell = elm('td', { textContent: '-' });
            const avgLatencyCell = elm('td', { textContent: '-' });
            const flag = item.countryCode
                ? String.fromCodePoint(...[...item.countryCode].map(c => 0x1F1E6 + c.charCodeAt(0) - 65))
                : '';

            const countryCell = elm('td', { textContent: `${flag} ${item.country || '-'}` });
            const cityCell = elm('td', { textContent: item.city || '-' });
            const ispCell = elm('td', { textContent: item.isp || '-' });

            copyIcon.addEventListener('click', () => copyToClipboard(item.ip));
            testIcon.addEventListener('click', () => testIp(item.ip, healthRateCell, avgLatencyCell));
            const row = elm('tr', {}, [indexCell, ipCell, healthRateCell, avgLatencyCell, countryCell, cityCell, ispCell]);
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

// ---------- تست دسته‌ای + اعمال خودکار بهترین ----------

const testAllBtn = document.getElementById('testAllBtn');
const applyBestBtn = document.getElementById('applyBestBtn');
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
    setAutoStatus('Testing all targets…', 'busy');

    try {
        const res = await fetch('./proxy-ip/test-all', { cache: 'no-store' });
        const { success, body, message } = await res.json();
        if (!success) throw new Error(message || `status ${res.status}`);

        renderTestResults(body.results || [], body.best);

        if (body.best) {
            setAutoStatus(`Best: ${body.best}`, 'ok');
        } else {
            setAutoStatus('No healthy target found', 'err');
        }
    } catch (error) {
        setAutoStatus(`Test failed: ${error.message}`, 'err');
    } finally {
        testAllBtn.disabled = false;
    }
}

async function runAutoApply() {
    const proceed = confirm(
        'Auto-apply will test every configured Proxy IP and redeploy the worker ' +
        'with the fastest healthy one as the primary target.\n\nContinue?'
    );
    if (!proceed) return;

    applyBestBtn.disabled = true;
    setAutoStatus('Testing + redeploying… (up to ~1 min)', 'busy');

    try {
        const res = await fetch('./proxy-ip/auto-apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const { success, body, message } = await res.json();
        if (body?.results) renderTestResults(body.results, body.best ?? null);

        if (!success) {
            setAutoStatus(message || 'Auto-apply failed', 'err');
            return;
        }

        setAutoStatus(body.applied
            ? `✅ Applied: ${body.best} — worker redeployed (takes a few seconds)`
            : `✅ Already optimal: ${body.best} — no redeploy needed`, 'ok');
    } catch (error) {
        setAutoStatus(`Auto-apply failed: ${error.message}`, 'err');
    } finally {
        applyBestBtn.disabled = false;
    }
}

if (testAllBtn) testAllBtn.addEventListener('click', runTestAll);
if (applyBestBtn) applyBestBtn.addEventListener('click', runAutoApply);

function testIp(ip, healthyCell, avgLatencyCell) {
    document.body.classList.add('is-loading');
    fetch(`./proxy-ip/test?target=${ip}`)
        .then(res => res.json())
        .then(({ success, status, message, body }) => {
            if (!success) {
                throw new Error(`Failed with status ${status} - ${message}`);
            }

            const { successRate, avgLatencyMs } = body;
            healthyCell.textContent = successRate;
            avgLatencyCell.textContent = avgLatencyMs;
            document.body.classList.remove('is-loading');
        })
        .catch((error) => console.error(`Failed to test IP: ${error}`));
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