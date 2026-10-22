// The browser notification at the end of the wait on /share ("Remind me").
import { setupPwa } from '../pwa.ts';

// none: no Notification API (iOS Safari outside an installed web app, or plain HTTP). ask: the browser asks on the tap.
export type ReminderSupport = 'none' | 'ask' | 'denied' | 'granted';

export function reminderSupport(): ReminderSupport {
  if (typeof Notification === 'undefined') return 'none';
  return Notification.permission === 'default' ? 'ask' : Notification.permission;
}

// Asks for the permission. Call it only from a tap: browsers refuse or hide a request without one.
// Chrome on Android shows a notification only through a service worker, so a grant also registers the
// worker of the site (it covers /share). The worker installs during the wait.
export async function askReminder(): Promise<ReminderSupport> {
  if (typeof Notification === 'undefined') return 'none';
  const answer = await Notification.requestPermission();
  if (answer === 'granted') setupPwa({ onNeedRefresh: () => undefined });
  return reminderSupport();
}

// Shows the notification. A tap on it opens /share (public/sw-share-reminder.js).
// Limit: the page shows it from its own timer. When the phone stops the page in the background (Android
// can freeze a tab), the notification comes late or not at all, and the page shows the step on return.
// Revisit with a push from the server if players miss the reminder.
export async function remind(title: string, body: string): Promise<void> {
  if (reminderSupport() !== 'granted') return;
  const options: NotificationOptions = { body, icon: '/android-chrome-192x192.png', tag: 'tick3d-share-wait' };
  const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  if (registration?.active) {
    await registration.showNotification(title, options);
    return;
  }
  try {
    // A tap on it brings this tab to the front.
    const notification = new Notification(title, options);
    notification.addEventListener('click', () => focus());
  } catch {
    // Chrome on Android refuses a notification without a service worker. The page shows the step instead.
  }
}
