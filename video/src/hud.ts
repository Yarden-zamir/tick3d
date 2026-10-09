// The on-screen text of the spot: the lines of beats.json, in the lettering of src/lettering.ts.
import { SPOT_SIXTEENTHS, type TextStyle } from '../creative/beats.ts';
import { type Look, endCard, onSquare, wordAt } from './lettering.ts';
import { BEATS, frameOf } from './timeline.ts';
import type { Theme } from './themes.ts';

// The look of each word group of a line, by the style of the line ('end-card' draws with endCard).
const LOOKS: Readonly<Record<Exclude<TextStyle, 'end-card'>, readonly Look[]>> = {
  center: [{ y: -80, size: 132 }, { y: 100, size: 120, sticker: 'x' }],
  top: [{ y: -496, size: 100 }, { y: -398, size: 90, sticker: 'x' }],

  // One sticker at a time in the free space above the tower. When the next card slams in, the card before it
  // shrinks and fades out over 1 sixteenth.
  cards: [
    { y: -466, size: 88, sticker: 'x', tilt: -5 },
    { y: -466, size: 88, sticker: 'o', tilt: 4 },
    { y: -466, size: 88, sticker: 'x', tilt: -3 },
    { y: -466, size: 88, sticker: 'o', tilt: 5 },
  ],
};

// Draws the text of `frame` in `theme` on the whole canvas.
export function drawHud(ctx: CanvasRenderingContext2D, frame: number, theme: Theme): void {
  onSquare(ctx, () => {
    BEATS.text.forEach((line, index) => {
      // A line that lasts to the end of the 8 bars stays on the end card while the final chord rings.
      if (line.until < SPOT_SIXTEENTHS && frame >= frameOf(line.until)) return;
      if (line.style === 'end-card') {
        endCard(ctx, frame, line.words, theme);
        return;
      }
      const looks = LOOKS[line.style];
      if (looks.length < line.words.length || (line.style !== 'cards' && looks.length !== line.words.length)) {
        throw new Error(`text line ${index + 1} has ${line.words.length} word groups, and the '${line.style}' style has ${looks.length}`);
      }
      line.words.forEach((word, i) => {
        const look = looks[i];
        if (look !== undefined) wordAt(ctx, frame, word, look, theme, line.style === 'cards' ? line.words[i + 1]?.at : undefined);
      });
    });
  });
}
