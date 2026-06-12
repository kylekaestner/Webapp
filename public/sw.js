self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'CrewSync';
    const options = {
        body: data.body || '',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url: data.url || '/app?view=overlap' },
        tag: data.tag || 'crewsync',
        renotify: true,
    };
    event.waitUntil(
        self.registration.showNotification(title, options).then(() => {
            if ('setAppBadge' in self.navigator) {
                self.navigator.setAppBadge(data.unreadCount || 1).catch(() => {});
            }
        })
    );
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = event.notification.data?.url || '/app?view=overlap';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            for (const client of clientList) {
                if ('focus' in client) {
                    return client.focus().then(c => {
                        c.postMessage({ type: 'OPEN_OVERLAP' });
                        return c;
                    });
                }
            }
            return self.clients.openWindow(url);
        })
    );
});
