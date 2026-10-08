import { cell, expect, oscillatorMic, status, test } from './fixtures.ts';
import type { Locator, Page } from '@playwright/test';

// A control that shows, hides or changes its label with the game state must not move the controls
// around it. The test records the geometry of each row and compares it across the game states.
// It checks the boxes only, not the pixels or the text.

const friend = { settings: { mode: 'friend' } };
// X takes the space diagonal 0, 21, 42, 63. O takes 1, 2, 3, which is no line.
const X_WINS = [0, 1, 21, 2, 42, 3, 63];
// The rows that hold controls or text that change with the game state: the actions row, the score and the header.
const ROWS = ['.actions', '.score', '.brand'] as const;
// The rows of the voice panel, while the voice is on.
const VOICE_ROWS = ['.voice-panel', '.voice-status'] as const;
// A small Android phone, a common phone and a desktop.
const VIEWPORTS = { 'small phone': { width: 360, height: 800 }, phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 900 } } as const;

interface Edges {
  left: number;
  right: number;
}

interface RowGeometry {
  height: number;
  // The left and right edges of each child, by its position and id. A child with display: none has zero edges.
  children: Record<string, Edges>;
  // The children with a box that leaves the row: an overflow or a label that pushes out of its slot.
  outside: string[];
}

async function rowGeometry(row: Locator): Promise<RowGeometry> {
  return row.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const children: Record<string, Edges> = {};
    const outside: string[] = [];
    [...element.children].forEach((child, index) => {
      const own = child.getBoundingClientRect();
      const key = `${index}:${child.id || child.className}`;
      children[key] = { left: Math.round(own.left), right: Math.round(own.right) };
      const shown = own.width > 0;
      if (shown && (own.left < box.left - 0.5 || own.right > box.right + 0.5 || own.height > box.height + 0.5)) outside.push(key);
    });
    return { height: Math.round(box.height), children, outside };
  });
}

const geometry = async (page: Page, rows: readonly string[] = ROWS) =>
  Object.fromEntries(await Promise.all(rows.map(async (row) => [row, await rowGeometry(page.locator(row))] as const)));

// The hover and press effects of a button move it by a pixel or two, so the pointer leaves the panel first.
// The poll waits for the end of those short transitions.
async function expectSameGeometry(page: Page, baseline: Awaited<ReturnType<typeof geometry>>, state: string, rows: readonly string[] = ROWS): Promise<void> {
  await page.mouse.move(0, 0);
  await expect.poll(() => geometry(page, rows), { message: `the rows moved: ${state}` }).toEqual(baseline);
}

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test(`${name}: the actions row, the score, the header and the voice panel keep their geometry from the first move to the next game`, async ({ open }) => {
    // A full game, a new game and the voice: under the software 3D board of CI, each click takes seconds,
    // and the 90 s default ends the test before the last check ("Target page, context or browser has been closed").
    test.setTimeout(180_000);
    const { page, context } = await open(friend);
    await context.addInitScript(oscillatorMic);
    await page.reload();
    await page.setViewportSize(viewport);
    // The web font changes the width of each label, so the baseline waits for it.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect(page.locator('#undo')).toBeVisible();
    await page.mouse.move(0, 0);
    const baseline = await geometry(page);
    for (const row of ROWS) expect(baseline[row]?.outside, `${row} children inside the row`).toEqual([]);

    await cell(page, X_WINS[0] ?? 0).click();
    await expectSameGeometry(page, baseline, 'after the first move');

    // The voice starts before the winning move, not earlier: each click is slow while the microphone listens,
    // and the whole test must end within the time limit of a test.
    for (const index of X_WINS.slice(1, -1)) await cell(page, index).click();
    const voice = page.getByRole('button', { name: 'Play by voice' });
    await voice.click();
    await expect(voice).toHaveAttribute('data-state', 'listening');
    await expectSameGeometry(page, baseline, 'voice on');
    await page.mouse.move(0, 0);
    const voiceBaseline = await geometry(page, VOICE_ROWS);
    for (const row of VOICE_ROWS) expect(voiceBaseline[row]?.outside, `${row} children inside the row`).toEqual([]);

    await cell(page, X_WINS.at(-1) ?? 0).click();
    await expect(status(page)).toHaveAttribute('data-state', 'won');
    await page.locator('#end-card-close').click();
    await expect(page.locator('#show-card')).toBeVisible();
    await expect(page.locator('#undo')).toBeHidden();
    await expectSameGeometry(page, baseline, 'game over');
    await expectSameGeometry(page, voiceBaseline, 'game over, voice panel', VOICE_ROWS);

    // The specific case: the result card takes the slot of Undo, with the same edges.
    const undoBox = await page.locator('#undo').boundingBox();
    const cardBox = await page.locator('#show-card').boundingBox();
    expect(cardBox?.x).toBeCloseTo(undoBox?.x ?? Number.NaN, 0);
    expect(cardBox?.width).toBeCloseTo(undoBox?.width ?? Number.NaN, 0);

    await page.locator('#new-game').click();
    await expect(status(page)).toHaveAttribute('data-state', 'playing');
    await expect(page.locator('#undo')).toBeVisible();
    await expectSameGeometry(page, baseline, 'a new game');
    await expect(voice).toHaveAttribute('data-state', 'listening');
    await expectSameGeometry(page, voiceBaseline, 'a new game, voice panel', VOICE_ROWS);

    await voice.click();
    await expect(voice).toHaveAttribute('aria-pressed', 'false');
    await expectSameGeometry(page, baseline, 'voice off');
  });
}

// A note or a control that shows late keeps its box while hidden (src/style.css), so the page under it stays.
// The top on the page (not in the viewport: a click scrolls) and the height of one element, rounded to a pixel.
async function box(page: Page, selector: string): Promise<{ top: number; height: number }> {
  return page.locator(selector).evaluate((element) => {
    const own = element.getBoundingClientRect();
    return { top: Math.round(own.top + scrollY), height: Math.round(own.height) };
  });
}

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test(`${name}: the clock note and the keypad speaker keep their place while hidden`, async ({ open }) => {
    const { page } = await open(friend);
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // A limit before the first move applies to this game, so the clocks and their note show.
    await page.locator('[data-limit="perGame"] [data-limit-on]').check();
    await expect(page.locator('#clock-note')).toBeVisible();
    const board = await box(page, '#board');
    // No move yet: the speaker does not show, but it has its box.
    await expect(page.locator('#coords-hear')).toBeHidden();
    expect((await box(page, '#coords-hear')).height).toBeGreaterThan(0);

    // The note leaves after the first move of each player.
    for (const index of X_WINS.slice(0, 2)) await cell(page, index).click();
    await expect(page.locator('#clock-note')).toBeHidden();
    await expect(page.locator('#coords-hear')).toBeVisible();
    await expect.poll(() => box(page, '#board'), { message: 'the board moved when the note left' }).toEqual(board);
  });

  test(`${name}: the review bar takes the place of the keypad without a change of height`, async ({ open }) => {
    const { page } = await open(friend);
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const index of X_WINS) await cell(page, index).click();
    await expect(status(page)).toHaveAttribute('data-state', 'won');
    await page.locator('#end-card-close').click();
    // The height only: the status in the header changes its text in a review, and it can wrap on a phone.
    const { height } = await box(page, '.stage-controls');

    await page.locator('#account-button').click();
    await page.locator('#my-games-session li').first().getByRole('button', { name: 'Replay' }).click();
    await expect(page.locator('#review')).toBeVisible();
    await expect(page.locator('#coords')).toBeHidden();
    await expect.poll(async () => (await box(page, '.stage-controls')).height, { message: 'the review bar changed the height' }).toBe(height);
  });

  test(`${name}: a review of a timed game keeps the place of the clocks`, async ({ open }) => {
    const { page } = await open(friend);
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // A 5 s move limit ends the game soon after the first move of each player, the shortest timed game.
    const perMove = page.locator('[data-limit="perMove"]');
    await perMove.locator('[data-limit-on]').check();
    await perMove.locator('[data-limit-value]').fill('5');
    await perMove.locator('[data-limit-value]').press('Tab');
    await expect(page.locator('#clock-summary')).toContainText('5 s per move');
    for (const index of X_WINS.slice(0, 2)) await cell(page, index).click();
    await expect(status(page)).toHaveAttribute('data-state', 'timeout');
    await page.locator('#end-card-close').click();
    await expect(page.locator('#clocks')).toBeVisible();
    // The board from the top of the stage: the status in the header changes its text in a review, and it can wrap on a phone.
    const offset = async () => (await box(page, '#board')).top - (await box(page, '#stage')).top;
    const before = await offset();

    await page.locator('#account-button').click();
    await page.locator('#my-games-session li').first().getByRole('button', { name: 'Replay' }).click();
    await expect(page.locator('#review')).toBeVisible();
    await expect(page.locator('#clocks')).toBeHidden();
    await expect.poll(offset, { message: 'the board moved up when the clocks left' }).toBe(before);
  });
}

// The mode switch: the controls of each mode show and hide, and Online and Nearby open the chat.
// The board and the panel above the Opponent picker must not move. On a phone the chat opens above the panel,
// and the page scrolls by its height (src/page/panel-anchor.ts), so the picker stays under the finger.
// The phone part starts with the picker in the middle of the screen: there Chrome anchors on the board, like Safari, which has no anchoring.
const PANEL_TOP = ['.score', '.actions', '.mode-picker'] as const;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

// The boxes in the viewport, rounded to a pixel. The board is measured from the top of the stage, because on a phone
// the status in the header can wrap to a second line, and the page scrolls when the chat opens.
async function modeLayout(page: Page, selectors: readonly string[] = PANEL_TOP): Promise<Record<string, Box>> {
  return page.evaluate((selectors) => {
    const boxOf = (selector: string): Box => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`no ${selector}`);
      const { left, top, width, height } = element.getBoundingClientRect();
      return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) };
    };
    const layout = Object.fromEntries(selectors.map((selector) => [selector, boxOf(selector)]));
    const board = boxOf('#board');
    const stage = boxOf('#stage');
    return { ...layout, board: { ...board, top: board.top - stage.top } };
  }, selectors);
}

const MODE_STEPS = [
  { mode: 'Friend', ready: (page: Page) => expect(page.locator('#undo')).toBeVisible() },
  // Online creates a game, which opens the chat.
  { mode: 'Online', ready: (page: Page) => expect(page.locator('#chat')).not.toHaveClass(/closed/) },
  { mode: 'Nearby', ready: (page: Page) => expect(page.locator('#nearby-host')).toBeVisible() },
  { mode: 'Computer', ready: (page: Page) => expect(page.locator('#undo')).toBeVisible() },
] as const;

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test(`${name}: a mode switch and the chat move neither the board nor the panel`, async ({ open }) => {
    const { page } = await open({ settings: { mode: 'computer' } });
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect(page.locator('#undo')).toBeVisible();
    const picker = page.locator('.mode-picker');
    await picker.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await page.mouse.move(0, 0);
    const baseline = await modeLayout(page);
    // Only a wide screen (72rem and wider) has the chat column. A closed chat is invisible there but keeps
    // its box, and boundingBox() returns null for an invisible element, so the test reads the box directly.
    const chatBox = () => page.locator('#chat').evaluate((element) => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; });
    const chatColumn = name === 'desktop' ? await chatBox() : null;
    if (name === 'desktop') expect(chatColumn, 'the closed chat column').not.toBeNull();

    for (const { mode, ready } of MODE_STEPS) {
      await picker.getByRole('button', { name: mode, exact: true }).click();
      await ready(page);
      await page.mouse.move(0, 0);
      await expect.poll(() => modeLayout(page), { message: `the board or the panel moved: ${mode}` }).toEqual(baseline);
      // A wide screen keeps the chat column in every mode, closed or open.
      if (chatColumn !== null) expect(await chatBox(), `the chat column: ${mode}`).toEqual(chatColumn);
    }

    // Host opens a Nearby game, and with it the chat.
    await picker.getByRole('button', { name: 'Nearby', exact: true }).click();
    await page.locator('#nearby-host').click();
    await expect(page.locator('#chat')).not.toHaveClass(/closed/);
    await page.mouse.move(0, 0);
    await expect.poll(() => modeLayout(page), { message: 'the board or the panel moved: Nearby host' }).toEqual(baseline);
  });
}

// Online waits for the server. Until the answer, the controls of a game draw in their final place, grey and
// disabled (data-pending, src/page/render.ts). The answer fills them in, and nothing moves.
const PENDING = ['#clocks', '.score', '.actions', '#online-session', '#players'] as const;

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test(`${name}: online draws its controls grey before the server answers, and they do not move after`, async ({ open }) => {
    const { page } = await open({ settings: { mode: 'computer' } });
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect(page.locator('#undo')).toBeVisible();
    // A time limit shows the clocks above the board.
    await page.locator('[data-limit="perGame"] [data-limit-on]').check();
    await expect(page.locator('#clocks')).toBeVisible();
    let answer = () => {};
    const held = new Promise<void>((resolve) => (answer = resolve));
    await page.route('**/api/sessions', async (route) => {
      if (route.request().method() === 'POST') await held;
      await route.continue();
    });
    const picker = page.locator('.mode-picker');
    await picker.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await picker.getByRole('button', { name: 'Online', exact: true }).click();

    for (const selector of ['#clocks', '.score', '#new-game', '#undo', '#online-session', '#players']) {
      await expect(page.locator(selector), selector).toBeVisible();
      await expect(page.locator(selector), selector).toHaveAttribute('data-pending', '');
    }
    for (const id of ['#new-game', '#undo', '#share', '#share-qr', '#players [data-seat-lock]']) await expect(page.locator(id), id).toBeDisabled();
    await expect(page.locator('#players-list li')).toHaveCount(2);
    await page.mouse.move(0, 0);
    const before = await modeLayout(page, PENDING);

    answer();
    await expect(page.locator('#online-code')).not.toHaveText('····');
    await expect(page.locator('[data-pending]')).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect.poll(() => modeLayout(page, PENDING), { message: 'a control moved when the server answered' }).toEqual(before);
  });
}
