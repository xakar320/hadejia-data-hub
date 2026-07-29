// =====================================================================
// js/pin-modal.js — shared transaction PIN entry modal
// Include on any purchase page. Call `await hdhRequestPin()` right
// before submitting a purchase — it resolves with the entered PIN
// string, or null if the customer cancels. Fully self-contained
// (injects its own markup/styles on demand), so it never conflicts
// with a page's existing modals.
// =====================================================================

function hdhRequestPin() {
    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.style.cssText = `
            position:fixed;inset:0;background:rgba(20,32,28,.6);z-index:1003;
            display:flex;align-items:center;justify-content:center;padding:20px;
        `;

        backdrop.innerHTML = `
            <div style="background:#FAF6EC;border-radius:10px;max-width:320px;width:100%;padding:24px;font-family:'IBM Plex Sans',sans-serif;color:#14201C;text-align:center;">
                <div style="font-size:32px;margin-bottom:8px;">🔒</div>
                <h3 style="font-family:'Fraunces',serif;font-size:18px;margin:0 0 6px;">Enter Transaction PIN</h3>
                <p style="font-size:13px;color:#4A564E;margin:0 0 18px;">Confirm this purchase with your PIN.</p>
                <input
                    id="hdh-pin-input"
                    type="password"
                    inputmode="numeric"
                    maxlength="6"
                    autocomplete="off"
                    style="width:100%;text-align:center;letter-spacing:.5em;font-size:22px;padding:12px;border:1px solid #DED4BC;border-radius:8px;margin-bottom:10px;font-family:'IBM Plex Mono',monospace;"
                    placeholder="••••"
                >
                <div id="hdh-pin-error" style="color:#A8382E;font-size:12px;min-height:16px;margin-bottom:10px;"></div>
                <button id="hdh-pin-confirm-btn" style="width:100%;background:#26355C;color:#fff;border:none;border-radius:8px;padding:12px;font-size:14px;font-weight:600;margin-bottom:8px;cursor:pointer;">Confirm</button>
                <button id="hdh-pin-cancel-btn" style="width:100%;background:none;color:#4A564E;border:none;padding:8px;font-size:13px;cursor:pointer;">Cancel</button>
            </div>
        `;

        document.body.appendChild(backdrop);

        const input = backdrop.querySelector('#hdh-pin-input');
        const errorBox = backdrop.querySelector('#hdh-pin-error');
        input.focus();

        function cleanup(result) {
            backdrop.remove();
            resolve(result);
        }

        function submit() {
            const pin = input.value.trim();
            if (!/^\d{4,6}$/.test(pin)) {
                errorBox.textContent = 'Enter a valid 4-6 digit PIN';
                return;
            }
            cleanup(pin);
        }

        backdrop.querySelector('#hdh-pin-confirm-btn').addEventListener('click', submit);
        backdrop.querySelector('#hdh-pin-cancel-btn').addEventListener('click', () => cleanup(null));
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(null); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        input.addEventListener('input', () => { errorBox.textContent = ''; });
    });
}
