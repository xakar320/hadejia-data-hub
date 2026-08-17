// =====================================================================
// js/nav.js — shared hamburger navigation drawer
// Drop this + css/nav.css into any page (after js/supabase.js) and it
// injects a hamburger button + slide-in menu automatically. No HTML
// markup changes needed on the page itself.
// =====================================================================

// -------------------------------------------------------------------
// FILL THESE IN when you have them — leave blank to hide that option
// in the Contact Support popup.
// -------------------------------------------------------------------
const HDH_SUPPORT_WHATSAPP = '2347045102222';   // e.g. '2348012345678' (no + or spaces)
const HDH_SUPPORT_EMAIL = 'hadejiadatahub@gmail.com';      // e.g. 'support@hadejiadatahub.com'

const HDH_NAV_LINKS = [
    { href: 'dashboard.html',   icon: '🏠', label: 'Dashboard' },
    { href: 'fund-wallet.html', icon: '💰', label: 'Fund Wallet' },
    { href: 'data.html',        icon: '📶', label: 'Buy Data' },
    { href: 'airtime.html',     icon: '📱', label: 'Buy Airtime' },
    { href: 'voice.html',       icon: '☎️', label: 'Buy Voice Bundle' },
    { href: 'cable.html',       icon: '📺', label: 'Cable TV' },
    { href: 'electricity.html', icon: '⚡', label: 'Electricity' },
    { href: 'transactions.html',icon: '🧾', label: 'Transaction History' },
    { href: 'profile.html',     icon: '👤', label: 'Profile' }
];

function hdhBuildNav() {
    // Toggle button
    const toggle = document.createElement('button');
    toggle.id = 'hdh-nav-toggle';
    toggle.setAttribute('aria-label', 'Open menu');
    toggle.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2.5 5.5H17.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M2.5 10H17.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M2.5 14.5H17.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
    `;
    document.body.appendChild(toggle);

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.id = 'hdh-nav-backdrop';
    document.body.appendChild(backdrop);

    // Drawer
    const drawer = document.createElement('div');
    drawer.id = 'hdh-nav-drawer';

    const currentPage = location.pathname.split('/').pop() || 'index.html';

    const linksHtml = HDH_NAV_LINKS.map(link => `
        <a class="hdh-nav-link${link.href === currentPage ? ' active' : ''}" href="${link.href}">
            <span class="icon">${link.icon}</span>
            <span>${link.label}</span>
        </a>
    `).join('');

    drawer.innerHTML = `
        <div class="hdh-nav-header">
            <div class="brand">Hadejia Data Hub</div>
            <div class="user-email" id="hdh-nav-user-email">Loading…</div>
        </div>
        <nav>
            ${linksHtml}
            <div class="hdh-nav-divider"></div>
            <a class="hdh-nav-link" href="#" id="hdh-nav-support-link">
                <span class="icon">💬</span>
                <span>Contact Support</span>
            </a>
        </nav>
        <div class="hdh-nav-footer">
            <button class="hdh-nav-logout" id="hdh-nav-logout-btn">Logout</button>
        </div>
    `;
    document.body.appendChild(drawer);

    // Support modal
    const supportBackdrop = document.createElement('div');
    supportBackdrop.id = 'hdh-support-backdrop';
    supportBackdrop.innerHTML = `
        <div id="hdh-support-modal">
            <h3>Contact Support</h3>
            <p>Need help with a transaction or your account? Reach us here:</p>
            <div id="hdh-support-options"></div>
            <button class="hdh-support-close" id="hdh-support-close-btn">Close</button>
        </div>
    `;
    document.body.appendChild(supportBackdrop);

    // ---- open/close behavior ----
    function openDrawer() {
        drawer.classList.add('open');
        backdrop.classList.add('open');
    }
    function closeDrawer() {
        drawer.classList.remove('open');
        backdrop.classList.remove('open');
    }

    toggle.addEventListener('click', openDrawer);
    backdrop.addEventListener('click', closeDrawer);

    // ---- logout ----
    document.getElementById('hdh-nav-logout-btn').addEventListener('click', async () => {
        if (typeof client !== 'undefined') {
            await client.auth.signOut();
        }
        location.href = 'index.html';
    });

    // ---- contact support ----
    document.getElementById('hdh-nav-support-link').addEventListener('click', (e) => {
        e.preventDefault();
        closeDrawer();

        const optionsBox = document.getElementById('hdh-support-options');
        optionsBox.innerHTML = '';

        if (HDH_SUPPORT_WHATSAPP) {
            const a = document.createElement('a');
            a.className = 'hdh-support-row';
            a.href = `https://wa.me/${HDH_SUPPORT_WHATSAPP}`;
            a.target = '_blank';
            a.innerHTML = `<span>💬</span><span>Chat on WhatsApp</span>`;
            optionsBox.appendChild(a);
        }

        if (HDH_SUPPORT_EMAIL) {
            const a = document.createElement('a');
            a.className = 'hdh-support-row';
            a.href = `mailto:${HDH_SUPPORT_EMAIL}`;
            a.innerHTML = `<span>✉️</span><span>${HDH_SUPPORT_EMAIL}</span>`;
            optionsBox.appendChild(a);
        }

        if (!HDH_SUPPORT_WHATSAPP && !HDH_SUPPORT_EMAIL) {
            const p = document.createElement('p');
            p.style.cssText = 'font-size:13px;color:#4A564E;';
            p.textContent = 'Support contact details have not been set up yet.';
            optionsBox.appendChild(p);
        }

        supportBackdrop.classList.add('open');
    });

    document.getElementById('hdh-support-close-btn').addEventListener('click', () => {
        supportBackdrop.classList.remove('open');
    });
    supportBackdrop.addEventListener('click', (e) => {
        if (e.target.id === 'hdh-support-backdrop') supportBackdrop.classList.remove('open');
    });

    // ---- fill in the current user's email once we know it ----
    if (typeof client !== 'undefined') {
        client.auth.getSession().then(({ data }) => {
            const emailEl = document.getElementById('hdh-nav-user-email');
            if (data && data.session && data.session.user) {
                emailEl.textContent = data.session.user.email || '';
            } else {
                emailEl.textContent = '';
            }
        });
    }
}

window.addEventListener('load', hdhBuildNav);
