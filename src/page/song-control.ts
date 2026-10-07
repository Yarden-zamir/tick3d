// The song button of a finished game. A click plays the game as a song (src/song.ts) and lights the cell
// of each note as it sounds. A second click stops it. A long press, a right click or the context menu key
// renders the same song into a WAV file and shares it, or downloads it where the browser cannot share
// files. The end card and a game from a link use it.
import { shareFile } from '../card.ts';
import type { Game } from '../game.ts';
import { SOUND_ON_ICON } from '../icons.ts';
import { SIXTEENTH, songOf } from '../song.ts';
import { type SongPlayback, type VoiceClips, playSong, renderSong } from '../sound.ts';
import { encodeWav } from '../wav.ts';
import { showToast } from './feedback.ts';

// `light` shows the cell of the note that sounds, or none. `clips` holds the player's voice for the moves
// that the voice placed: the song plays them, and a shared file has them only when `shareVoice` is true.
export type SongSource = { game: Game; filename: string; text: string; light: (cell: number | undefined) => void; clips: VoiceClips; shareVoice: boolean };

// A press this long shares the song as a file.
const LONG_PRESS_MS = 600;
// A cell stays lit for one beat after its note starts, or until the next note.
const LIGHT_SECONDS = 4 * SIXTEENTH;
type State = 'idle' | 'playing' | 'held' | 'rendering';
const LABELS: Record<State, string> = { idle: 'Song', playing: 'Stop', held: 'Release to share', rendering: 'Making the file…' };

// Renders the song offline with the voices and the mix of live play, into a WAV file.
async function songFile({ game, filename, clips, shareVoice }: SongSource): Promise<File> {
  const buffer = await renderSong(songOf(game), shareVoice ? clips : new Map());
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  return new File([encodeWav(channels, buffer.sampleRate)], filename, { type: 'audio/wav' });
}

export function songControl(button: HTMLButtonElement, source: () => SongSource | undefined): { stop: () => void } {
  // A pointer press. `file` is the render that starts when the press becomes long.
  let press: { timer: ReturnType<typeof setTimeout>; file: Promise<File> | undefined } | undefined;
  let playing: { playback: SongPlayback; frame: number; source: SongSource } | undefined;

  const show = (state: State) => {
    button.dataset.state = state;
    button.innerHTML = `${SOUND_ON_ICON}<span>${LABELS[state]}</span>`;
  };

  function stop(): void {
    if (playing === undefined) return;
    cancelAnimationFrame(playing.frame);
    playing.playback.stop();
    playing.source.light(undefined);
    playing = undefined;
    show('idle');
  }

  function play(): void {
    const shown = source();
    if (shown === undefined) return;
    const song = songOf(shown.game);
    const playback = playSong(song, shown.clips);
    if (playback === undefined) return showToast('Turn the sound on to hear the song.');
    const melody = song.notes.filter((note) => note.kind === 'melody');
    // The highlight reads the audio clock on every frame, so it cannot drift from the sound.
    const follow = () => {
      if (playing === undefined) return;
      const time = playback.elapsed();
      if (time >= song.duration) return stop();
      const note = melody.findLast((candidate) => candidate.at <= time);
      playing.source.light(note !== undefined && time < note.at + LIGHT_SECONDS ? note.cell : undefined);
      playing.frame = requestAnimationFrame(follow);
    };
    playing = { playback, frame: requestAnimationFrame(follow), source: shown };
    show('playing');
  }

  async function share(file: Promise<File>, text: string): Promise<void> {
    show('rendering');
    try {
      const outcome = await shareFile(await file, text);
      if (outcome === 'saved') showToast('Song saved as a sound file.');
    } finally {
      show('idle');
    }
  }

  function endPress(): void {
    if (press === undefined) return;
    clearTimeout(press.timer);
    if (press.file === undefined) press = undefined;
    else if (button.dataset.state === 'held') show('idle');
  }

  show('idle');
  button.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || button.dataset.state !== 'idle') return;
    const shown = source();
    if (shown === undefined) return;
    const started: NonNullable<typeof press> = {
      file: undefined,
      timer: setTimeout(() => {
        // The render starts during the press, so the file is ready soon after the release.
        started.file = songFile(source() ?? shown);
        show('held');
      }, LONG_PRESS_MS),
    };
    press = started;
  });
  // A touch browser opens a share sheet only during a gesture, and a release is one. So a long press
  // shares at the release, not at the end of the wait.
  button.addEventListener('pointerup', () => {
    const file = press?.file;
    const shown = source();
    if (file !== undefined && shown !== undefined && button.dataset.state === 'held') void share(file, shown.text);
    endPress();
  });
  // A pointer that leaves the button cancels the press.
  for (const type of ['pointerleave', 'pointercancel'] as const) {
    button.addEventListener(type, () => {
      endPress();
      press = undefined;
    });
  }
  button.addEventListener('click', () => {
    // The click after a long press does not also play the song.
    const long = press?.file !== undefined;
    press = undefined;
    if (long) return;
    if (playing !== undefined) stop();
    else if (button.dataset.state === 'idle') play();
  });
  // The context menu (a right click, the menu key, Shift+F10) shares the song too. During a touch long
  // press, the browser menu stays closed and the release shares.
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const shown = source();
    if (press !== undefined || shown === undefined || button.dataset.state !== 'idle') return;
    void share(songFile(shown), shown.text);
  });
  return { stop };
}
