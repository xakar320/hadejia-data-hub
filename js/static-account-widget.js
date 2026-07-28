// =====================================================================
// js/static-account-widget.js — permanent virtual account on dashboard
// Add this AFTER js/supabase.js on dashboard.html. Injects a card
// showing the user's permanent SecureWaveNG account number, or a
// "set up" prompt (with BVN collection) if they don't have one yet.
// No HTML markup changes needed on the page.
// =====================================================================

(function () {
    const STYLE = `
        #hdh-sa-card{background:#2F6E62;color:#fff;border-radius:10px;padding:18px;margin:0 0 16px;font-family:'IBM Plex Sans',sans-serif;}
        #hdh-sa-card .hdh-sa-label{font-size:12px;text-transform:uppercase;letter-spacing:.04em;opacity:.85;}
        #hdh-sa-card .hdh-sa-number{font-family:'IBM Plex Mono',monospace;font-size:22px;font-weight:600;margin:6px 0 2px;}
        #hdh-sa-card .hdh-sa-bank{font-size:13px;opacity:.9;}
        #hdh-sa-card .hdh-sa-hint{font-size:11px;opacity:.75;margin-top:8px;}
        #hdh-sa-setup-btn{width:100%;background:rgba(255,255,255,.18);color:#fff;border:none;border-radius:8px;padding:12px;font-size:14px;font-weight:600;margin-top:4px;cursor:pointer;}
        #hdh-sa-backdrop{position:fixed;inset:0;background:rgba(20,32,28,.6);z-index:1002;display:none;align-items:center;justify-content:center;padding:20px;}
        #hdh-sa-backdrop.open{display:flex;}
        #hdh-sa-modal{background:#FAF6EC;border-radius:10px;max-width:360px;width:100%;padding:22px;font-family:'IBM Plex Sans',sans-serif;color:#14201C;}
        #hdh-sa-modal h3{font-family:'Fraunces',serif;font-size:18px;margin:0 0 10px;}
        #hdh-sa-modal p{font-size:13px;color:#4A564E;margin:0 0 14px;line-height:1.5;}
        #hdh-sa-modal label{display:block;font-size:12px;font-weight:600;color:#4A564E;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;}
        #hdh-sa-modal input{width:100%;padding:11px 12px;border:1px solid #DED4BC;border-radius:8px;font-size:15px;margin-bottom:14px;}
        #hdh-sa-modal button.submit{width:100%;background:#26355C;color:#fff;border:none;border-radius:8px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;}
        #hdh-sa-modal button.close{background:none;border:none;float:right;font-size:16px;color:#4A564E;cursor:pointer;}
        #hdh-sa-error{color:#A8382E;font-size:12px;margin:-8px 0 12px;display:none;}
    `;

    function injectStyle() {
        const style = document.createElement('style');
        style.textContent = STYLE;
        document.head.appendChild(style);
    }

    function findMountPoint() {
        // Try to mount right after a wallet balance element if the page
        // has one (common id/class names), otherwise just prepend to body.
        return (
            document.getElementById('wallet-balance-card') ||
            document.querySelector('.balance-card') ||
            document.body.firstElementChild ||
            document.body
        );
    }

    function renderAccountCard(account) {
        const card = document.createElement('div');
        card.id = 'hdh-sa-card';
        card.innerHTML = `
            <div class="hdh-sa-label">Your Permanent Account Number</div>
            <div class="hdh-sa-number" id="hdh-sa-number">${account.accountNumber}</div>
            <div class="hdh-sa-bank">${account.bankName}${account.accountName ? ' · ' + account.accountName : ''}</div>
            <div class="hdh-sa-hint">Transfer any amount here, anytime — it lands in your wallet automatically.</div>
        `;
        card.addEventListener('click', () => {
            navigator.clipboard.writeText(account.accountNumber).then(() => {
                showToastFallback('Account number copied');
            }).catch(() => {});
        });
        card.style.cursor = 'pointer';
        insertCard(card);
    }

    function renderSetupPrompt() {
        const card = document.createElement('div');
        card.id = 'hdh-sa-card';
        card.innerHTML = `
            <div class="hdh-sa-label">Get a Permanent Account Number</div>
            <div style="font-size:13px;margin-top:6px;opacity:.9;">
                Set this up once and you'll be able to fund your wallet anytime by
                transferring to your own dedicated account number.
            </div>
            <button id="hdh-sa-setup-btn">Set Up Now</button>
        `;
        insertCard(card);

        document.getElementById('hdh-sa-setup-btn').addEventListener('click', openBvnModal);
    }

    function insertCard(card) {
        const mount = findMountPoint();
        mount.parentNode.insertBefore(card, mount);
    }

    function openBvnModal() {
        const backdrop = document.createElement('div');
        backdrop.id = 'hdh-sa-backdrop';
        backdrop.innerHTML = `
            <div id="hdh-sa-modal">
                <button class="close" id="hdh-sa-close-btn">✕</button>
                <h3>Set Up Permanent Account</h3>
                <p>
                    We use your BVN to verify your identity with our banking partner
                    and create your dedicated account number. Your BVN is sent
                    securely and is not stored on our servers.
                </p>
                <label for="hdh-sa-bvn-input">BVN (11 digits)</label>
                <input type="tel" id="hdh-sa-bvn-input" maxlength="11" placeholder="22152761259">
                <div id="hdh-sa-error"></div>
                <button class="submit" id="hdh-sa-submit-btn">Verify & Create Account</button>
            </div>
        `;
        document.body.appendChild(backdrop);
        requestAnimationFrame(() => backdrop.classList.add('open'));

        document.getElementById('hdh-sa-close-btn').addEventListener('click', () => backdrop.remove());
        backdrop.addEventListener('click', (e) => { if (e.target.id === 'hdh-sa-backdrop') backdrop.remove(); });

        document.getElementById('hdh-sa-submit-btn').addEventListener('click', async () => {
            const bvn = document.getElementById('hdh-sa-bvn-input').value.trim();
            const errBox = document.getElementById('hdh-sa-error');
            errBox.style.display = 'none';

            if (!/^\d{11}$/.test(bvn)) {
                errBox.textContent = 'BVN must be exactly 11 digits.';
                errBox.style.display = 'block';
                return;
            }

            const btn = document.getElementById('hdh-sa-submit-btn');
            btn.disabled = true;
            btn.textContent = 'Verifying…';

            try {
                const { data: { session } } = await client.auth.getSession();
                const res = await fetch('/api/static-account-init', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${session.access_token}`
                    },
                    body: JSON.stringify({ bvn })
                });

                let body;
                try {
                    body = await res.json();
                } catch (e) {
                    throw new Error(`Server error (HTTP ${res.status}). Please try again shortly.`);
                }

                if (!res.ok || body.success === false) {
                    throw new Error((body.error && body.error.message) || 'Could not create account. Please try again.');
                }

                backdrop.remove();
                document.getElementById('hdh-sa-card').remove();
                renderAccountCard(body.data);
                showToastFallback('Permanent account created!');

            } catch (err) {
                errBox.textContent = err.message;
                errBox.style.display = 'block';
            } finally {
                btn.disabled = false;
                btn.textContent = 'Verify & Create Account';
            }
        });
    }

    function showToastFallback(msg) {
        // Use the shared toast container from nav.js/voice.js if present,
        // otherwise fall back to a plain alert so feedback is never silent.
        const wrap = document.getElementById('toast-wrap');
        if (wrap) {
            const t = document.createElement('div');
            t.style.cssText = 'background:#14201C;color:#fff;padding:12px 16px;border-radius:8px;font-size:13px;text-align:center;';
            t.textContent = msg;
            wrap.appendChild(t);
            setTimeout(() => t.remove(), 3500);
        } else {
            alert(msg);
        }
    }

    async function init() {
        const { data: { session } } = await client.auth.getSession();
        if (!session) return; // dashboard.js's own guard handles the redirect

        injectStyle();

        const { data: account, error } = await client
            .from('dynamic_accounts')
            .select('account_number, bank_name, account_name')
            .eq('user_id', session.user.id)
            .eq('provider', 'securewaveng')
            .eq('account_type', 'static')
            .eq('is_active', true)
            .maybeSingle();

        if (error) {
            console.error('[static-account-widget]', error);
            return;
        }

        if (account) {
            renderAccountCard({
                accountNumber: account.account_number,
                bankName: account.bank_name,
                accountName: account.account_name
            });
        } else {
            renderSetupPrompt();
        }
    }

    window.addEventListener('load', init);
})();
