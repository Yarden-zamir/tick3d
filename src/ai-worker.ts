// The move search, off the page's main thread, so the page stays responsive while the computer thinks.
// The page starts this file in src/page/computer.ts. The TypeScript settings use the DOM types, and the
// DOM `postMessage` overload with one argument has the same call shape as the worker's `postMessage`.
import { WORKER_READY, answerRequest } from './move-search.ts';

addEventListener('message', (event: MessageEvent<unknown>) => postMessage(answerRequest(event.data)));
// The page waits for this message to know that the script loaded (WORKER_START_MS in src/move-search.ts).
postMessage(WORKER_READY);
