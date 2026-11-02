// =====================================================================
// js/schedule-order.js — "Schedule" button for data / voice / airtime
// Each page defines window.hdhScheduleFields() which returns
//   { type, fields:{...same as the normal order body...}, summary }
// or null (bulk mode / nothing selected / invalid phone).
// PIN is checked now; the order is sent automatically at the chosen time
// and the wallet is charged then.
// =====================================================================
(function () {
    const buy = document.getElementById('buy-btn');
    if (!buy || typeof window.hdhScheduleFields !== 'function') return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'schedule-btn';
    btn.className = 'btn';
    btn.textContent = '⏰ Schedule for later';
    btn.style.cssText = 'margin-top:10px;width:100%;background:#fff;color:inherit;border:1px solid #cfd3dc;';
    buy.insertAdjacentElement('afterend', btn);

    function sync() { btn.disabled = buy.disabled; btn.style.opacity = buy.disabled ? '.5' : '1'; }
    new MutationObserver(sync).observe(buy, { attributes: true, attributeFilter: ['disabled'] });
    sync();

    function say(ok, title, message) {
        if (typeof showResultModal === 'function') showResultModal({ ok, title, message, keepSelection: true });
        else alert(title + '\n' + message);
    }

    function pad(n) { return String(n).padStart(2, '0'); }
    function localValue(d) {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function askTime(summary) {
        return new Promise((resolve) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9998;padding:16px;';
            const box = document.createElement('div');
            box.style.cssText = 'background:#fff;color:#111;border-radius:12px;padding:18px;max-width:360px;width:100%;font-size:14px;';
            const h = document.createElement('div');
            h.style.cssText = 'font-weight:700;font-size:16px;margin-bottom:6px;';
            h.textContent = 'Schedule this order';
            const p = document.createElement('div');
            p.style.cssText = 'color:#555;margin-bottom:10px;';
            p.textContent = summary;
            const inp = document.createElement('input');
            inp.type = 'datetime-local';
            const min = new Date(Date.now() + 3 * 60000);
            inp.min = localValue(min);
            inp.value = localValue(new Date(Date.now() + 60 * 60000));
            inp.style.cssText = 'width:100%;padding:10px;border:1px solid #cfd3dc;border-radius:8px;font-size:14px;box-sizing:border-box;';
            const note = document.createElement('div');
            note.style.cssText = 'color:#777;font-size:12px;margin:8px 0 12px;';
            note.textContent = 'Your wallet is charged when the order runs, so keep enough balance. You can cancel it before then in Transactions.';
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:8px;';
            const cancel = document.createElement('button');
            cancel.type = 'button'; cancel.textContent = 'Cancel';
            cancel.style.cssText = 'flex:1;padding:10px;border:1px solid #cfd3dc;border-radius:8px;background:#fff;cursor:pointer;';
            const ok = document.createElement('button');
            ok.type = 'button'; ok.textContent = 'Continue';
            ok.style.cssText = 'flex:1;padding:10px;border:0;border-radius:8px;background:#3f3fd9;color:#fff;cursor:pointer;';
            row.append(cancel, ok);
            box.append(h, p, inp, note, row);
            wrap.appendChild(box);
            document.body.appendChild(wrap);
            const done = (v) => { wrap.remove(); resolve(v); };
            cancel.onclick = () => done(null);
            ok.onclick = () => {
                const d = new Date(inp.value);
                if (!inp.value || !Number.isFinite(d.getTime()) || d.getTime() < Date.now() + 2 * 60000) {
                    note.style.color = '#c0392b';
                    note.textContent = 'Choose a time at least 2 minutes from now.';
                    return;
                }
                done(d);
            };
        });
    }

    let busy = false;
    btn.addEventListener('click', async () => {
        if (busy || btn.disabled) return;
        busy = true;
        try {
            const info = window.hdhScheduleFields();
            if (!info) return;
            const when = await askTime(info.summary);
            if (!when) return;
            const pin = await hdhRequestPin();
            if (!pin) return;
            btn.textContent = 'Scheduling…';
            const res = await fetch('/api/place-order?action=schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
                body: JSON.stringify({ type: info.type, ...info.fields, summary: info.summary, run_at: when.toISOString(), pin })
            });
            let body = {};
            try { body = await res.json(); } catch (_) { /* ignore */ }
            if (!res.ok || body.success === false) {
                throw new Error((body.error && body.error.message) || `Could not schedule (HTTP ${res.status})`);
            }
            say(true, 'Order scheduled',
                `It will be sent automatically on ${when.toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}. See it in Transactions → Scheduled.`);
        } catch (err) {
            say(false, 'Not scheduled', String(err.message).replace(/[<>&]/g, ''));
        } finally {
            btn.textContent = '⏰ Schedule for later';
            busy = false;
            sync();
        }
    });
})();
