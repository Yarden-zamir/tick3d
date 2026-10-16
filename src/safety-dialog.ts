// The report and block dialog of a person, for the game page (src/page/safety.ts) and the stats page.
// The page decides what Block and Send report do. The dialog adds itself to the page at the first open.
import { BLOCK_ICON, FLAG_ICON } from './icons.ts';
import { REPORT_REASONS, type ReportReason } from './protocol.ts';

export type SafetyChoice = {
  title: string;
  // A Nearby game has no server copy, so it offers no report.
  canReport: boolean;
  blocked: boolean;
  // Runs after the dialog closes.
  toggleBlock: () => void;
  // Answers true when the report went out, so the dialog closes.
  report: (reason: ReportReason, note: string) => Promise<boolean>;
};

const MARKUP = `
  <p id="safety-title"></p>
  <div class="end-card-actions" id="safety-actions">
    <button type="button" class="btn" id="safety-report">${FLAG_ICON}Report</button>
    <button type="button" class="btn" id="safety-block">${BLOCK_ICON}Block</button>
    <button type="button" class="btn" id="safety-cancel">Cancel</button>
  </div>
  <form class="safety-report" id="safety-report-form" hidden>
    <fieldset>
      <legend>What is wrong?</legend>
      <label><input type="radio" name="reason" value="spam" required /> Spam</label>
      <label><input type="radio" name="reason" value="abuse" /> Abuse</label>
      <label><input type="radio" name="reason" value="name" /> Inappropriate name</label>
      <label><input type="radio" name="reason" value="other" /> Other</label>
    </fieldset>
    <textarea id="safety-note" maxlength="200" rows="2" placeholder="A short note (optional)" aria-label="Note"></textarea>
    <div class="end-card-actions">
      <button type="submit" class="btn btn-primary" id="safety-send">Send report</button>
      <button type="button" class="btn" id="safety-back">Back</button>
    </div>
  </form>`;

function part<T extends Element>(root: ParentNode, selector: string, type: abstract new () => T): T {
  const found = root.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`the safety dialog has no ${selector}`);
  return found;
}

let current: SafetyChoice | undefined;

function build() {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal end-card home-confirm safety-menu';
  dialog.id = 'safety-menu';
  dialog.setAttribute('aria-labelledby', 'safety-title');
  dialog.innerHTML = MARKUP;
  const parts = {
    dialog,
    title: part(dialog, '#safety-title', HTMLParagraphElement),
    actions: part(dialog, '#safety-actions', HTMLDivElement),
    report: part(dialog, '#safety-report', HTMLButtonElement),
    block: part(dialog, '#safety-block', HTMLButtonElement),
    form: part(dialog, '#safety-report-form', HTMLFormElement),
    note: part(dialog, '#safety-note', HTMLTextAreaElement),
  };
  part(dialog, '#safety-cancel', HTMLButtonElement).addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  parts.report.addEventListener('click', () => {
    parts.actions.hidden = true;
    parts.form.hidden = false;
    parts.form.querySelector<HTMLInputElement>('input[name="reason"]')?.focus();
  });
  part(dialog, '#safety-back', HTMLButtonElement).addEventListener('click', () => {
    parts.form.hidden = true;
    parts.actions.hidden = false;
    parts.report.focus();
  });
  parts.block.addEventListener('click', () => {
    const choice = current;
    if (choice === undefined) return;
    dialog.close();
    choice.toggleBlock();
  });
  parts.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const choice = current;
    const reason = REPORT_REASONS.find((option) => option === new FormData(parts.form).get('reason'));
    if (choice === undefined || reason === undefined) return;
    void choice.report(reason, parts.note.value.trim()).then((sent) => {
      if (sent) dialog.close();
    });
  });
  document.body.append(dialog);
  return parts;
}

let parts: ReturnType<typeof build> | undefined;

export const safetyDialogOpen = (): boolean => parts?.dialog.open === true;

export function openSafetyDialog(choice: SafetyChoice): void {
  parts ??= build();
  if (parts.dialog.open) return;
  current = choice;
  parts.title.textContent = choice.title;
  parts.report.hidden = !choice.canReport;
  parts.block.lastChild?.replaceWith(choice.blocked ? 'Unblock' : 'Block');
  parts.actions.hidden = false;
  parts.form.hidden = true;
  parts.form.reset();
  parts.dialog.showModal();
  (parts.report.hidden ? parts.block : parts.report).focus();
}
