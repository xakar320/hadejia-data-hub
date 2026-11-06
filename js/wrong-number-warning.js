// =====================================================================
// js/wrong-number-warning.js — on the Data / Voice / Airtime pages.
// When the customer types a number that he earlier marked (in
// Transactions) as the number an order was MEANT for, show a notice so
// he does not pay twice. Single-number input only. Relies on the global
// `client` from js/supabase.js; RLS limits the lookup to his own rows.
// =====================================================================
(function () {
    const input = document.getElementById('phone-input');
    if (!input || typeof client === 'undefined') return;

    const box = document.createElement('div');
    box.style.cssText = 'display:none;margin-top:8px;padding:10px 12px;border-radius:10px;background:#fff4e0;border:1px solid #f0c987;color:#7a4a00;font-size:13px;line-height:1.4;';
    input.insertAdjacentElement('afterend', box);

    let timer = null;
    let lastKey = '';

    async function check() {
        const digits = input.value.replace(/\D/g, '');
        const last10 = digits.slice(-10);
        if (last10.length < 10) { box.style.display = 'none'; lastKey = ''; return; }
        if (last10 === lastKey) return;
        lastKey = last10;

        try {
            const { data: { session } } = await client.auth.getSession();
            if (!session) return;
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
