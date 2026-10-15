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
      data: { url: message.url === '/en/todos' ? '/en/todos' : '/todos' },
    })
  );
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(
      event.notification.data?.url === '/en/todos' ? '/en/todos' : '/todos'
    )
  );
});
