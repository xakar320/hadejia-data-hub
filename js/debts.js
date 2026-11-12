// =====================================================================
// js/debts.js — the customer's own "Debts Book".
// Everything goes through /api/place-order?action=debt-* which is scoped
// to the signed-in user, so nobody can see another person's book.
// =====================================================================
let session = null;
let status = 'open';
let searchTimer = null;

const $ = (s) => document.querySelector(s);
const money = (n) => Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function toast(msg, type = 'ok') {
    const t = document.createElement('div');
    t.className = `toast ${type === 'ok' ? 'ok' : 'err'}`;
    t.textContent = msg;
    $('#toast-wrap').appendChild(t);
    setTimeout(() => t.remove(), 4200);
}

async function api(action, payload) {
    const res = await fetch(`/api/place-order?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify(payload || {})
    });
    let body = {};
    try { body = await res.json(); } catch (_) { /* ignore */ }
    if (!res.ok || body.success === false) {
        throw new Error((body.error && body.error.message) || `Request failed (HTTP ${res.status})`);
    }
    return body.data;
}

function div(cls, text) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
}

function btn(label, cls, onclick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = onclick;
    return b;
}

async function load() {
    const list = $('#d-list');
    list.textContent = '';
    list.appendChild(div('empty', 'Loading…'));
    try {
        const data = await api('debt-list', { status, search: $('#d-search').value });
        list.textContent = '';
        if (status !== 'paid' && !$('#d-search').value.trim()) $('#d-total').textContent = `₦${money(data.totalOwed)}`;
        if (!data.rows.length) { list.appendChild(div('empty', 'No debts here.')); return; }

        data.rows.forEach((r) => {
            const card = div('d-item');
            const row = div('d-row');

            const left = div('');
            left.appendChild(div('d-title', `${r.name ? r.name + ' · ' : ''}0${r.phone}`));
            left.appendChild(div('d-sub', [r.item, new Date(r.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })].filter(Boolean).join(' · ')));
            if (r.note) left.appendChild(div('d-sub', r.note));

            const right = div('');
            right.appendChild(div(r.status === 'paid' ? 'd-owed paid' : 'd-owed', r.status === 'paid' ? 'Paid' : `₦${money(r.balance)}`));
            right.appendChild(div('d-sub', `of ₦${money(r.amount)}`)).style.textAlign = 'right';

            row.append(left, right);
            card.appendChild(row);

            const actions = div('d-actions');
            if (r.status === 'open') {
                actions.appendChild(btn('Mark as paid', 'primary', async () => {
                    if (!confirm(`Mark the full ₦${money(r.balance)} as paid?`)) return;
                    try { await api('debt-pay', { id: r.id }); toast('Marked as paid'); load(); } catch (e) { toast(e.message, 'err'); }
                }));
                actions.appendChild(btn('Part payment', '', async () => {
                    const v = prompt(`Part payment received (still owed ₦${money(r.balance)}):`);
                    if (!v) return;
                    try { await api('debt-pay', { id: r.id, amount: v }); toast('Payment recorded'); load(); } catch (e) { toast(e.message, 'err'); }
                }));
            }
            actions.appendChild(btn('Delete', '', async () => {
                if (!confirm('Delete this record?')) return;
                try { await api('debt-delete', { id: r.id }); toast('Deleted'); load(); } catch (e) { toast(e.message, 'err'); }
            }));
            card.appendChild(actions);
            list.appendChild(card);
        });
    } catch (err) {
        list.textContent = '';
        list.appendChild(div('empty', err.message));
    }
}

async function init() {
    const { data: { session: s } } = await client.auth.getSession();
    if (!s) { location.href = 'index.html'; return; }
    session = s;

    $('#d-save').addEventListener('click', async () => {
        const b = $('#d-save');
        b.disabled = true;
        try {
            await api('debt-add', {
                phone: $('#d-phone').value, name: $('#d-name').value, item: $('#d-item').value,
                amount: $('#d-amount').value, note: $('#d-note').value
            });
            ['#d-phone', '#d-name', '#d-item', '#d-amount', '#d-note'].forEach((id) => { $(id).value = ''; });
            toast('Debt saved');
            load();
        } catch (e) {
            toast(e.message, 'err');
        } finally {
            b.disabled = false;
        }
    });

    $('#d-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 350); });

    $('#d-tabs').addEventListener('click', (e) => {
        const t = e.target.closest('button[data-s]');
        if (!t) return;
        status = t.dataset.s;
        document.querySelectorAll('#d-tabs button').forEach((x) => x.classList.toggle('active', x === t));
        load();
    });

    load();
}

init();
