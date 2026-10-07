// The segmented controls of the settings (`.segmented[data-setting]` with one button per value, as in the
// game panel) and the fields for one view only (`[data-show-view]`). The game panel and the Voice room
// use them with the stored settings of src/page/settings.ts, so both pages share the view and the layout.
import type { Settings } from '../page/settings.ts';

// Marks the chosen value of each segmented control, and shows the fields of the view now.
export function showSegmented(root: ParentNode, settings: Settings, frozen: boolean): void {
  root.querySelectorAll<HTMLElement>('[data-show-view]').forEach((field) => {
    field.hidden = field.dataset.showView !== settings.view;
  });
  root.querySelectorAll<HTMLElement>('.segmented').forEach((group) => {
    const value = settings[group.dataset.setting as keyof Settings];
    // Segmented controls exist for the text settings only (mode, level, view and the like).
    if (typeof value !== 'string') throw new Error(`segmented control for a setting that is not text: ${group.dataset.setting}`);
    group.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.value === value));
      button.disabled = frozen;
    });
  });
}

// Calls `choose` with the setting and the value of a tap on a segmented button that is not chosen yet.
export function onSegmented(root: ParentNode, choose: (setting: string, value: string | undefined) => void): void {
  root.querySelectorAll<HTMLElement>('.segmented').forEach((group) => {
    const setting = group.dataset.setting;
    if (setting === undefined) throw new Error('segmented control without data-setting');
    group.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.getAttribute('aria-pressed') === 'true') return;
        choose(setting, button.dataset.value);
      });
    });
  });
}
