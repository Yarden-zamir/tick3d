// The tutorial in the Info panel: the video "How to win" and a slider over its checkpoints.
// The video render writes the checkpoints to src/tutorial-chapters.json (video/src/tutorial/plan.ts), so the
// times and the texts have one source. The ticks of the slider stand evenly apart, one per checkpoint.
// While the video plays, the thumb slides between them with the time: position 2.5 is halfway through the
// third checkpoint. A drag snaps: the video shows the frame of the nearest checkpoint (the moment where its
// picture is complete), the headline rides over the thumb, and on release the thumb slides onto that tick.
// Play from a snapped checkpoint starts at the start of its section. The arrow keys jump a whole checkpoint.
// A drag pauses the video first, so a scrub plays no sound. The speaker button mutes the video only.
// The video loads on the first open of Info, so a visit that never opens Info does not download it.
import chaptersFile from '../tutorial-chapters.json';
import { PAUSE_ICON, PLAY_ICON, SOUND_OFF_ICON, SOUND_ON_ICON } from '../icons.ts';
import { element } from './dom.ts';
import { settings } from './settings.ts';

// `frame`: the moment of the checkpoint where its picture is complete. A snap shows it.
type Chapter = { start: number; frame: number; headline: string; text: string };
type Tutorial = { video: string; poster: string; chapters: readonly Chapter[] };

const panel = element('#info-panel', HTMLDivElement);
const video = element('#tutorial-video', HTMLVideoElement);
const playButton = element('#tutorial-play', HTMLButtonElement);
const muteButton = element('#tutorial-mute', HTMLButtonElement);
const range = element('#tutorial-range', HTMLInputElement);
const bubble = element('#tutorial-bubble', HTMLOutputElement);
const ticks = element('#tutorial-ticks', HTMLDivElement);
const headlineEl = element('#tutorial-headline', HTMLHeadingElement);
const textEl = element('#tutorial-text', HTMLParagraphElement);

// The JSON file comes from a script, so the page checks its shape once and stops when it is wrong.
function parseTutorial(value: unknown): Tutorial {
  const fail = (what: string): never => {
    throw new Error(`src/tutorial-chapters.json: ${what}`);
  };
  if (typeof value !== 'object' || value === null) return fail('not an object');
  const { video: file, poster, chapters } = value as Record<string, unknown>;
  if (typeof file !== 'string' || file === '' || typeof poster !== 'string' || poster === '') return fail('no video or poster file');
  if (!Array.isArray(chapters) || chapters.length < 2) return fail('fewer than two chapters');
  const parsed = chapters.map((chapter: unknown, index): Chapter => {
    if (typeof chapter !== 'object' || chapter === null) return fail(`chapter ${index} is not an object`);
    const { start, frame, headline, text } = chapter as Record<string, unknown>;
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) return fail(`chapter ${index} has no start`);
    if (typeof frame !== 'number' || !Number.isFinite(frame) || frame < start) return fail(`chapter ${index} has no frame`);
    if (typeof headline !== 'string' || headline === '' || typeof text !== 'string' || text === '') return fail(`chapter ${index} has no text`);
    return { start, frame, headline, text };
  });
  if (parsed[0]?.start !== 0) return fail('the first chapter does not start at 0');
  if (parsed.some((chapter, i) => i > 0 && chapter.start <= (parsed[i - 1]?.start ?? 0))) return fail('the chapters are not in time order');
  if (parsed.some((chapter, i) => chapter.frame >= (parsed[i + 1]?.start ?? Infinity))) return fail('a frame lies in the next chapter');
  return { video: file, poster, chapters: parsed };
}

const tutorial = parseTutorial(chaptersFile);
const BASE = '/tutorial/';

function chapterAt(index: number): Chapter {
  const chapter = tutorial.chapters[index];
  if (chapter === undefined) throw new RangeError(`no tutorial chapter ${index}`);
  return chapter;
}

const LAST = tutorial.chapters.length - 1;
// Before the video knows its length, the last checkpoint counts as this long.
const LAST_CHAPTER_SECONDS = 3;

// The end of checkpoint `index`: the start of the next one, or the end of the video.
function endOf(index: number): number {
  const next = tutorial.chapters[index + 1];
  if (next !== undefined) return next.start;
  return Number.isFinite(video.duration) ? video.duration : chapterAt(index).start + LAST_CHAPTER_SECONDS;
}

// The checkpoint at a slider position. Position LAST is the start of the last checkpoint and onward.
const indexOf = (position: number) => Math.min(LAST, Math.max(0, Math.floor(position + 1e-6)));

// The slider position of a time of the video.
function positionAt(seconds: number): number {
  const index = Math.max(0, tutorial.chapters.findLastIndex((chapter) => chapter.start <= seconds + 1e-3));
  if (index === LAST) return LAST;
  const start = chapterAt(index).start;
  return index + Math.min(1, Math.max(0, (seconds - start) / (endOf(index) - start)));
}

let shown = -1;

// Puts the thumb at `position` and shows the text of checkpoint `index`: by default the one the thumb is in.
function show(position: number, index = indexOf(position)): void {
  range.value = String(position);
  // The bubble follows the thumb: 0 at the first checkpoint, 1 at the last (see .tutorial-bubble in src/style.css).
  bubble.style.setProperty('--at', String(position / LAST));
  if (index === shown) return;
  shown = index;
  const chapter = chapterAt(index);
  bubble.textContent = chapter.headline;
  headlineEl.textContent = chapter.headline;
  textEl.textContent = chapter.text;
}

// The checkpoint that the video shows as a still, after a snap. Play then starts at the start of its section.
let snapped: number | null = null;

// Shows the frame of checkpoint `index`, once per checkpoint while a drag passes over it.
function snapVideo(index: number): void {
  load();
  if (snapped === index) return;
  snapped = index;
  video.pause();
  video.currentTime = chapterAt(index).frame;
}

// The thumb slides onto the tick of checkpoint `index`.
const SLIDE_MS = 180;
let slide = 0;
// The checkpoint that the thumb slides to, while it slides. A key press during the slide counts from it.
let slideTarget: number | null = null;

function slideTo(index: number): void {
  const from = Number(range.value);
  const startedAt = performance.now();
  const frame = ++slide;
  slideTarget = index;
  const step = (now: number) => {
    if (frame !== slide) return;
    const t = Math.min(1, (now - startedAt) / SLIDE_MS);
    const eased = 1 - (1 - t) ** 3;
    show(from + (index - from) * eased, index);
    if (t < 1) requestAnimationFrame(step);
    else slideTarget = null;
  };
  requestAnimationFrame(step);
}

function snapTo(index: number): void {
  snapVideo(index);
  slideTo(index);
}

// While the video plays, the thumb moves every frame, so it slides instead of jumping at each timeupdate.
function follow(): void {
  snapped = null;
  if (video.paused || video.ended) return;
  if (bubble.dataset.dragging === undefined) show(positionAt(video.currentTime));
  requestAnimationFrame(follow);
}

function showPlaying(): void {
  const playing = !video.paused && !video.ended;
  playButton.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  playButton.setAttribute('aria-label', playing ? 'Pause the tutorial' : 'Play the tutorial');
  playButton.dataset.playing = String(playing);
}

// The video loads on the first open of Info.
function load(): void {
  if (video.src !== '') return;
  video.poster = `${BASE}${tutorial.poster}`;
  video.preload = 'auto';
  video.src = `${BASE}${tutorial.video}`;
}

// The sound of the video starts as the sound of the game, and the speaker of the video changes it.
let muted = settings.muted;

function showMuted(): void {
  video.muted = muted;
  muteButton.innerHTML = muted ? SOUND_OFF_ICON : SOUND_ON_ICON;
  muteButton.setAttribute('aria-pressed', String(!muted));
}

function togglePlay(): void {
  load();
  if (!video.paused && !video.ended) return video.pause();
  if (snapped !== null) video.currentTime = chapterAt(snapped).start;
  void video.play().catch(() => showPlaying());
}

export function setupTutorial(): void {
  ticks.replaceChildren(...tutorial.chapters.map(() => document.createElement('span')));
  range.max = String(LAST);
  show(0);
  showPlaying();
  showMuted();
  muteButton.addEventListener('click', () => {
    muted = !muted;
    showMuted();
  });

  panel.addEventListener('toggle', (event) => {
    if (!(event instanceof ToggleEvent)) return;
    if (event.newState === 'open') load();
    else video.pause();
  });
  playButton.addEventListener('click', togglePlay);
  video.addEventListener('click', togglePlay);
  for (const type of ['play', 'pause', 'ended'] as const) video.addEventListener(type, showPlaying);
  video.addEventListener('play', follow);
  // Offline, or with a broken file, the checkpoints still work without the video.
  video.addEventListener('error', () => {
    video.closest('.tutorial-video')?.setAttribute('hidden', '');
  });
  // The thumb follows the finger, and the video shows the nearest checkpoint.
  range.addEventListener('input', () => {
    const position = Number(range.value);
    const nearest = Math.round(position);
    video.pause();
    slide++;
    slideTarget = null;
    show(position, nearest);
    snapVideo(nearest);
  });
  range.addEventListener('change', () => snapTo(Math.round(Number(range.value))));
  // The arrow keys jump to the next or the previous checkpoint, not by a hair of the slider.
  range.addEventListener('keydown', (event) => {
    const now = slideTarget ?? indexOf(Number(range.value));
    const atStart = slideTarget !== null || Number(range.value) === now;
    const target: Record<string, number> = {
      ArrowRight: now + 1,
      ArrowUp: now + 1,
      PageUp: now + 1,
      ArrowLeft: atStart ? now - 1 : now,
      ArrowDown: atStart ? now - 1 : now,
      PageDown: atStart ? now - 1 : now,
      Home: 0,
      End: LAST,
    };
    const index = target[event.key];
    if (index === undefined) return;
    event.preventDefault();
    snapTo(Math.min(LAST, Math.max(0, index)));
  });
  range.addEventListener('pointerdown', () => {
    bubble.dataset.dragging = '';
    video.pause();
  });
  for (const type of ['pointerup', 'pointercancel'] as const) document.addEventListener(type, () => delete bubble.dataset.dragging);
}
