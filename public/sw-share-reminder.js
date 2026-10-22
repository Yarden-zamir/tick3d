// The service worker imports this file (workbox.importScripts in vite.config.ts).
// A tap on the reminder of /share (src/share/reminder.ts) focuses the tab of /share, or opens it.
self.addEventListener('notificationclick', (event) => {
  if (event.notification.tag !== 'tick3d-share-wait') return;
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
      const tab = tabs.find((each) => new URL(each.url).pathname === '/share');
      return tab === undefined ? self.clients.openWindow('/share') : tab.focus();
    }),
  );
});
