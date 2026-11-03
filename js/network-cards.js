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
        airtel: { logo: 'images/net-airtel.png', color: '#e4002b' }
    };

    const st = document.createElement('style');
    st.textContent = `
    #network-tabs{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:10px}
    #network-tabs button.net-card{position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;
      padding:14px 6px 10px;border-radius:14px;border:2px solid #e2dccf;border-top:5px solid var(--net,#ccc);
      background:#fff;color:#141c19;font-weight:700;font-size:14px;cursor:pointer}
    #network-tabs button.net-card img{width:56px;height:56px;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.18)}
    #network-tabs button.net-card.active{background:#eef3ff;border-color:#2a5bd7;border-top-color:var(--net,#2a5bd7);color:#141c19}
    #network-tabs button.net-card.active::after{content:"\\u2713";position:absolute;top:-10px;right:-6px;width:22px;height:22px;
      border-radius:50%;background:#2a5bd7;color:#fff;font-size:13px;line-height:22px;text-align:center}`;
    document.head.appendChild(st);

    function decorate() {
        tabs.querySelectorAll('button').forEach((btn) => {
            if (btn.classList.contains('net-card')) return;
            const name = btn.textContent.trim();
            const meta = NET[name.toLowerCase()];
            if (!meta) return;
            btn.classList.add('net-card');
            btn.style.setProperty('--net', meta.color);
            const img = document.createElement('img');
            img.src = meta.logo;
            img.alt = '';
            const label = document.createElement('span');
            label.textContent = name;
            btn.textContent = '';
            btn.append(img, label);
        });
    }

    new MutationObserver(decorate).observe(tabs, { childList: true });
    decorate();
})();
