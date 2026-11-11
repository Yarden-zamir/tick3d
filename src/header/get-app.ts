// "Get the app" in the footer of every page: a link to the Android app on Google Play. It shows only in a browser
// that can install the app (offersPlayApp in src/platform.ts), and only while the Play listing is live.
import { element } from '../element.ts';
import { appVisitor, offersPlayApp } from '../platform.ts';
import { playStage } from '../stores.ts';

const getAppLink = element('#get-app-link', HTMLAnchorElement);

export function setupGetApp(): void {
  const visitor = appVisitor();
  // Ask the server only when the answer can change what shows.
  if (!offersPlayApp(visitor, 'live')) return;
  void playStage().then((stage) => {
    getAppLink.hidden = !offersPlayApp(visitor, stage);
  });
}
