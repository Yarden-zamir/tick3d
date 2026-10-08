// Reads the deletion notices of the server since the last check, and removes those people from the
// copies on this device (src/deletions.ts). Without a network the copies wait for the next check.
import { isEpochMs, toEpochMs } from '../epoch.ts';
import { scrubDoc, scrubUpload, scrubView } from '../deletions.ts';
import { OnlineError, api } from '../online.ts';
import { parseDoc } from '../session/format.ts';
import { STORAGE_KEYS } from '../storage-keys.ts';
import { page } from './state.ts';

function lastCheck(): number {
  try {
    const value: unknown = Number(localStorage.getItem(STORAGE_KEYS.deletionsChecked));
    return isEpochMs(value) ? value : 0;
  } catch {
    return 0;
  }
}

export async function syncDeletions(): Promise<void> {
  const db = page.deviceDb;
  if (db === undefined || !navigator.onLine) return;
  let notices: Awaited<ReturnType<typeof api.deletedPeople>>;
  try {
    notices = await api.deletedPeople(toEpochMs(lastCheck()));
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
    return;
  }
  const deleted = new Set(notices.people);
  if (deleted.size > 0) {
    for (const cached of await db.all('remote')) {
      const view = scrubView(cached.view, deleted);
      if (view !== undefined) await db.put('remote', { ...cached, view });
    }
    for (const row of await db.all('sessions')) {
      let doc;
      try {
        doc = parseDoc(row.doc);
      } catch {
        // A damaged session stays as it is, like in the list of sessions (src/local.ts).
        continue;
      }
      const scrubbed = await scrubDoc(doc, deleted);
      if (scrubbed === undefined) continue;
      const stored: unknown = JSON.parse(JSON.stringify(scrubbed));
      parseDoc(stored);
      await db.put('sessions', { ...row, doc: stored, version: row.version + 1 });
    }
    for (const result of await db.all('results')) {
      const upload = await scrubUpload(result.upload, deleted);
      if (upload !== undefined) await db.put('results', { ...result, upload });
    }
  }
  try {
    localStorage.setItem(STORAGE_KEYS.deletionsChecked, String(notices.until));
  } catch {
    // Storage is blocked: the next visit checks every notice again, which changes nothing twice.
  }
}
