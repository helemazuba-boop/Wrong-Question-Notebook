self.addEventListener('push', event => {
  let message;
  try {
    message = event.data.json();
  } catch {
    return;
  }
  if (!message || typeof message.id !== 'string') return;
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      tag: `todo-reminder-${message.id}`,
      data: { url: '/todos' },
    })
  );
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/todos'));
});
