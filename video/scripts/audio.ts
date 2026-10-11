// Renders the soundtrack of the spot with the game's own sound code (scripts/mixdown.ts):
//   out/soundtrack.wav (44.1 kHz stereo, 15.0 s), a copy in public/ for Remotion, and out/beats.txt.
import { mkdirSync, writeFileSync } from 'node:fs';
import { SIXTEENTH } from '../../src/song.ts';
import { spotSounds } from '../src/soundtrack.ts';
import { BEATS, VARIANT } from '../src/timeline.ts';
import { mixdown } from './mixdown.ts';

// The base cut writes to out/, a variant to out/variants/<name>/ (scripts/render.ts does the same).
const out = new URL(VARIANT === 'spot' ? '../out/' : `../out/variants/${VARIANT}/`, import.meta.url);
const pub = new URL('../public/', import.meta.url);

const sounds = spotSounds();
const wav = await mixdown(sounds, BEATS.durationSeconds);
mkdirSync(out, { recursive: true });
mkdirSync(pub, { recursive: true });
writeFileSync(new URL('soundtrack.wav', out), wav);
writeFileSync(new URL('soundtrack.wav', pub), wav);
// The beat markers: the sixteenth and the time of every note onset.
const onsets = [...new Set(sounds.map((sound) => sound.at))].sort((a, b) => a - b);
writeFileSync(new URL('beats.txt', out), onsets.map((at) => `${at}\t${(at * SIXTEENTH).toFixed(4)}`).join('\n') + '\n');
process.stdout.write(`soundtrack (${VARIANT}): ${sounds.length} sounds, ${onsets.length} onsets, ${BEATS.durationSeconds.toFixed(3)} s\n`);
