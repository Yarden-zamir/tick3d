// The practice modes of the Voice room: targets against the clock, echo rounds, and the playoff with the
// other player of an online game. src/practice/practice.ts holds the rules and src/practice/playoff.ts the
// playoff. The page (main.ts) owns the microphone, the board and the rail, and passes each voice frame here.
import { toCoords } from '../game.ts';
import { OnlineError, api } from '../online.ts';
import { type Playoff, playoffWinner } from '../practice/playoff.ts';
import {
  BESTS_VERSION,
  type Bests,
  ECHO_POINTS,
  MAX_ROUND_MS,
  PRESETS,
  PRESET_IDS,
  type PracticeMode,
  type PresetId,
  ROUNDS,
  beats,
  echoPoints,
  heatOf,
  newSeed,
  parseBests,
  presetKey,
  summarize,
  targetSteps,
} from '../practice/practice.ts';
import { element } from '../element.ts';
import type { Code, SessionView } from '../protocol.ts';
import { sounds } from '../sound.ts';
import type { Board } from '../board/board.ts';
import type { Voice, VoiceFrame } from '../voice/engine.ts';
import { cellOfStep, stepOfCell } from '../voice/mapping.ts';
import { type Rail, showRailTarget } from '../voice/rail.ts';
import { DEFAULT_STICKINESS, type Stickiness } from '../voice/sticky.ts';
import type { HoldFill, VoiceCells } from '../voice/visuals.ts';
import type { Tab } from './tab.ts';


type Context = {
  voice: Voice;
  board: Board;
  rail: Rail;
  // The light, the hold fill and the burst on the board (src/voice/visuals.ts), shared with the game.
  cells: VoiceCells;
  // Opens the microphone from a tap. False when it does not open (the page shows why).
  startMic: () => Promise<boolean>;
  show: (message: string) => void;
};

const COUNTDOWN_MS = 3000;
// An echo round waits this long after the cell sound, so the microphone does not take the speaker for the player.
const HEAR_MS = 1200;
// An echo round shows its answer this long before the next round.
const REVEAL_MS = 1600;
const NO_STICKINESS: Stickiness = { share: 0, buildUpMs: DEFAULT_STICKINESS.buildUpMs };
const BESTS_KEY = 'tick3d.voice-practice';
const SEATS_CHANGED = 'The playoff ended because the seats changed.';

// countdown: before the first round. hear: an echo round plays its cell. round: the clock runs.
// reveal: an echo round shows its answer.
type Phase = 'countdown' | 'hear' | 'round' | 'reveal';

type Run = {
  mode: PracticeMode;
  preset: PresetId;
  cells: number[];
  index: number;
  phase: Phase;
  // Frame time (performance.now) when the phase started, and when the clock of the round started.
  phaseStart: number;
  roundStart: number;
  times: number[];
  points: number[];
  // The playoff of this run, or null for a run alone.
  playoffId: number | null;
};

// The online game of a playoff, from ?code=. `offset` turns local time into server time.
type Session = { code: Code; view: SessionView; offset: number };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const describe = (cell: number) => {
  const { layer, row, column } = toCoords(cell);
  return `layer ${layer + 1}, row ${row + 1}, column ${column + 1}`;
};
const modeName = (mode: PracticeMode) => (mode === 'echo' ? 'Echo' : 'Targets');
const scoreText = (mode: PracticeMode, best: { totalMs: number; score: number }) =>
  mode === 'echo' ? `${best.score} points in ${seconds(best.totalMs)}` : seconds(best.totalMs);

function loadBests(): Bests {
  try {
    return parseBests(JSON.parse(localStorage.getItem(BESTS_KEY) ?? 'null'));
  } catch {
    return {};
  }
}

export function createPracticeRoom({ voice, board, rail, cells, startMic, show }: Context) {
  const panel = element('#practice', HTMLDivElement);
  const levels = element('#levels', HTMLDivElement);
  const setupNote = element('#setup-note', HTMLParagraphElement);
  const playoffEl = element('#playoff', HTMLDivElement);
  const playoffText = element('#playoff-text', HTMLParagraphElement);
  const raceYou = element('#race-you', HTMLDivElement);
  const raceThemName = element('#race-them-name', HTMLSpanElement);
  const raceThem = element('#race-them', HTMLDivElement);
  const leaveButton = element('#playoff-leave', HTMLButtonElement);
  const startButton = element('#start', HTMLButtonElement);
  const replayButton = element('#replay', HTMLButtonElement);
  const statusEl = element('#status', HTMLDivElement);
  const roundEl = element('#round', HTMLElement);
  const roundTimeEl = element('#round-time', HTMLSpanElement);
  const totalTimeEl = element('#total-time', HTMLSpanElement);
  const heatEl = element('#heat', HTMLDivElement);
  const heatWord = element('#heat-word', HTMLSpanElement);
  const heatWay = element('#heat-way', HTMLSpanElement);
  const heatBar = element('#heat-bar', HTMLDivElement);
  const resultsEl = element('#results', HTMLElement);
  const summaryEl = element('#summary', HTMLDivElement);
  const bestsEl = element('#bests', HTMLDivElement);
  const boardTitle = element('#leaders-title', HTMLHeadingElement);
  const boardNote = element('#leaders-note', HTMLParagraphElement);
  const boardEl = element('#leaders', HTMLOListElement);

  let tab: Tab = 'free';
  let run: Run | undefined;
  let session: Session | undefined;
  let bests = loadBests();
  // Hits of a playoff go to the server one after the other, in order.
  let hits: Promise<unknown> = Promise.resolve();

  const chosenPreset = (): PresetId => {
    const value = levels.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.dataset.value;
    const found = PRESET_IDS.find((preset) => preset === value);
    if (found === undefined) throw new Error('sound-input.html has no chosen level');
    return found;
  };
  const modeOfTab = (): PracticeMode => (tab === 'echo' ? 'echo' : 'targets');
  const playoffOf = () => session?.view.playoff ?? null;

  function saveBests(): void {
    try {
      localStorage.setItem(BESTS_KEY, JSON.stringify({ version: BESTS_VERSION, best: bests }));
    } catch {
      // Private mode or a full storage: the bests still show for this visit.
    }
  }

  function mark(cell: number | undefined, name: 'target' | 'answer'): void {
    for (const button of board.cells) button.classList.remove(name);
    if (cell !== undefined) board.cells[cell]?.classList.add(name);
  }

  // ---- Setup, bests and the leaderboard ----

  function showSetup(): void {
    const preset = PRESETS[run?.preset ?? chosenPreset()];
    const { stickiness } = voice.settings();
    const sticky = preset.sticky ? `stickiness ${Math.round(stickiness.share * 100)}% of a cell` : 'no stickiness on Hard';
    const echo = tab === 'echo' ? ' Echo plays the sound set of the game.' : '';
    setupNote.textContent = `Hold ${preset.holdMs / 1000} s, ${sticky}.${echo}`;
    showBests();
    void showBoard();
  }

  function showBests(): void {
    const mode = modeOfTab();
    bestsEl.replaceChildren(
      ...PRESET_IDS.map((preset) => {
        const best = bests[presetKey(mode, preset)];
        const row = document.createElement('p');
        row.className = 'practice-best';
        row.textContent = `${modeName(mode)}, ${PRESETS[preset].name}: ${best === undefined ? 'no run yet' : scoreText(mode, best)}`;
        return row;
      }),
    );
  }

  async function showBoard(): Promise<void> {
    const mode = modeOfTab();
    const preset = chosenPreset();
    boardTitle.textContent = `Leaderboard: ${modeName(mode)}, ${PRESETS[preset].name}`;
    try {
      const board = await api.practiceBest(mode, preset);
      // The choice changed while the board loaded.
      if (mode !== modeOfTab() || preset !== chosenPreset()) return;
      boardEl.replaceChildren(
        ...board.top.map((place) => {
          const item = document.createElement('li');
          item.textContent = `${place.player}: ${scoreText(mode, place)}`;
          return item;
        }),
      );
      boardNote.textContent = board.top.length === 0 ? 'No runs yet. Be the first.' : board.you === null ? '' : `Your best: ${scoreText(mode, board.you)}.`;
    } catch (error) {
      if (!(error instanceof OnlineError)) throw error;
      boardEl.replaceChildren();
      boardNote.textContent = 'The leaderboard needs a network.';
    }
  }

  // ---- The heat ----

  function showHeat(frame: VoiceFrame | null, target: number | null): void {
    if (target === null || frame === null || frame.position === null) {
      heatEl.dataset.heat = '';
      heatWord.textContent = target === null ? '' : 'Sing!';
      heatWay.textContent = '';
      heatBar.style.setProperty('--level', '0');
      heatBar.setAttribute('aria-valuenow', '0');
      return;
    }
    const heat = heatOf(frame.position, stepOfCell(target));
    heatEl.dataset.heat = heat.word;
    heatWord.textContent = heat.word;
    heatWay.textContent = heat.direction === 'up' ? '↑ slide up' : heat.direction === 'down' ? '↓ slide down' : 'hold it';
    heatBar.style.setProperty('--level', String(heat.share));
    heatBar.setAttribute('aria-valuenow', String(Math.round(heat.share * 100)));
  }

  // ---- A run ----

  function newRun(mode: PracticeMode, preset: PresetId, seed: number, playoffId: number | null, countdownEnd: number): Run {
    const cells = targetSteps(seed, preset, ROUNDS[mode]).map(cellOfStep);
    voice.overrideStickiness(PRESETS[preset].sticky ? null : NO_STICKINESS);
    summaryEl.replaceChildren();
    show('');
    return { mode, preset, cells, index: 0, phase: 'countdown', phaseStart: countdownEnd - COUNTDOWN_MS, roundStart: 0, times: [], points: [], playoffId };
  }

  function beginRound(active: Run, now: number): void {
    const cell = active.cells[active.index];
    if (cell === undefined) throw new Error(`no target ${active.index}`);
    mark(undefined, 'answer');
    if (active.mode === 'targets') {
      active.phase = 'round';
      active.roundStart = now;
      mark(cell, 'target');
      showRailTarget(rail, stepOfCell(cell));
    } else {
      active.phase = 'hear';
      active.phaseStart = now;
      mark(undefined, 'target');
      showRailTarget(rail, null);
      replayButton.disabled = false;
      playCell(cell);
    }
  }

  // Plays a cell, and drops the microphone input meanwhile, so the speaker does not light a cell.
  function playCell(cell: number): void {
    voice.pause();
    sounds.place('X', cell);
    setTimeout(() => voice.resume(), HEAR_MS - 200);
  }

  function nextRound(active: Run, now: number): void {
    active.index++;
    if (active.index < active.cells.length) beginRound(active, now);
    else finish(active);
  }

  function step(active: Run, frame: VoiceFrame): void {
    const { now } = frame;
    const total = active.times.reduce((sum, time) => sum + time, 0);
    if (active.phase === 'countdown') {
      const left = active.phaseStart + COUNTDOWN_MS - now;
      roundEl.textContent = left > 0 ? `${Math.ceil(left / 1000)}…` : 'Go!';
      if (left <= 0) beginRound(active, now);
      return;
    }
    roundEl.textContent = `${active.mode === 'targets' ? 'Target' : 'Round'} ${active.index + 1} of ${active.cells.length}`;
    totalTimeEl.textContent = `total ${seconds(total + (active.phase === 'round' ? now - active.roundStart : 0))}`;
    const cell = active.cells[active.index];
    if (cell === undefined) throw new Error(`no target ${active.index}`);
    if (active.phase === 'hear') {
      roundTimeEl.textContent = 'Listen…';
      if (now - active.phaseStart >= HEAR_MS) {
        active.phase = 'round';
        active.roundStart = now;
      }
      return;
    }
    if (active.phase === 'reveal') {
      if (now - active.phaseStart >= REVEAL_MS) nextRound(active, now);
      return;
    }
    const elapsed = now - active.roundStart;
    roundTimeEl.textContent = seconds(elapsed);
    const { holdMs } = PRESETS[active.preset];
    // The hold counts from the start of the round: a cell held from the round before does not count at once.
    const heldFor = frame.held === null ? 0 : now - Math.max(frame.held.since, active.roundStart);
    if (active.mode === 'targets') {
      showHeat(frame, cell);
      if (frame.cell === cell && heldFor >= holdMs) hit(active, cell, Math.round(elapsed), now);
      else if (elapsed >= MAX_ROUND_MS) hit(active, cell, MAX_ROUND_MS, now);
      return;
    }
    // Echo: the first cell that the player holds is the answer.
    const answer = frame.cell !== null && heldFor >= holdMs ? frame.cell : null;
    if (answer === null && elapsed < MAX_ROUND_MS) return;
    const points = answer === null ? 0 : echoPoints(cell, answer);
    active.times.push(Math.min(MAX_ROUND_MS, Math.round(elapsed)));
    active.points.push(points);
    active.phase = 'reveal';
    active.phaseStart = now;
    replayButton.disabled = true;
    mark(cell, 'target');
    mark(answer ?? undefined, 'answer');
    showRailTarget(rail, stepOfCell(cell));
    if (points === ECHO_POINTS) cells.burst(cell);
    show(
      answer === null
        ? `Time is up. It was ${describe(cell)}.`
        : points === ECHO_POINTS
          ? `Right: ${describe(cell)}. ${points} points.`
          : `It was ${describe(cell)}. You sang ${describe(answer)}. ${points} points.`,
    );
  }

  function hit(active: Run, cell: number, ms: number, now: number): void {
    const index = active.times.length;
    active.times.push(ms);
    cells.burst(cell);
    voice.pause();
    sounds.place('X', cell);
    setTimeout(() => voice.resume(), 300);
    show(ms >= MAX_ROUND_MS ? 'Time is up for this target.' : `Hit in ${seconds(ms)}.`);
    const id = active.playoffId;
    if (id !== null && session !== undefined) {
      const { code } = session;
      hits = hits.then(() => api.playoff(code, { action: 'hit', id, index, ms }).then(showSession)).catch(showProblem);
    }
    nextRound(active, now);
  }

  function clearRun(): void {
    run = undefined;
    voice.overrideStickiness(null);
    mark(undefined, 'target');
    mark(undefined, 'answer');
    showRailTarget(rail, null);
    showHeat(null, null);
    replayButton.disabled = true;
    roundTimeEl.textContent = '';
  }

  function finish(active: Run): void {
    clearRun();
    const summary = summarize(active.times);
    const score = active.mode === 'echo' ? active.points.reduce((sum, points) => sum + points, 0) : active.cells.length;
    const key = presetKey(active.mode, active.preset);
    const before = bests[key];
    const result = { totalMs: summary.totalMs, score };
    const isBest = before === undefined || beats(active.mode, result, before);
    if (isBest) {
      bests = { ...bests, [key]: { ...result, at: Date.now() } };
      saveBests();
    }
    roundEl.textContent = 'Done';
    totalTimeEl.textContent = `total ${seconds(summary.totalMs)}`;
    show(isBest ? `A new best: ${scoreText(active.mode, result)}!` : `Done: ${scoreText(active.mode, result)}.`);
    showSummary(active, summary, score, isBest);
    showBests();
    updateButtons();
    const runId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `run-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    api
      .practiceRun({ id: runId, mode: active.mode, preset: active.preset, roundMs: active.times, score })
      .then(() => showBoard())
      .catch((error: unknown) => {
        if (!(error instanceof OnlineError)) throw error;
        boardNote.textContent = 'This run is not on the leaderboard: the server did not answer. Your best stays on this device.';
      });
  }

  function showSummary(active: Run, summary: ReturnType<typeof summarize>, score: number, isBest: boolean): void {
    const echo = active.mode === 'echo';
    const table = document.createElement('table');
    table.className = 'practice-table';
    const head = table.createTHead().insertRow();
    for (const title of ['#', 'Cell', 'Time', ...(echo ? ['Points'] : [])]) head.append(Object.assign(document.createElement('th'), { textContent: title }));
    const body = table.createTBody();
    active.times.forEach((time, index) => {
      const row = body.insertRow();
      const values = [String(index + 1), describe(active.cells[index] ?? 0), seconds(time), ...(echo ? [String(active.points[index] ?? 0)] : [])];
      for (const value of values) row.insertCell().textContent = value;
      if (time === summary.bestMs) row.className = 'fastest';
    });
    const facts = document.createElement('p');
    facts.className = 'practice-facts';
    facts.textContent = `Total ${seconds(summary.totalMs)} · average ${seconds(summary.averageMs)} · fastest ${seconds(summary.bestMs)}${echo ? ` · ${score} of ${ECHO_POINTS * active.cells.length} points` : ''}${isBest ? ' · new best!' : ''}`;
    summaryEl.replaceChildren(facts, table);
  }

  function stopRun(message: string): void {
    if (run === undefined) return;
    clearRun();
    roundEl.textContent = 'Stopped';
    show(message);
    updateButtons();
  }

  // The Start button: Stop during a run. In the playoff tab it starts or joins a playoff, and waits while the
  // other player has not joined.
  function updateButtons(): void {
    const playoff = playoffOf();
    const you = session?.view.you ?? null;
    const active = playoff !== null && playoff.ended === null && you !== null;
    const joined = active && playoff.seats[you].joined;
    const invited = active && !playoff.seats[you].joined;
    const running = run !== undefined;
    if (tab === 'playoff') {
      startButton.textContent = running ? 'Stop' : joined ? 'Waiting…' : invited ? 'Join the playoff' : 'Start a playoff';
      startButton.disabled = !running && (session === undefined || you === null || joined);
    } else {
      startButton.textContent = running ? 'Stop' : 'Start';
      startButton.disabled = false;
    }
    leaveButton.hidden = !active;
    // A run keeps its level. A playoff takes the level of its starter.
    for (const button of levels.querySelectorAll('button')) button.disabled = running || joined || invited;
    replayButton.hidden = tab !== 'echo';
    // Without a seat in an online game, the Playoff tab shows only how to start one (practice.css).
    const noPlayoff = tab === 'playoff' && !running && (session === undefined || you === null);
    panel.toggleAttribute('data-no-playoff', noPlayoff);
    resultsEl.hidden = tab === 'free' || noPlayoff;
    statusEl.dataset.state = running ? 'running' : 'idle';
  }

  // ---- Playoff ----

  function showProblem(error: unknown): void {
    if (!(error instanceof OnlineError)) throw error;
    show(error.message);
  }

  function setBar(bar: HTMLDivElement, count: number): void {
    bar.style.setProperty('--level', String(count / ROUNDS.targets));
    bar.setAttribute('aria-valuenow', String(count));
  }

  function seatName(view: SessionView, seat: 'X' | 'O'): string {
    return view.players[seat]?.login ?? view.names[seat] ?? seat;
  }

  function playoffMessage(playoff: Playoff, you: 'X' | 'O', themName: string): string {
    const mine = playoff.seats[you];
    const theirs = playoff.seats[you === 'X' ? 'O' : 'X'];
    if (playoff.ended === 'declined') return `${themName} said not now. Tap Start a playoff to ask again.`;
    if (playoff.ended === 'left') return 'The playoff ended early.';
    if (playoff.ended === 'done') {
      const winner = playoffWinner(playoff);
      const gap = Math.abs(mine.times.reduce((a, b) => a + b, 0) - theirs.times.reduce((a, b) => a + b, 0));
      return winner === null ? 'A tie!' : winner === you ? `You win by ${seconds(gap)}!` : `${themName} wins by ${seconds(gap)}.`;
    }
    if (!mine.joined) return `${themName} invited you to a sound playoff. Tap Join the playoff to turn on the mic and join.`;
    if (!theirs.joined) return `Waiting for ${themName} to join…`;
    return `${PRESETS[playoff.preset].name} playoff against ${themName}: ${ROUNDS.targets} targets.`;
  }

  // A new view of the online game: show the playoff, and start its run when both joined.
  function showSession(view: SessionView): void {
    if (session === undefined || view.code !== session.code || view.version < session.view.version) return;
    const before = session.view.playoff;
    session = { code: session.code, view, offset: view.now - Date.now() };
    const { you, playoff } = view;
    // A change of the seats ends the playoff (src/session/core.ts): the server sets it to null.
    if (before !== null && before.ended === null && playoff === null) {
      if (run?.playoffId === before.id) stopRun(SEATS_CHANGED);
      else show(SEATS_CHANGED);
    }
    if (you === null) {
      playoffText.textContent = 'You do not hold a seat in this game now, so a playoff is not possible. Try Targets or Echo.';
      return updateButtons();
    }
    const them = you === 'X' ? 'O' : 'X';
    const themName = seatName(view, them);
    raceThemName.textContent = themName;
    if (playoff === null) {
      playoffText.textContent = view.seats[them]
        ? `Tap Start a playoff to invite ${themName}: the same targets, at the same time.`
        : 'The other seat is empty. Invite a player to the game first.';
    } else {
      setBar(raceYou, playoff.seats[you].times.length);
      setBar(raceThem, playoff.seats[them].times.length);
      playoffText.textContent = playoffMessage(playoff, you, themName);
      if (playoff.ended === 'left' && run?.playoffId === playoff.id) stopRun(`${themName} left the playoff.`);
      if (playoff.ended === null && playoff.startAt !== null && playoff.seats[you].joined && run?.playoffId !== playoff.id && voice.isListening()) {
        // Both pages start at startAt, server time.
        const countdownEnd = performance.now() + (playoff.startAt - (Date.now() + session.offset));
        run = newRun('targets', playoff.preset, playoff.seed, playoff.id, countdownEnd);
      }
    }
    updateButtons();
  }

  function leavePlayoff(): void {
    const playoff = playoffOf();
    if (session === undefined || playoff === null || playoff.ended !== null) return;
    api.playoff(session.code, { action: 'leave', id: playoff.id }).then(showSession).catch(showProblem);
  }

  async function startPressed(): Promise<void> {
    if (run !== undefined) {
      const inPlayoff = run.playoffId !== null;
      stopRun('Stopped.');
      if (inPlayoff) leavePlayoff();
      return;
    }
    if (!(await startMic())) return;
    if (tab !== 'playoff') {
      run = newRun(modeOfTab(), chosenPreset(), newSeed(), null, performance.now() + COUNTDOWN_MS);
      updateButtons();
      return;
    }
    if (session === undefined || session.view.you === null) return;
    const { code, view } = session;
    const playoff = view.playoff;
    const you = session.view.you;
    // Join the invite of the other player, or start a playoff that invites them.
    const request =
      playoff !== null && playoff.ended === null && !playoff.seats[you].joined
        ? ({ action: 'join', id: playoff.id } as const)
        : ({ action: 'start', preset: chosenPreset(), seed: newSeed() } as const);
    try {
      showSession(await api.playoff(code, request));
    } catch (error) {
      showProblem(error);
    }
  }

  startButton.addEventListener('click', () => void startPressed());
  replayButton.addEventListener('click', () => {
    const cell = run?.cells[run.index];
    if (run?.mode === 'echo' && run.phase !== 'reveal' && cell !== undefined) playCell(cell);
  });
  leaveButton.addEventListener('click', () => {
    stopRun('You left the playoff.');
    leavePlayoff();
  });
  for (const button of levels.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      for (const other of levels.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
      showSetup();
    });
  }

  return {
    running: () => run !== undefined,
    setTab(next: Tab): void {
      tab = next;
      panel.hidden = tab === 'free';
      playoffEl.hidden = tab !== 'playoff';
      if (tab === 'playoff' && session === undefined) {
        playoffText.textContent = 'A playoff runs in an online game. In the game, open the Voice room from the panel, and the other player gets an invite.';
      }
      roundEl.textContent = 'Ready';
      totalTimeEl.textContent = '';
      showHeat(null, null);
      updateButtons();
      if (tab !== 'free') showSetup();
    },
    frame(frame: VoiceFrame): void {
      if (run !== undefined) step(run, frame);
    },
    // The hold fill of the lit cell during a round: the hold counts from the start of the round, as in
    // step. A Targets round fills the target only, because no other cell counts.
    holdFill(frame: VoiceFrame): HoldFill | null {
      if (run === undefined || run.phase !== 'round' || frame.held === null || frame.cell === null) return null;
      if (run.mode === 'targets' && frame.cell !== run.cells[run.index]) return null;
      const heldFor = frame.now - Math.max(frame.held.since, run.roundStart);
      return { share: heldFor / PRESETS[run.preset].holdMs, mark: 'X' };
    },
    // The microphone stopped: a run cannot go on.
    stopped(message: string): void {
      const inPlayoff = run?.playoffId !== null && run !== undefined;
      stopRun(message);
      if (inPlayoff) leavePlayoff();
    },
    settingsChanged(): void {
      if (tab !== 'free') showSetup();
    },
    openSession(code: Code): void {
      api
        .load(code)
        .then((view) => {
          if (view.you === null) {
            playoffText.textContent = 'You do not hold a seat in that game, so a playoff is not possible. Try Targets or Echo.';
            return;
          }
          session = { code, view, offset: view.now - Date.now() };
          api.subscribe(code, () => {
            api.load(code).then(showSession).catch(showProblem);
          });
          showSession(view);
        })
        .catch((error: unknown) => {
          if (!(error instanceof OnlineError)) throw error;
          playoffText.textContent = `The game ${code} does not open: ${error.message}`;
        });
    },
  };
}
