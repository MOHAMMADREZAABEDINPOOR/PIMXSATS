'use client';

import { useEffect } from 'react';

// Registers the service worker that precaches the app shell, the bundled
// satellite catalog, and all textures — so repeat visits start instantly and
// work on a weak or absent connection. Registration is silent and best-effort;
// a browser without service-worker support just falls back to normal loading.
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;

    const register = () => {
      navigator.serviceWorker.register('/sw.js').then(
        (reg) => {
          // If a new worker takes over, activate it immediately so an updated
          // catalog/asset set is picked up on the next load.
          reg.addEventListener('updatefound', () => {
            const sw = reg.installing;
            if (!sw) return;
            sw.addEventListener('statechange', () => {
              if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                sw.postMessage('SKIP_WAITING');
              }
            });
          });
        },
        () => { /* registration failed — non-fatal */ }
      );
    };

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }, []);

  return null;
}
