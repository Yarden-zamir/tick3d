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
// The edges of one element, rounded to a pixel.
async function box(page: Page, selector: string): Promise<{ top: number; height: number }> {
  return page.locator(selector).evaluate((element) => {
    const own = element.getBoundingClientRect();
    return { top: Math.round(own.top), height: Math.round(own.height) };
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
}
