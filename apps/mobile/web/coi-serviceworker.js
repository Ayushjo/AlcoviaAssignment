/**
 * Cross-Origin Isolation Service Worker
 * Intercepts every fetch and adds COOP/COEP headers so SharedArrayBuffer
 * (required by expo-sqlite WASM / wa-sqlite) is available in any browser.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  // Skip non-GET or opaque requests that can't be cloned
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Don't touch opaque (cross-origin no-cors) responses
        if (!response || response.status === 0 || response.type === 'opaque') return response;

        const newHeaders = new Headers(response.headers);
        newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
        newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
        newHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      })
      .catch(() => fetch(event.request)) // fall back to normal fetch on error
  );
});
