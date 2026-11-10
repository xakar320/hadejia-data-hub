// =====================================================================
// js/wrong-number-warning.js — on the Data / Voice / Airtime pages.
// When the customer types a number that he earlier marked (in
// Transactions) as the number an order was MEANT for, show a notice so
// he does not pay twice. Also (admin only) warns when the typed number
// has an open debt in the Debts book. Single-number input only. Relies on the global
// `client` from js/supabase.js; RLS limits the lookup to his own rows.
// =====================================================================
(function () {
    const input = document.getElementById('phone-input');
    if (!input || typeof client === 'undefined') return;

    const box = document.createElement('div');
    box.style.cssText = 'display:none;margin-top:8px;padding:10px 12px;border-radius:10px;background:#fff4e0;border:1px solid #f0c987;color:#7a4a00;font-size:13px;line-height:1.4;';
    input.insertAdjacentElement('afterend', box);

    const debtBox = document.createElement('div');
    debtBox.style.cssText = 'display:none;margin-top:8px;padding:10px 12px;border-radius:10px;background:#fdecea;border:1px solid #f1a9a0;color:#8a1c12;font-size:13px;line-height:1.4;';
    box.insertAdjacentElement('afterend', debtBox);

    async function checkDebt(session, last10) {
        try {
            const res = await fetch('/api/place-order?action=debt-check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
                body: JSON.stringify({ phone: last10 })
            });
            const body = await res.json().catch(() => ({}));
            const d = body && body.data;
            if (!res.ok || !d || !d.debts || d.debts.length === 0) { debtBox.style.display = 'none'; return; }
            debtBox.textContent = '';
            const head = document.createElement('div');
            head.style.fontWeight = '700';
            head.textContent = `💰 This number owes you ₦${Number(d.total).toLocaleString('en-NG')}`;
            debtBox.appendChild(head);
            d.debts.forEach((x) => {
                const line = document.createElement('div');
                const when = new Date(x.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' });
                line.textContent = `${when}: ${x.item || 'credit'} — ₦${Number(x.balance).toLocaleString('en-NG')}${x.name ? ' (' + x.name + ')' : ''}`;
                debtBox.appendChild(line);
            });
            debtBox.style.display = 'block';
        } catch (e) {
            debtBox.style.display = 'none';
        }
    }

    let timer = null;
    let lastKey = '';

    async function check() {
        const digits = input.value.replace(/\D/g, '');
        const last10 = digits.slice(-10);
        if (last10.length < 10) { box.style.display = 'none'; debtBox.style.display = 'none'; lastKey = ''; return; }
        if (last10 === lastKey) return;
        lastKey = last10;

        try {
            const { data: { session } } = await client.auth.getSession();
            if (!session) return;
            checkDebt(session, last10);
            const { data, error } = await client
                .from('transactions')
                .select('type, amount, recipient, created_at')
                .eq('user_id', session.user.id)
                .eq('status', 'success')
                .ilike('request_payload->>intendedPhone', `%${last10}`)
                .order('created_at', { ascending: false })
                .limit(3);
            if (error || !data || data.length === 0) { box.style.display = 'none'; return; }

            box.textContent = '';
            const head = document.createElement('div');
            head.style.fontWeight = '700';
            head.textContent = '⚠ You already bought for this number by mistake';
            box.appendChild(head);
            data.forEach((t) => {
                const line = document.createElement('div');
                const when = new Date(t.created_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
                line.textContent = `${when}: ₦${Number(t.amount).toLocaleString('en-NG')} ${t.type} was sent to ${t.recipient} instead.`;
                box.appendChild(line);
            });
            const tip = document.createElement('div');
            tip.style.marginTop = '4px';
            tip.textContent = 'Check Transactions before buying again, so you do not pay twice.';
            box.appendChild(tip);
            box.style.display = 'block';
        } catch (e) {
            box.style.display = 'none';
        }
    }

    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(check, 400);
    });
})();
