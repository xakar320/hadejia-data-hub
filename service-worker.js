// =====================================================================
// service-worker.js — minimal PWA service worker for Hadejia Data Hub
//
// Purpose: satisfy Chrome's PWA installability criteria (manifest +
// registered service worker + HTTPS) so the site can be installed as
// an app, and so TWA-wrapping tools (PWABuilder, Bubblewrap) can
// package it for the Play Store.
//
// Deliberately conservative: this does NOT cache API responses,
// Supabase calls, or anything containing wallet/transaction/auth data
// — only a small set of static shell assets. Every page load still
// goes to the network first; the cache is purely a fallback so the
// app shell doesn't go completely blank on a flaky connection.
// =====================================================================

const CACHE_NAME = 'hdh-shell-v1';

const SHELL_ASSETS = [
  '/dashboard.html',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {
      // Non-fatal — installability doesn't require the cache step to
      // succeed, just the service worker to register.
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls, Supabase requests, or anything
  // cross-origin — only handle same-origin static shell navigation.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Keep the shell cache fresh, but only for the small known set.
        if (SHELL_ASSETS.includes(url.pathname)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/dashboard.html')))
  );
});
