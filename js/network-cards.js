// =====================================================================
// js/network-cards.js — turns the network buttons (MTN / GLO / AIRTEL)
// inside #network-tabs into cards with the network logo. It decorates
// buttons automatically whenever the page draws them, so the page's own
// script does not need to change. Logos: images/net-<name>.png
// =====================================================================
(function () {
    const tabs = document.getElementById('network-tabs');
    if (!tabs) return;

    const NET = {
        mtn:    { logo: 'images/net-mtn.png',    color: '#ffcc00' },
        glo:    { logo: 'images/net-glo.png',    color: '#00a651' },
        airtel: { logo: 'images/net-airtel.png', color: '#e4002b' },
        '9mobile': { logo: 'images/net-9mobile.png', color: '#8bb43a' }   // add images/net-9mobile.png to show a logo
    };
    const FALLBACK = { logo: null, color: '#8a93a6' };

    const st = document.createElement('style');
    st.textContent = `
    #network-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
    #network-tabs button.net-card{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;
      padding:10px 4px 8px;border-radius:14px;border:2px solid #e2dccf;border-top:4px solid var(--net,#ccc);
      background:#fff;color:#141c19;font-weight:700;font-size:13px;cursor:pointer;min-width:0}
    #network-tabs button.net-card .net-badge{width:40px;height:40px;border-radius:50%;background:#e9edf3;color:#34415a;
      display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;box-shadow:0 1px 4px rgba(0,0,0,.18)}
    #network-tabs button.net-card img{width:40px;height:40px;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.18)}
    #network-tabs button.net-card.active{background:#eef3ff;border-color:#2a5bd7;border-top-color:var(--net,#2a5bd7);color:#141c19}
    #network-tabs button.net-card.active::after{content:"\u2713";position:absolute;top:-8px;right:-4px;width:18px;height:18px;
      border-radius:50%;background:#2a5bd7;color:#fff;font-size:11px;line-height:18px;text-align:center}`;
    document.head.appendChild(st);

    function badge(name) {
        const d = document.createElement('div');
        d.className = 'net-badge';
        d.textContent = name.trim().charAt(0).toUpperCase();
        return d;
    }

    function decorate() {
        const buttons = tabs.querySelectorAll('button');
        buttons.forEach((btn) => {
            if (btn.classList.contains('net-card')) return;
            const raw = btn.textContent;               // keep raw text: the page's own comparisons still match
            const lname = raw.trim().toLowerCase();
            const key = Object.keys(NET).find((k) => lname.includes(k));
            const meta = key ? NET[key] : FALLBACK;
            btn.classList.add('net-card');
            btn.style.setProperty('--net', meta.color);
            btn.textContent = '';
            let pic;
            if (meta.logo) {
                pic = document.createElement('img');
                pic.alt = '';
                pic.onerror = () => pic.replaceWith(badge(raw));
                pic.src = meta.logo;
            } else {
                pic = badge(raw);
            }
            const label = document.createElement('span');
            label.textContent = raw;
            btn.append(pic, label);
        });
        const n = buttons.length;
        if (n) tabs.style.gridTemplateColumns = `repeat(${Math.min(n, 4)},minmax(0,1fr))`;
    }

    new MutationObserver(decorate).observe(tabs, { childList: true });
    decorate();
})();
