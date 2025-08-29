// public/sw.js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Focus/open the app if the user taps a notification
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const url = new URL('/', self.location.origin).href;
    for (const c of all) {
      if (c.url === url && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('/');
  })());
});
