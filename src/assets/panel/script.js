const defaultHttpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
const defaultHttpPorts = [80, 8080, 8880, 2052, 2082, 2086, 2095];
const proxyForm = document.getElementById('configForm');
const [
    selectElements,
    numInputElements,
    inputElements,
    textareaElements,
    checkboxElements
] = [
    'select',
    'input[type=number]',
    'input:not([type=file])',
    'textarea',
    'input[type=checkbox]'
].map(query => proxyForm.querySelectorAll(query));

getUsage();
initPanel();
fetchIPInfo();
initTotp();
loadSubUsers();

async function initPanel(settings, tgSettings, subscriptions, clients) {
    try {
        if (!settings) {
            const nocache = Date.now();
            const res = await fetch(`./panel/settings?nocache=${nocache}`, { cache: 'no-store' });
            const { success, status, message, body } = await res.json();

            if (status === 401 && !body.isPassSet) {
                const closeBtn = document.querySelector('.modal-close');
                openResetPass();
                closeBtn.style.visibility = 'hidden';
            }

            if (!success) {
                throw new Error(`status ${status} - ${message}`);
            }

            settings = body.proxySettings;
            tgSettings = body.telegramSettings;
            subscriptions = body.subscriptions;
            clients = body.clients;
            checkVersion(settings.panelVersion);
        }

        renderPanel(settings, tgSettings, subscriptions, clients);
    } catch (error) {
        console.error('Panel initiation error:', error);
    }
}

async function getUsage() {
    try {
        const nocache = Date.now();
        const res = await fetch(`./panel/usage?nocache=${nocache}`, { cache: 'no-store' });
        const { success, status, message, body } = await res.json();

        if (!success) {
            throw new Error(`status ${status} - ${message}`);
        }

        const { total, worker } = body;
        const totalReq = document.getElementById('total-usage');
        totalReq.textContent = total.toLocaleString('en-US');
        totalReq.style.fontSize = 'larger';
        const totalPct = document.getElementById('total-pct');
        const totalPctVal = Math.ceil(Number(total) / 100000 * 100);
        totalPct.textContent = totalPctVal;
        if (totalPctVal > 80) totalPct.style.color = 'var(--color-icon-red)';

        const panelReq = document.getElementById('panel-usage');
        panelReq.textContent = worker.toLocaleString('en-US');
        panelReq.style.fontSize = 'larger';
        const panelPct = document.getElementById('panel-pct');
        const panelPctVal = Math.ceil(Number(worker) / 100000 * 100);
        panelPct.textContent = panelPctVal;
        if (panelPctVal > 80) panelPct.style.color = 'var(--color-icon-red)';
    } catch (error) {
        console.error('Failed to get usage from API:', error);
    }
}

async function checkVersion(panelVersion) {
    try {
        const res = await fetch('https://raw.githubusercontent.com/CheginiSoroush/flash-panel/refs/heads/main/package.json', {
            cache: 'no-store'
        });

        if (!res.ok) {
            throw new Error(`status ${res.status}`);
        }

        const pkg = await res.json();
        const latest = pkg.version;
        const updateAvailable = isNewerVersion(latest, panelVersion);
        if (updateAvailable) {
            globalThis.latestVersion = latest;
            const upgradeBtn = document.getElementById('updatePanel');
            upgradeBtn.disabled = false;
        }
    } catch (error) {
        console.error('Get latest version error:', error);
    }
}

function isNewerVersion(latest, current) {
    const lv = latest.split('.').map(Number);
    const cv = current.split('.').map(Number);

    for (let i = 0; i < Math.max(lv.length, cv.length); i++) {
        const l = lv[i] ?? 0;
        const c = cv[i] ?? 0;
        if (l > c) return true;
        if (l < c) return false;
    }

    return false;
}

function renderPanel(proxySettings, tgSettings, subscriptions, clients) {
    const {
        securePath,
        ports,
        xrayUdpNoises,
        remoteSettings
    } = proxySettings;

    const path = encodeURIComponent(securePath);
    if (path !== window.location.pathname.split('/')[1]) {
        setTimeout(() => {
            window.location.href = `../${path}/panel`;
        }, 1000);
    }

    const dohUrl = new URL(`./dns-query`, window.location.href);
    document.getElementById('doh').textContent = dohUrl.href;
    document.getElementById('fetchSettingsBtn').disabled = !remoteSettings;

    selectElements.forEach(elm => elm.value = proxySettings[elm.id]);
    checkboxElements.forEach(elm => elm.checked = proxySettings[elm.id]);
    inputElements.forEach(elm => elm.value = proxySettings[elm.id] || '');
    textareaElements.forEach(elm => {
        const key = elm.id;
        const element = document.getElementById(key);
        const value = proxySettings[key]?.join('\r\n');
        const rowsCount = proxySettings[key]?.length ?? 0;
        element.style.height = 'auto';
        if (rowsCount) element.rows = rowsCount;
        element.value = value;
        elm.addEventListener('input', () => {
            elm.style.height = 'auto';
            elm.style.height = `${elm.scrollHeight}px`;
        });
    });

    renderPorts(ports.map(Number));
    renderNoises(xrayUdpNoises);
    renderSubscriptions(subscriptions);
    renderClients(clients);

    // کاتالوگ ساب برای بخش «کاربران اشتراک» — هم‌شکل با نمایش اصلی
    globalThis.subsCatalog = subscriptions;

    globalThis.initialFormData = new FormData(proxyForm);
    handleProxyFormChanges();
    proxyForm.addEventListener('input', handleProxyFormChanges);
    proxyForm.addEventListener('change', handleProxyFormChanges);
    handleFragmentMode();

    if (tgSettings) {
        const tgForm = document.getElementById('telegramForm');
        handleTgFormChanges(tgSettings);
        tgForm.addEventListener('input', () => handleTgFormChanges());

        for (const key in tgSettings) {
            const field = tgForm.elements[key];
            if (field) field.value = tgSettings[key];
        }
    }
}

function hasFormDataChanged() {
    const formDataToObject = (formData) => Object.fromEntries(formData.entries());
    const configForm = document.getElementById('configForm');
    const currentFormData = new FormData(configForm);

    const initialFormDataObj = formDataToObject(globalThis.initialFormData);
    const currentFormDataObj = formDataToObject(currentFormData);

    return JSON.stringify(initialFormDataObj) !== JSON.stringify(currentFormDataObj);
}

function handleProxyFormChanges(force = false) {
    const applyButton = document.getElementById('applyButton');
    const isChanged = hasFormDataChanged();
    applyButton.disabled = force ? false : !isChanged;
}

function handleTgFormChanges(settings) {
    const userId = document.getElementById('telegramUserId');
    const token = document.getElementById('telegramBotToken');
    const setupBtn = document.getElementById('setup-telegram');
    const removeBtn = document.getElementById('remove-telegram');

    if (settings) {
        const { telegramUserId, telegramBotToken } = settings;
        removeBtn.disabled = !telegramUserId && !telegramBotToken;
        setupBtn.disabled = true;

        userId.value = telegramUserId;
        token.value = telegramBotToken;

        return;
    }

    setupBtn.disabled = !userId.value.trim() || !token.value.trim();
}

async function getIpDetails(ip) {
    try {
        const response = await fetch('./panel/my-ip', { method: 'POST', body: ip });
        const { success, status, message, body } = await response.json();

        if (!success) {
            throw new Error(`status ${status} - ${message}`);
        }

        return body;
    } catch (error) {
        console.error('Fetching IP error:', error)
    }
}

async function fetchIPInfo() {
    const icons = startWaiting(null, 'refresh-geo-location', '');

    const updateUI = (ip = '-', country = '-', countryCode = '-', city = '-', isp = '-', cfIP) => {
        const flag = countryCode !== '-' ? String.fromCodePoint(...[...countryCode].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '';
        const updateContent = (id, content) => document.getElementById(id).textContent = content;
        updateContent(cfIP ? 'cf-ip' : 'ip', ip);
        updateContent(cfIP ? 'cf-country' : 'country', `${flag} ${country}`);
        updateContent(cfIP ? 'cf-city' : 'city', city);
        updateContent(cfIP ? 'cf-isp' : 'isp', isp);
    };

    const nocache = Date.now();
    const othersPromise = fetch(`https://ipv4.geojs.io/v1/ip.json?nocache=${nocache}`, { cache: 'no-store' })
        .then(async res => {
            if (!res.ok) throw new Error(`Fetch Other targets IP failed.`);
            const { ip } = await res.json();
            const { country, countryCode, city, isp } = await getIpDetails(ip);
            updateUI(ip, country, countryCode, city, isp);
        });

    const cfPromise = fetch(`https://ipv4.icanhazip.com/?nocache=${nocache}`, { cache: 'no-store' })
        .then(async res => {
            if (!res.ok) throw new Error(`Fetch Cloudflare targets IP failed.`);
            const ip = await res.text();
            const { country, countryCode, city, isp } = await getIpDetails(ip.trim());
            updateUI(ip, country, countryCode, city, isp, true);
        });

    const results = await Promise.allSettled([othersPromise, cfPromise]);
    results.forEach(result => {
        if (result.status === 'rejected') console.error(result.reason);
    });

    stopWaiting(icons);
}

function generateSubUrl(type, core, tag) {
    return generateSubLink(type, type, core, tag);
}

/** لینک اشتراک کاربر — <securePath>/sub/<userId>/<type> */
function generateUserSubUrl(userId, type, core, tag) {
    return generateSubLink(`${userId}/${type}`, type, core, tag);
}

function generateSubLink(subPath, type, core, tag) {
    const url = new URL(`./sub/${subPath}`, window.location.href);
    url.searchParams.append('app', core);
    url.hash = `⚡ Flash ${tag}`;

    if (core === 'sing-box' && type !== 'raw') {
        return `sing-box://import-remote-profile?url=${url.href}`;
    }

    return url.href;
}

async function generateQRCode(data) {
    const url = new URL('./qrcode', window.location.href);
    url.searchParams.set('data', data);
    url.searchParams.set('nocache', Date.now().toString());

    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) {
        throw new Error(`status ${res.status}`);
    }

    const blob = await res.blob();

    return elm('img', {
        id: 'qr',
        className: 'qrcode',
        src: URL.createObjectURL(blob)
    });
}

function showQRCode(subUrl) {
    const url = new URL(subUrl);
    const modal = document.getElementById('qrModal');
    const close = modal.querySelector('.modal-close');
    const container = document.getElementById('qrcode-container');

    let qrcodeTitle = document.getElementById('qrcodeTitle');
    qrcodeTitle.textContent = decodeURIComponent(url.hash).replace('#', '');

    close.onclick = () => {
        modal.hidden = true;
        container.lastElementChild.remove();
        window.onclick = null;
    };

    window.onclick = (event) => {
        if (event.target == modal) {
            modal.hidden = true;
            container.lastElementChild.remove();
        }
    }

    generateQRCode(subUrl).then(qr => {
        container.appendChild(qr);
        modal.hidden = false;
    });
}

function copyToClipboard(url) {
    navigator.clipboard.writeText(url)
        .then(() => notify('info', 'Copied to clipboard', [url]))
        .catch(error => console.error('Failed to copy:', error));
}

function copyDoh() {
    const url = document.getElementById('doh').textContent;
    copyToClipboard(url);
}

async function dlUrl(subUrl) {
    const url = new URL(subUrl);
    window.location.href = url.protocol === 'sing-box:' ? url.searchParams.get('url') : subUrl;
}

async function exportFileSettings(event) {
    if (hasFormDataChanged()) {
        notify('error', 'Export settings', ['Please apply unsaved changes first.']);
        return;
    }

    const icons = startWaiting(event.target, '', 'refresh');
    const url = new URL('./sub/share-settings', window.location.href);
    window.location.href = url.href;
    stopWaiting(icons);
}

function importFile() {
    const input = document.getElementById('fileInput');
    input.value = '';
    input.click();
}

async function importFileSettings(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        const data = atob(text);
        const newSettings = JSON.parse(data);
        const currentSettings = validateSettings();
        const settings = { ...currentSettings, ...newSettings };

        renderPanel(settings);
        handleProxyFormChanges(true);

        notify('success', 'Import settings', [
            'Settings imported successfully!',
            'Please first REVIEW new settings and then apply, specially ROUTING settings.'
        ]);
    } catch (error) {
        console.error('Import settings error:', error);
        notify('error', 'Import settings', ['Failed to get settings from file.']);
    }
}

async function importRemoteSettings(event) {
    if (hasFormDataChanged()) {
        notify('error', 'Import settings', ['Please apply unsaved changes first.']);
        return;
    }

    const icons = startWaiting(event.target, '', 'refresh');
    const remote = document.getElementById('remoteSettings').value.trim();
    const currentSettings = validateSettings();

    try {
        const newSettings = await fetchSettings(remote);
        const settings = { ...currentSettings, ...newSettings };

        renderPanel(settings);
        handleProxyFormChanges(true);

        notify('success', 'Import settings', [
            'Settings imported successfully!',
            'Please first REVIEW new settings and then apply, specially ROUTING settings.'
        ]);
    } catch (error) {
        console.error('Import settings error:', error);
        notify('error', 'Import settings', ['Failed to get settings from remote.']);
    } finally {
        stopWaiting(icons);
    }
}

function shareSettings() {
    const url = new URL('./sub/share-settings', window.location.href);
    copyToClipboard(url);
}

async function fetchSettings(remoteUrl) {
    const url = new URL(remoteUrl);
    const remote = `${url.origin + url.pathname}?nocache=${Date.now()}`;

    const res = await fetch(remote, { cache: 'no-store' });
    if (!res.ok) {
        throw new Error(`status ${res.status}`);
    }

    const data = await res.text();
    return JSON.parse(atob(data));
}

async function renewWarpAccounts(btn) {
    const confirm = await notify('confirm', 'Renew Warp Accounts', ['Are you sure?'])
    if (!confirm) return;
    const icons = startWaiting(btn, '', '');

    try {
        const response = await fetch('./panel/update-warp', { method: 'POST', credentials: 'include' });
        const { success, status, message } = await response.json();

        if (!success) {
            notify('error', 'Renew Warp Accounts', ['An error occured, Please try again later.']);
            throw new Error(`status ${status} - ${message}`);
        }

        notify('success', 'Renew Warp Accounts', ['Warp accounts updated successfully!']);
    } catch (error) {
        console.error('Updating Warp configs error:', error)
        notify('error', 'Renew Warp Accounts', ['Failed to renew Warp accounts.']);
    } finally {
        stopWaiting(icons);
    }
}

async function handleRiskyRules(event) {
    if (event.target.checked) {
        const proceed = await notify('confirm', 'Geo asset files', [
            "v2ray users should set Geo Assets to Chocolate4U and download assets, otherwise configs won't connect.",
            'Proceed anyway?'
        ]);

        if (!proceed) {
            event.target.checked = false;
            return;
        }
    }
}

function handleFragmentMode() {
    const fragmentMode = document.getElementById('fragmentMode').value;
    const formDataObj = Object.fromEntries(globalThis.initialFormData.entries());
    const inputs = [
        'fragmentLengthMin',
        'fragmentLengthMax',
        'fragmentDelayMin',
        'fragmentDelayMax'
    ];

    const configs = {
        low: [100, 200, 1, 1],
        medium: [50, 100, 1, 5],
        high: [10, 20, 10, 20],
        severe: [1, 5, 1, 5],
        custom: inputs.map(id => formDataObj[id])
    };

    inputs.forEach((id, index) => {
        const elm = document.getElementById(id);
        elm.value = configs[fragmentMode][index];
        fragmentMode !== 'custom'
            ? elm.setAttribute('readonly', 'true')
            : elm.removeAttribute('readonly');
    });
}

async function resetSettings(btn) {
    const confirm = await notify(
        'confirm',
        'Reset panel settings',
        [
            'This will reset all settings except:',
            '+ VLESS UUID',
            '+ Trojan password',
            '+ Panel - Subscriptions path\n',
            'Are you sure?'
        ]
    );

    if (!confirm) return;
    const icons = startWaiting(btn, '', '', false);

    try {
        const res = await fetch('./panel/reset-settings', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });

        const { success, status, message, body } = await res.json();
        if (!success) {
            throw new Error(`status ${status} - ${message}`);
        }

        notify(
            'success',
            'Reset panel settings',
            ['Please update your subscriptions.']
        );

        renderPanel(body);
    } catch (error) {
        console.error('Reseting settings error:', error);
    } finally {
        stopWaiting(icons);
    }
}

function updateSettings(event, data) {
    event.preventDefault();
    event.stopPropagation();

    const validatedForm = validateSettings();
    if (!validatedForm) return false;
    const form = data ?? validatedForm;

    const icons = startWaiting(null, 'applyButton', 'refresh');

    fetch('./panel/update-settings', {
        method: 'PUT',
        body: JSON.stringify(form),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
    })
        .then(res => res.json())
        .then(({ success, status, message, body: errors }) => {
            if (status === 401) {
                notify(
                    'error',
                    'Apply settings',
                    ['Session expired! Please login and try again.']
                );
                window.location.href = './login';
            }

            if (!success) {
                errors.forEach(error => {
                    notify('error', error.field, error.message);
                });
                throw new Error(`status ${status} - ${message}`);
            }

            notify(
                'success',
                'Apply settings',
                ['Please update your subscriptions.']
            );

            renderPanel(form);
        })
        .catch(error => console.error('Update settings error:', error))
        .finally(() => stopWaiting(icons));
}

function setupTelegramBot() {
    event.preventDefault();
    event.stopPropagation();

    const formData = new FormData(event.target);
    const form = Object.fromEntries(formData.entries());

    const setupBtn = document.getElementById('setup-telegram');
    const icons = startWaiting(setupBtn, '', 'refresh');

    fetch('./telegram/setup', {
        method: 'PUT',
        body: JSON.stringify(form),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
    })
        .then(res => res.json())
        .then(({ success, status, message, body }) => {
            if (status === 401) {
                notify(
                    'error',
                    'Setup Telegram bot',
                    ['Session expired! Please login and try again.']
                );
                window.location.href = './login';
            }

            if (!success) {
                throw new Error(`status ${status} - ${message}`);
            }

            handleTgFormChanges(body);
            notify(
                'success',
                'Setup Telegram bot',
                ['Telegram bot is ready to use.']
            );
        })
        .catch(error => console.error('Setup Telegram bot error:', error))
        .finally(() => {
            stopWaiting(icons);
            setupBtn.disabled = true;
        });
}

function removeTelegramBot(btn) {
    const icons = startWaiting(btn, '', 'refresh');

    fetch('./telegram/remove', { method: 'POST', credentials: 'include' })
        .then(res => res.json())
        .then(({ success, status, message, body }) => {
            if (status === 401) {
                notify(
                    'error',
                    'Remove Telegram bot',
                    ['Session expired! Please login and try again.']
                );
                window.location.href = './login';
            }

            if (!success) {
                throw new Error(`status ${status} - ${message}`);
            }

            handleTgFormChanges(body);
            notify(
                'success',
                'Remove Telegram bot',
                ['Telegram bot removed successfully!']
            );
        })
        .catch(error => console.error('Remove Telegram bot error:', error))
        .finally(() => stopWaiting(icons));
}

function validateSettings() {
    const configForm = document.getElementById('configForm');
    const formData = new FormData(configForm);

    const fields = [
        'udpXrayNoiseMode',
        'udpXrayNoisePacket',
        'udpXrayNoiseDelayMin',
        'udpXrayNoiseDelayMax',
        'udpXrayNoiseCount'
    ].map(field => formData.getAll(field));

    const form = Object.fromEntries(formData.entries());
    const [modes, packets, delaysMin, delaysMax, counts] = fields;

    form.xrayUdpNoises = modes.map((mode, index) => ({
        type: mode,
        packet: packets[index],
        delay: `${delaysMin[index]}-${delaysMax[index]}`,
        count: counts[index]
    }));

    form.ports = [
        ...defaultHttpPorts,
        ...defaultHttpsPorts
    ].filter(port => formData.has(port.toString()));

    checkboxElements.forEach(elm => {
        form[elm.id] = formData.has(elm.id);
    });

    selectElements.forEach(elm => {
        let value = form[elm.id];
        if (value === 'true') value = true;
        if (value === 'false') value = false;
        form[elm.id] = value;
    });

    inputElements.forEach(elm => {
        if (typeof form[elm.id] === 'string') {
            form[elm.id] = form[elm.id].trim();
        }
    });

    numInputElements.forEach(elm => {
        form[elm.id] = Number(form[elm.id].trim());
    });

    textareaElements.forEach(elm => {
        const key = elm.id;
        const value = form[key];
        form[key] = value?.split('\n').map(val => val.trim()).filter(Boolean) || [];
    });

    return form;
}

function logout(event) {
    event.preventDefault();
    fetch('./panel/logout', { method: 'GET', credentials: 'same-origin' })
        .then(response => response.json())
        .then(({ success, status, message }) => {
            if (!success) {
                throw new Error(`status ${status} - ${message}`);
            }

            window.location.href = './login';
        })
        .catch(error => console.error('Logout error:', error));
}

function openResetPass(event) {
    const modal = document.getElementById('resetPassModal');
    const close = modal.querySelector('.modal-close');
    const showHides = modal.querySelectorAll('.show-hide');
    const title = modal.querySelector('.modal-title');
    const form = modal.querySelector('.config-form');
    const username = document.getElementById('usernameContainer');
    if (!event) {
        title.textContent = 'Set Password';
        username.style.display = 'flex';
        username.setAttribute('required', 'true');
    }

    close.onclick = () => modal.hidden = true;
    form.onsubmit = resetPassword;
    showHides.forEach(elm => {
        elm.onclick = () => {
            const input = elm.previousElementSibling;
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            elm.textContent = isPassword ? 'visibility' : 'visibility_off';
        }
    });

    modal.hidden = false;
}

function resetPassword(event) {
    event.preventDefault();
    const username = document.getElementById('username').value.trim().toLowerCase();
    const passwordError = document.getElementById('passwordError');
    const password = document.getElementById('newPassword').value.trim();
    const confirmPassword = document.getElementById('confirmPassword').value.trim();

    if (password !== confirmPassword) {
        passwordError.textContent = 'Passwords do not match';
        return false;
    }

    const valid = /^(?=.*[A-Z])(?=.*\d).{8,}$/.test(password);
    if (!valid) {
        passwordError.textContent = 'Must contain at least one capital letter, one number, and be at least 8 characters long.';
        return false;
    }

    fetch('./panel/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        credentials: 'same-origin',
        body: JSON.stringify({
            username,
            password
        })
    })
        .then(response => response.json())
        .then(({ success, status, message }) => {
            if (!success) {
                passwordError.textContent = message;
                throw new Error(`status ${status} - ${message}`);
            }

            notify('success', 'Reset password', ['Password changed successfully!']);
            window.location.href = './login';
        })
        .catch(error => console.error('Reset password error:', error));
}

function genNoisePacket(mode, packet) {
    switch (mode.value) {
        case 'base64':
            packet.value = randBase64(32, 64);
            break;
        case 'rand':
            packet.value = '50-100';
            break;
        case 'hex':
            packet.value = randHex(32, 64);
            break;
        case 'array':
            packet.value = randArray(32, 64);
            break;
        case 'str': {
            const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            packet.value = randString(charset, 32, 64);
        }
    }

    handleProxyFormChanges();
}

function randUUID() {
    const uuid = document.getElementById('vlUUID');
    uuid.value = crypto.randomUUID();
    handleProxyFormChanges();
}

function randString(charset, minLen, maxLen) {
    return [...randBytes(minLen, maxLen)]
        .map(byte => charset[byte % charset.length])
        .join('');
}

function randArray(minLen, maxLen) {
    const length = Math.floor(Math.random() * (maxLen - minLen + 1)) + minLen;
    const array = Array.from({ length }, () => Math.floor(Math.random() * 256));
    const field = array.map(String).join(',');

    return field;
}

function randBytes(minBytes, maxBytes) {
    const bytes = Math.floor(Math.random() * (maxBytes - minBytes + 1)) + minBytes;
    const array = new Uint8Array(bytes);
    crypto.getRandomValues(array);

    return array;
}

function randHex(minBytes, maxBytes) {
    return [...randBytes(minBytes, maxBytes)]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function randBase64(minBytes, maxBytes) {
    return btoa(String.fromCharCode(...randBytes(minBytes, maxBytes)));
}

function randPassword() {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@$&*_-+;:,.';
    const trPass = document.getElementById('trPass');
    trPass.value = randString(charset, 16, 32);
    handleProxyFormChanges();
}

function randPath() {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const securePath = document.getElementById('securePath');
    securePath.value = randString(charset, 16, 32);
    handleProxyFormChanges();
}

async function updatePanel(btn) {
    const confirm = await notify('confirm', 'Update Flash Panel', [
        `Flash Panel version ${globalThis.latestVersion} is now available!`,
        `Please read <a href='https://github.com/CheginiSoroush/flash-panel/releases/latest' target='_blank' rel='noopener noreferrer'>Release notes</a> carefully before updating.`,
        'Are you sure?'
    ]);

    if (!confirm) return;
    const icons = startWaiting(btn, '', 'refresh');

    fetch('./panel/update-panel', { method: 'POST' })
        .then(res => res.json())
        .then(({ success, status, message }) => {
            if (!success) throw new Error(`status ${status} - ${message}`);
            notify('success', 'Update panel', ['Your panel upgraded successfully!']);
            setTimeout(() => {
                location.reload();
            }, 3000);
        })
        .catch(error => {
            notify('error', 'Update panel', ['Failed to update your Flash Panel, please try again.']);
            console.error('Update panel error:', error)
        })
        .finally(() => stopWaiting(icons));
}

async function deletePanel(btn) {
    const confirm = await notify('confirm', 'Delete Flash Panel', [
        'This will permanently delete your panel from your Cloudflare account',
        'Are you sure?'
    ]);

    if (!confirm) return;
    const icons = startWaiting(btn, '', 'refresh');

    fetch('./panel/delete-panel', { method: 'POST' })
        .then(res => res.json())
        .then(({ success, status, message }) => {
            if (!success) throw new Error(`status ${status} - ${message}`);
            notify('success', 'Delete panel', ['Your panel deleted successfully!']);
        })
        .catch(error => {
            notify('error', 'Delete panel', ['Failed to delete your Flash Panel, please try again.']);
            console.error('Delete panel error:', error)
        })
        .finally(() => stopWaiting(icons));
}

function notify(type, title, text) {
    return new Promise(resolve => {
        const fragment = document.getElementById('message-template').content.cloneNode(true);
        const modal = fragment.querySelector('.modal');
        modal.hidden = false;

        modal.querySelector('.message-title').textContent = title;
        modal.querySelector('.message-text').innerHTML = text.join('\n');

        const icon = modal.querySelector('.message-icon');
        const isOk = type === 'success' || type === 'info';
        const isConfirm = type === 'confirm';

        icon.textContent = isOk ? 'check_circle' : isConfirm ? 'help' : 'error';
        icon.style.color = isOk ? 'var(--color-icon-green)' : 'var(--color-icon-red)';

        const okBtn = modal.querySelector('.message-ok-btn');
        const cancelBtn = modal.querySelector('.message-cancel-btn');
        const closeBtn = modal.querySelector('.modal-close');

        const handle = (value) => {
            modal.remove();
            resolve(value);
        };

        if (type === 'confirm') {
            cancelBtn.onclick = () => handle(false);
        } else {
            cancelBtn.style.display = 'none';
        }

        if (type === 'info') {
            okBtn.style.display = 'none';
        } else {
            okBtn.onclick = () => handle(true);
        }

        closeBtn.onclick = () => handle(false)
        document.body.appendChild(fragment);

        if (type === 'info') {
            setTimeout(() => {
                modal.remove();
                resolve(null);
            }, 1000);

            return;
        }
    });
}

function startWaiting(button, id, customIcon, cw = true) {
    document.body.classList.add('is-loading');
    const btn = button ?? document.getElementById(id);
    const icon = btn.querySelector('span');
    const initIcon = icon.textContent;
    if (customIcon) icon.textContent = customIcon;
    icon.classList.add(`${cw ? 'cw' : 'ccw'}-spinning`);
    return { icon, initIcon };
}

function stopWaiting(icons) {
    document.body.classList.remove('is-loading');
    const { icon, initIcon } = icons;
    icon.classList.remove('cw-spinning');
    icon.classList.remove('ccw-spinning');
    if (initIcon !== icon.textContent) icon.textContent = initIcon;
}

function elm(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...[].concat(children));
    return node;
}

const createIcon = (text) => elm('span', {
    className: 'material-symbols-rounded',
    textContent: text
});

function createFormControl(labelText, action) {
    const label = elm('span', { textContent: labelText }, action ? createIcon('refresh') : []);
    const control = elm('div', { className: 'form-control' }, [label, elm('div')]);

    return control;
}

async function deleteNoise(event) {
    const confirm = await notify('confirm', 'Delete UDP noise', ['Are you sure?']);
    if (!confirm) return;

    event.target.closest('.inner-container').remove();
    handleProxyFormChanges();
}

function addNoise(isManual, noiseIndex, udpNoise) {
    const index = noiseIndex
        ? noiseIndex
        : document.getElementById('noises').childElementCount;

    const noise = udpNoise || {
        type: 'rand',
        packet: '50-100',
        delay: '1-5',
        count: 5
    };

    const heading = elm('h4', { textContent: `Noise ${index + 1}` });
    const headerDiv = elm('div', { className: 'header-container' }, heading);

    if (index !== 0) {
        const deleteBtn = elm('button', {
            type: 'button',
            className: 'delete-noise',
            onclick: deleteNoise
        }, createIcon('delete'));
        headerDiv.appendChild(deleteBtn);
    }

    const modeOptions = [
        ['base64', 'Base64'],
        ['rand', 'Random'],
        ['str', 'String'],
        ['hex', 'Hex'],
        ['array', 'Array']
    ].map(([value, label]) => elm('option', { value, textContent: label, selected: noise.type === value }));

    const modeSelect = elm('select', { name: 'udpXrayNoiseMode' }, modeOptions);
    const modeControl = createFormControl('Mode');

    const selectWrapper = modeControl.querySelector('div');
    selectWrapper.className = 'select-wrapper';
    selectWrapper.append(modeSelect, createIcon('keyboard_arrow_down'))

    const packetInput = elm('input', { type: 'text', name: 'udpXrayNoisePacket', value: noise.packet });
    const packetControl = createFormControl('Packet', true);
    packetControl.querySelector('div').appendChild(packetInput);
    const generateBtn = packetControl.querySelector('.material-symbols-rounded');

    modeSelect.onchange = generateBtn.onclick = () => genNoisePacket(modeSelect, packetInput);

    const countInput = elm('input', {
        type: 'number', name: 'udpXrayNoiseCount', value: String(noise.count), min: '1', required: true
    });
    const countControl = createFormControl('Count');
    countControl.querySelector('div').appendChild(countInput);

    const [delayMin, delayMax] = noise.delay.split('-');
    const delayMinInput = elm('input', { type: 'number', name: 'udpXrayNoiseDelayMin', value: delayMin, min: '1', required: true });
    const delayMaxInput = elm('input', { type: 'number', name: 'udpXrayNoiseDelayMax', value: delayMax, min: '1', required: true });
    const minMaxDiv = elm('div', { className: 'min-max' }, [delayMinInput, elm('span', { textContent: ' - ' }), delayMaxInput]);
    const delayControl = createFormControl('Delay');
    delayControl.querySelector('div').appendChild(minMaxDiv);

    const section = elm('div', { className: 'section' }, [modeControl, packetControl, countControl, delayControl]);
    const container = elm('div', { className: 'inner-container' }, [headerDiv, section]);

    document.getElementById('noises').append(container);
    if (isManual) handleProxyFormChanges(true);
}

function renderPorts(ports) {
    let noneTlsPortsBlock = document.createDocumentFragment();
    let tlsPortsBlock = document.createDocumentFragment();

    const totalPorts = [
        ...(window.origin.includes('workers.dev') ? defaultHttpPorts : []),
        ...defaultHttpsPorts
    ];

    totalPorts.forEach(port => {
        const isChecked = ports.includes(port);
        const isHttpsPort = defaultHttpsPorts.includes(port);

        const checkbox = elm('input', {
            type: 'checkbox',
            name: String(port),
            value: 'true',
            checked: isChecked
        });

        const label = elm('span', { textContent: String(port) });
        const wrapper = elm('div', { className: 'checkbox-wrapper' }, [checkbox, label]);

        if (isHttpsPort) {
            tlsPortsBlock.appendChild(wrapper);
        } else {
            noneTlsPortsBlock.appendChild(wrapper);
        }
    });

    const tlsContainer = document.getElementById('tls-ports');
    tlsContainer.innerHTML = '';
    tlsContainer.appendChild(tlsPortsBlock);

    const nonTlsContainer = document.getElementById('non-tls-ports');
    if (noneTlsPortsBlock.childElementCount > 0) {
        nonTlsContainer.innerHTML = '';
        nonTlsContainer.appendChild(noneTlsPortsBlock);
        document.getElementById('none-tls').style.display = 'flex';
    }
}

function renderNoises(xrayUdpNoises) {
    document.getElementById('noises').innerHTML = '';
    xrayUdpNoises.forEach((noise, index) => {
        addNoise(false, index, noise);
    });
}

function renderSubscriptions(subscriptions) {
    if (!subscriptions) return;
    for (const [type, { label, categories }] of Object.entries(subscriptions)) {
        const help = elm('a', {
            className: 'help-icon',
            href: `https://github.com/CheginiSoroush/flash-panel#readme`,
            target: '_blank',
            title: 'Help'
        }, createIcon('info'));

        const header = elm('h3', { textContent: label });
        const summary = elm('summary', {}, header);
        const section = elm('details', {}, summary);
        const table = buildSubTable(type, label, categories, (t, core, l) => generateSubUrl(t, core, l));

        const container = elm('div', { className: 'table-container' }, table);
        section.appendChild(container);
        const item = elm('div', { className: 'accordion-item' }, [section, help]);
        document.getElementById('subscriptions').appendChild(item);
    };
}

/**
 * جدول دکمه‌های یک نوع ساب — مشترک بین «Subscriptions» و «Subscription Users»
 * makeUrl(type, core, label) → لینک قابل اشتراک برای آن ردیف
 */
function buildSubTable(type, label, categories, makeUrl) {
    return elm('table', {}, categories.map(({ core, clients }) => {
        const clientSection = elm('td', {}, clients.map(client => {
            const icon = createIcon('verified');
            const title = elm('span', { textContent: client });
            const wrapper = elm('div', {}, [icon, title]);
            return wrapper;
        }));

        const url = makeUrl(type, core, label);
        const ctaSection = elm('td');

        const wgCore = ['wireguard', 'amnezia'].includes(core);
        if (!wgCore) {
            const qrBtn = elm('button', { title: 'Display QR code', onclick: () => showQRCode(url) }, createIcon('qr_code'));
            const copyBtn = elm('button', { title: 'Copy subscription URL', onclick: () => copyToClipboard(url) }, createIcon('content_copy'));
            ctaSection.append(qrBtn, copyBtn);
        }

        if (type !== 'raw') {
            const dlBtn = elm('button', { title: 'Download config', onclick: () => dlUrl(url) }, createIcon('download'));
            ctaSection.appendChild(dlBtn);
        }

        return elm('tr', {}, [clientSection, ctaSection]);
    }));
}

// ---------- اشتراک چندکاربره (per-user subscription UUID) ----------

async function loadSubUsers() {
    const list = document.getElementById('subUsersList');
    if (!list) return;

    try {
        const res = await fetch('./panel/sub-users', { cache: 'no-store' });
        const { success, status, message, body } = await res.json();
        if (!success) throw new Error(`status ${status} - ${message}`);

        renderSubUsers(body.users || []);
    } catch (error) {
        console.error('Failed to load subscription users:', error);
    }
}

function renderSubUsers(users) {
    const list = document.getElementById('subUsersList');
    if (!list) return;

    list.textContent = '';

    if (!users.length) {
        const empty = elm('p', {
            className: 'sub-users-empty',
            textContent: 'No subscription users yet — add one above to create an independently revocable link.'
        });
        list.appendChild(empty);
        return;
    }

    for (const user of users) {
        list.appendChild(renderSubUserItem(user));
    }
}

function renderSubUserItem(user) {
    const nameEl = elm('span', { className: 'sub-user-name', textContent: user.name });
    const badge = elm('span', {
        className: `sub-user-badge ${user.active ? 'active' : 'revoked'}`,
        textContent: user.active ? 'Active' : 'Revoked'
    });
    const title = elm('div', { className: 'sub-user-title' }, [nameEl, badge]);

    const toggleIcon = user.active ? 'block' : 'check_circle';
    const toggleTitle = user.active ? 'Revoke access' : 'Restore access';
    const toggleBtn = elm('button', {
        title: toggleTitle,
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleSubUser(user.id, !user.active); }
    }, createIcon(toggleIcon));

    const delBtn = elm('button', {
        title: 'Delete user permanently',
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); removeSubUser(user.id, user.name); }
    }, createIcon('delete'));

    const actions = elm('div', { className: 'sub-user-actions' }, [toggleBtn, delBtn]);
    const summary = elm('summary', {}, [title, actions]);
    const section = elm('details', {}, summary);

    // ---------- آمار واکشی + لینک تلگرام (برای broadcast ربات) ----------
    const fetchesElm = elm('span', { className: 'sub-user-stat', title: 'Recorded fetches (5-min throttle)' }, [
        createIcon('bar_chart'),
        document.createTextNode(String(user.fetchCount || 0))
    ]);

    const lastFetchElm = elm('span', { className: 'sub-user-stat', title: 'Last recorded fetch' }, [
        createIcon('history'),
        document.createTextNode(formatRelativeTime(user.lastFetchedAt))
    ]);

    const chatElm = elm('span', {
        className: `sub-user-stat ${user.telegramChatId ? 'linked' : ''}`,
        title: user.telegramChatId ? `Telegram chat: ${user.telegramChatId}` : 'No Telegram chat linked'
    }, [
        createIcon('smart_toy'),
        document.createTextNode(user.telegramChatId ? 'linked' : 'no chat')
    ]);

    const statsRow = elm('div', { className: 'sub-user-stats' }, [fetchesElm, lastFetchElm, chatElm]);

    // ---------- ادیتور chat_id تلگرام ----------
    const chatInput = elm('input', {
        type: 'text',
        inputMode: 'numeric',
        autoComplete: 'off',
        spellcheck: false,
        placeholder: 'Telegram chat ID (for bot broadcasts)',
        value: user.telegramChatId || '',
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); saveSubUserChat(user.id, chatInput.value); } }
    });

    const chatSaveBtn = elm('button', {
        type: 'button',
        title: 'Save Telegram chat ID',
        onclick: (e) => { e.preventDefault(); saveSubUserChat(user.id, chatInput.value); }
    }, createIcon('save'));

    const chatClearBtn = elm('button', {
        type: 'button',
        title: 'Unlink Telegram chat',
        onclick: (e) => { e.preventDefault(); chatInput.value = ''; saveSubUserChat(user.id, ''); }
    }, createIcon('close'));

    const chatEditor = elm('div', { className: 'sub-user-chat' }, [chatInput, chatSaveBtn, chatClearBtn]);

    const meta = elm('div', { className: 'sub-user-meta' }, [statsRow, chatEditor]);

    const catalog = globalThis.subsCatalog || {};
    const tables = Object.entries(catalog).map(([type, { label, categories }]) => {
        const table = buildSubTable(
            type, label, categories,
            (t, core, l) => generateUserSubUrl(user.id, t, core, `${l} — ${user.name}`)
        );
        const heading = elm('h4', { textContent: label });
        return elm('div', { className: 'sub-user-subs' }, [heading, elm('div', { className: 'table-container' }, table)]);
    });

    const container = elm('div', { className: 'sub-user-body' }, [meta, ...tables]);
    section.appendChild(container);

    return elm('div', {
        className: `accordion-item sub-user-item ${user.active ? '' : 'revoked-item'}`
    }, section);
}

/** زمان نسبی خوانا برای lastFetchedAt — هم‌شکل گزارش ربات */
function formatRelativeTime(ts) {
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '—';

    const diff = Date.now() - ts;
    if (diff < 0) return '—';
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;

    return new Date(ts).toISOString().slice(0, 10);
}

/** ذخیره/حذف chat_id تلگرام یک کاربر — '' یعنی حذف لینک */
async function saveSubUserChat(userId, rawValue) {
    const value = (rawValue || '').trim();

    if (value && !/^\d{5,20}$/.test(value)) {
        notify('error', 'Subscription users', ['Telegram chat ID must be 5-20 digits (e.g. 123456789).']);
        return;
    }

    try {
        const res = await fetch('./panel/sub-users', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: userId, telegramChatId: value })
        });
        const { success, status, message } = await res.json();
        if (!success) throw new Error(`status ${status} - ${message}`);

        notify('success', 'Subscription users',
            [value ? 'Telegram chat linked — this user is broadcast-ready.' : 'Telegram chat unlinked.']);
        await loadSubUsers();
    } catch (error) {
        notify('error', 'Subscription users', [`Failed to save chat ID: ${error.message}`]);
    }
}

async function addSubUser() {
    const input = document.getElementById('subUserName');
    const btn = document.getElementById('addSubUserBtn');
    const name = (input.value || '').trim();

    if (!name) {
        notify('error', 'Subscription users', ['Please enter a name for the new user.']);
        return;
    }

    btn.disabled = true;
    try {
        const res = await fetch('./panel/sub-users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const { success, status, message, body } = await res.json();
        if (!success) throw new Error(`status ${status} - ${message}`);

        input.value = '';
        notify('success', 'Subscription users', [`User “${body.user.name}” created — share their links below.`]);
        await loadSubUsers();
    } catch (error) {
        notify('error', 'Subscription users', [`Failed to create user: ${error.message}`]);
    } finally {
        btn.disabled = false;
    }
}

async function toggleSubUser(userId, active) {
    try {
        const res = await fetch('./panel/sub-users', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: userId, active })
        });
        const { success, status, message } = await res.json();
        if (!success) throw new Error(`status ${status} - ${message}`);

        notify(active ? 'success' : 'info', 'Subscription users',
            [active ? 'Access restored.' : 'Access revoked — their links stop working now.']);
        await loadSubUsers();
    } catch (error) {
        notify('error', 'Subscription users', [`Failed to update user: ${error.message}`]);
    }
}

async function removeSubUser(userId, name) {
    const proceed = await notify('confirm', 'Delete subscription user',
        [`Delete “${name}” permanently?`, 'All of their subscription links stop working immediately.']);
    if (!proceed) return;

    try {
        const res = await fetch('./panel/sub-users', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: userId })
        });
        const { success, status, message } = await res.json();
        if (!success) throw new Error(`status ${status} - ${message}`);

        notify('success', 'Subscription users', [`User “${name}” deleted.`]);
        await loadSubUsers();
    } catch (error) {
        notify('error', 'Subscription users', [`Failed to delete user: ${error.message}`]);
    }
}

function renderClients(clients) {
    if (!clients) return;
    clients.forEach(client => {
        const name = elm('td', { scope: 'col', textContent: client.name });
        const minVer = elm('td', { scope: 'col', textContent: client.minVer });

        const source = elm('span', { textContent: client.source });
        const dlBtn = elm('a', {
            href: atob(client.b64Url),
            target: '_blank',
            rel: 'noopener noreferrer'
        }, createIcon('download'));
        const download = elm('td', {}, [source, dlBtn]);

        const row = elm('tr', {}, [name, minVer, download])

        document.getElementById('supported-clients').appendChild(row);
    });
}

// ---------- ورود دومرحله‌ای TOTP (2FA) ----------

let totpEnabled = false;
let totpSecretCache = '';

function updateTotpUi() {
    const badge = document.getElementById('totpStatusBadge');
    const label = document.getElementById('totpActionLabel');
    const btn = document.getElementById('totpActionBtn');

    if (!badge || !label || !btn) return;

    if (totpEnabled) {
        badge.textContent = 'Enabled';
        badge.style.color = 'var(--color-icon-green, #22c55e)';
        label.textContent = 'Disable';
        btn.classList.add('delete');
    } else {
        badge.textContent = 'Disabled';
        badge.style.color = 'var(--color-icon-red, #ef4444)';
        label.textContent = 'Enable';
        btn.classList.remove('delete');
    }
}

async function initTotp() {
    try {
        const res = await fetch(`./panel/totp/status?nocache=${Date.now()}`, { cache: 'no-store' });
        const { success, body } = await res.json();

        if (!success) return;
        totpEnabled = Boolean(body?.enabled);
        updateTotpUi();
    } catch (error) {
        console.error('TOTP status error:', error);
    }
}

function closeTotpModal() {
    document.getElementById('totpModal').hidden = true;
    document.getElementById('totpError').textContent = '';
    document.getElementById('totpDisableError').textContent = '';
}

async function openTotpModal(event) {
    event?.preventDefault();

    const btn = document.getElementById('totpActionBtn');
    const icons = startWaiting(btn, '', 'clock_loader_40');

    try {
        if (totpEnabled) {
            // حالت غیرفعال‌سازی — بدون درخواست اضافه
            document.getElementById('totpSetupSection').style.display = 'none';
            document.getElementById('totpDisableSection').style.display = '';
            document.getElementById('totpModal').hidden = false;
            return;
        }

        // حالت فعال‌سازی — ساخت secret و QR
        const res = await fetch('./panel/totp/setup', { method: 'POST' });
        const { success, status, message, body } = await res.json();

        if (!success) throw new Error(`status ${status} - ${message}`);

        totpSecretCache = body.secret;
        document.getElementById('totpQrImg').src = body.qrDataUrl;
        document.getElementById('totpSecretText').textContent = body.secret;
        document.getElementById('totpEnableCode').value = '';
        document.getElementById('totpSetupSection').style.display = '';
        document.getElementById('totpDisableSection').style.display = 'none';
        document.getElementById('totpModal').hidden = false;
    } catch (error) {
        notify('error', 'Two-Factor Auth', ['Failed to start 2FA setup, please try again.']);
        console.error('TOTP setup error:', error);
    } finally {
        stopWaiting(icons);
    }
}

async function copyTotpSecret(btn) {
    try {
        await navigator.clipboard.writeText(totpSecretCache);
        notify('info', 'Two-Factor Auth', ['Secret copied to clipboard.']);
    } catch {
        notify('error', 'Two-Factor Auth', ['Clipboard unavailable — copy the code manually.']);
    }
}

async function enableTotp(btn) {
    const code = document.getElementById('totpEnableCode').value.trim();
    const errorEl = document.getElementById('totpError');

    if (!/^[0-9]{6}$/.test(code)) {
        errorEl.textContent = 'Enter the 6-digit code from your authenticator app.';
        return;
    }

    const icons = startWaiting(btn, '', 'clock_loader_40');

    try {
        const res = await fetch('./panel/totp/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });

        const { success, status, message } = await res.json();
        if (!success) throw new Error(message || `status ${status}`);

        totpEnabled = true;
        updateTotpUi();
        closeTotpModal();
        notify('success', 'Two-Factor Auth', ['2FA enabled! You will need your authenticator code on next login.']);
    } catch (error) {
        errorEl.textContent = error.message || 'Failed to enable 2FA.';
        console.error('TOTP enable error:', error);
    } finally {
        stopWaiting(icons);
    }
}

async function disableTotp(btn) {
    const code = document.getElementById('totpDisableCode').value.trim();
    const errorEl = document.getElementById('totpDisableError');

    if (!/^[0-9]{6}$/.test(code)) {
        errorEl.textContent = 'Enter the current 6-digit code to confirm.';
        return;
    }

    const confirm = await notify('confirm', 'Disable 2FA', [
        'Your panel will be protected by password only.',
        'Are you sure?'
    ]);

    if (!confirm) return;

    const icons = startWaiting(btn, '', 'clock_loader_40');

    try {
        const res = await fetch('./panel/totp/disable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });

        const { success, status, message } = await res.json();
        if (!success) throw new Error(message || `status ${status}`);

        totpEnabled = false;
        updateTotpUi();
        closeTotpModal();
        notify('success', 'Two-Factor Auth', ['2FA disabled.']);
    } catch (error) {
        errorEl.textContent = error.message || 'Failed to disable 2FA.';
        console.error('TOTP disable error:', error);
    } finally {
        stopWaiting(icons);
    }
}

// ---------- تاریخچه مصرف روزانه (نمودار SVG بدون وابستگی) ----------

const usageChartState = {
    loaded: false,
    loading: false
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
}

/** گرد کردن به بالا به عدد «خوش‌خوان» برای محور عمودی */
function niceCeil(value) {
    if (value <= 0) return 1000;
    const pow = Math.pow(10, Math.floor(Math.log10(value)));
    const unit = value / pow;
    const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
    return nice * pow;
}

function formatCompact(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 ? 1 : 0)}K`;
    return String(n);
}

function chartTooltip(anchor, text) {
    const tip = document.getElementById('usageChartTip') || document.body.appendChild(
        elm('div', { id: 'usageChartTip', className: 'usage-chart-tip' })
    );
    tip.textContent = text;
    const host = document.getElementById('usageChart');
    const hostRect = host.getBoundingClientRect();
    const barRect = anchor.getBoundingClientRect();
    tip.style.left = `${barRect.left - hostRect.left + barRect.width / 2}px`;
    tip.style.top = `${barRect.top - hostRect.top - 6}px`;
    tip.classList.add('visible');
}

function hideChartTooltip() {
    document.getElementById('usageChartTip')?.classList.remove('visible');
}

function renderUsageHistory(days, quotaDaily) {
    const host = document.getElementById('usageChart');
    if (!host) return;
    host.textContent = '';
    hideChartTooltip();

    const recorded = days.filter(Boolean);
    if (!recorded.length) {
        host.appendChild(elm('div', {
            className: 'usage-chart-empty',
            textContent: 'No history yet — open this panel daily and usage snapshots are recorded automatically.'
        }));
        return;
    }

    // ابعاد — viewBox ثابت تا ریسپانسیو با CSS کار کند
    const W = 720, H = 260;
    const PAD = { top: 14, right: 8, bottom: 26, left: 44 };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    const maxVal = Math.max(
        niceCeil(Math.max(...recorded.map(d => d.total), 1) * 1.08),
        quotaDaily * 0.8
    );
    const yFor = v => PAD.top + plotH * (1 - v / maxVal);

    const svg = svgEl('svg', {
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: 'xMidYMid meet',
        class: 'usage-chart-svg'
    });

    // خطوط راهنمای افقی + برچسب محور Y
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
        const v = maxVal * i / ySteps;
        const y = yFor(v);
        svg.appendChild(svgEl('line', {
            x1: PAD.left, x2: W - PAD.right, y1: y, y2: y,
            class: i === 0 ? 'chart-axis' : 'chart-grid'
        }));
        if (i > 0) {
            const label = svgEl('text', {
                x: PAD.left - 6, y: y + 3, class: 'chart-label-y', 'text-anchor': 'end'
            });
            label.textContent = formatCompact(v);
            svg.appendChild(label);
        }
    }

    // خط ۸۰٪ سهمیه (خط قرمز چین‌چین)
    const quotaLine = quotaDaily * 0.8;
    if (quotaLine <= maxVal) {
        svg.appendChild(svgEl('line', {
            x1: PAD.left, x2: W - PAD.right, y1: yFor(quotaLine), y2: yFor(quotaLine),
            class: 'chart-quota'
        }));
    }

    // میله‌ها — هر روز یک جفت (total پشت، worker جلو)
    const slot = plotW / days.length;
    const barW = Math.min(9, Math.max(3, slot * 0.3));
    days.forEach((day, idx) => {
        const cx = PAD.left + slot * idx + slot / 2;

        if (day) {
            const overQuota = day.total > quotaLine;
            const totalBar = svgEl('rect', {
                x: cx - barW - 0.5, y: yFor(day.total),
                width: barW, height: Math.max(1, PAD.top + plotH - yFor(day.total)),
                rx: 1.5, class: `chart-bar-total${overQuota ? ' over' : ''}`
            });
            const workerBar = svgEl('rect', {
                x: cx + 0.5, y: yFor(day.worker),
                width: barW, height: Math.max(1, PAD.top + plotH - yFor(day.worker)),
                rx: 1.5, class: 'chart-bar-worker'
            });

            const dateLabel = `${day.date} — Total: ${day.total.toLocaleString('en-US')} (${day.samples} sample${day.samples > 1 ? 's' : ''}) · Flash: ${day.worker.toLocaleString('en-US')}`;
            for (const bar of [totalBar, workerBar]) {
                bar.addEventListener('mouseenter', () => chartTooltip(bar, dateLabel));
                bar.addEventListener('mouseleave', hideChartTooltip);
            }
            svg.appendChild(totalBar);
            svg.appendChild(workerBar);
        } else {
            // روز بدون داده — نقطه کم‌رنگ پایین محور
            svg.appendChild(svgEl('circle', {
                cx, cy: PAD.top + plotH - 1.5, r: 1.5, class: 'chart-gap-dot'
            }));
        }

        // برچسب تاریخ هر ۵ روز + روز آخر
        if (idx % 5 === 0 || idx === days.length - 1) {
            const label = svgEl('text', {
                x: cx, y: H - 8, class: 'chart-label-x', 'text-anchor': 'middle'
            });
            label.textContent = (day?.date ?? '').slice(5) || '—';
            svg.appendChild(label);
        }
    });

    host.appendChild(svg);
}

async function loadUsageHistory(event, force = false) {
    event?.preventDefault();
    event?.stopPropagation();

    if (usageChartState.loading) return;
    if (usageChartState.loaded && !force) return;

    usageChartState.loading = true;
    const host = document.getElementById('usageChart');
    try {
        const nocache = Date.now();
        const res = await fetch(`./panel/usage/history?days=30&nocache=${nocache}`, { cache: 'no-store' });
        const { success, status, message, body } = await res.json();
        if (!success) throw new Error(`status ${status} - ${message}`);

        usageChartState.loaded = true;
        renderUsageHistory(body.days ?? [], body.quotaDaily ?? 100000);
    } catch (error) {
        console.error('Failed to load usage history:', error);
        if (host) {
            host.textContent = '';
            host.appendChild(elm('div', {
                className: 'usage-chart-empty',
                textContent: 'Could not load usage history.'
            }));
        }
    } finally {
        usageChartState.loading = false;
    }
}

// بارگذاری تنبل — اولین بازشدن آکاردئون
document.getElementById('usageHistoryDetails')?.addEventListener('toggle', function () {
    if (this.open) loadUsageHistory();
});
