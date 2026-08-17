// =====================================================================
// js/pwa-register.js — registers the service worker for PWA/TWA
// installability. Safe no-op in browsers without service worker
// support, and safe to include on every page.
// =====================================================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js').catch((err) => {
            console.error('Service worker registration failed:', err);
        });
    });
}
