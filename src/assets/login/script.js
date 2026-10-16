document.getElementById('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.getElementById('username').value.trim().toLowerCase();
    const password = document.getElementById('password').value.trim();
    const totpInput = document.getElementById('totp');
    const totpCode = totpInput ? totpInput.value.trim() : '';

    const body = { username, password };
    if (totpCode) body.totp = totpCode;

    try {
        const response = await fetch('./login/authenticate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const { success, status, message } = await response.json();
        if (!success) {
            const passwordError = document.getElementById('passwordError');
            passwordError.textContent = '⚠️ ' + (message || 'Wrong Credentials.');
            throw new Error(`Login failed with status ${status}: ${message}`);
        }

        window.location.href = './panel';
    } catch (error) {
        console.error('Login error:', error.message || error);
    }
});

// نمایش فیلد کد دومرحله‌ای فقط وقتی 2FA فعاله
(async () => {
    try {
        const res = await fetch('./login/totp-status', { cache: 'no-store' });
        const { success, body } = await res.json();

        if (success && body?.enabled) {
            const container = document.getElementById('totpContainer');
            container.style.display = '';

            const input = document.getElementById('totp');
            input.setAttribute('required', '');
            input.focus();
        }
    } catch {
        // خطا در دریافت وضعیت → فیلد مخفی می‌مونه (رفتار قدیمی)
    }
})();

document.getElementById('togglePassword').addEventListener('click', function () {
    const passwordInput = document.getElementById('password');
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    this.textContent = isPassword ? 'visibility_off' : 'visibility';
});
