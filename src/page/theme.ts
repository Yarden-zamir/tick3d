// The theme menu.
import { themeMenu, themePicker, themeSwatch, themeName, themeColorMeta } from './dom.ts';
import { THEMES } from '../protocol.ts';
import { THEME_NAMES, settings, saveSettings } from './settings.ts';

// One preview tile per theme. Each swatch carries data-theme, so it draws with that theme's tokens.
const themeButtons = THEMES.map((theme) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.themeChoice = theme;
  button.innerHTML = `<span class="swatch" data-theme="${theme}"><span></span></span>${THEME_NAMES[theme]}`;
  button.addEventListener('click', () => {
    themeMenu.open = false;
    if (theme === settings.theme) return;
    settings.theme = theme;
    saveSettings();
    applyTheme();
  });
  return button;
});

// The theme is a per-screen look like the sound, so the settings lock does not hold it.
export function applyTheme(): void {
  document.documentElement.dataset.theme = settings.theme;
  themeButtons.forEach((button) =>
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === settings.theme)),
  );
  themeSwatch.dataset.theme = settings.theme;
  themeName.textContent = THEME_NAMES[settings.theme];
  // The browser bar takes the board color, the strongest color of each theme (see index.html).
  themeColorMeta.content = getComputedStyle(document.documentElement).getPropertyValue('--slab').trim();
}

export function setupTheme(): void {
  themePicker.replaceChildren(...themeButtons);
}
