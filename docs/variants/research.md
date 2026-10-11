# New modes for tick3d

Research date: 11 October 2026. Repository snapshot: `4013ebe4bdac0e0bdee7252b146684fe451a74e1`.

This is a design report. It changes no game code. Rules below are proposals unless a passage names a published game. Scores, implementation costs and expected player responses are design judgments. Their performance in tick3d is **unverified**. Source labels link to the opened pages listed at the end.

## Summary

**1. Paired Match.** Play two ordinary games. Each person starts once. Add the two results. tick3d already alternates seats, so this adds a match boundary, locked conditions and a clear result. It addresses fairness between people without changing Qubic. Perfect first-player wins would make the pair a tie. It does not turn either game into a draw. Patashnik and Allis establish the problem this mode addresses. [B1] [B2]

**2. Fading Four.** Keep only the last four marks of each player. The oldest mark leaves before that player places a fifth. A threat now has an expiry date. Eight visible marks keep the phone, tower, flat views and blind play manageable. This is the first time mode to prototype. Disappearing tic-tac-toe has a real FIFO precedent. Its developer reports a first-player win on the 2D version, so fading is not evidence of balance by itself. The cube result is unverified. [A6] [C19]

**3. Relay Layers.** The column of a move chooses the layer where the opponent must play. Keep the existing cube and all 76 lines. This adds the tension of sending an opponent somewhere dangerous without nesting another cube inside every cell. Ultimate tic-tac-toe supplies the routing rule. Ultimate 3D also exists, so the broad concept is not new. The smaller four-layer adaptation is the proposal here. Its balance is unverified. [A5] [A14]

**4. Rewind One.** Each seat gets one action that restores one cell to its value four plies ago. It spends a turn. It leaves the accepted history and clocks intact. This makes the past a tactical resource while keeping one visible cube. Braid supplies deliberate rewind; Achron supplies a useful precedent for limiting how far history can change. The particular cube rule and its balance are unverified. [A7] [A11]

**5. Daily Tactics.** Publish a reachable position with a proved win in one, two or three own moves. Everyone gets the same challenge. Share the puzzle number and result without the solution. This gives a solved game a useful practice loop. Qubic already has a public app with daily puzzles and analysis. Lichess supplies a precedent for generating tactics from real games. tick3d needs proof certificates; its current hard AI is a bounded search, not a complete solver. [D1] [D2]

Start with Paired Match and a small certified puzzle set. Prototype Fading Four next. Treat Relay Layers, Rewind One and Echo Move as separate experiments. Do not combine mutators until each rule is readable and tested on its own.

## Ranked ideas

### What the current code permits

The required files were read before the external research. These are the implementation constraints, not proposed changes.

| Area | Current behavior | Consequence for a variant |
| --- | --- | --- |
| `README.md`, `src/game.ts` | `SIZE = 4`. There are 64 cells and 76 lines. X starts. Four marks win. A full cube draws. | Keep this as the `classic` profile. Larger boards need more than a changed constant. |
| `src/ai.ts` | Easy, medium and hard use classic wins, blocks, threats and bounded search. Hard restricts search and has a time budget. | Reuse the worker infrastructure. Do not call this a Qubic proof engine. |
| `src/move-search.ts`, `src/ai-worker.ts` | A worker receives a 64-cell board and returns one empty cell. | Queues, past states, controllers and compound actions need a new request and answer shape. The search itself lives in `src/ai.ts`. |
| `src/session/core.ts` | One pure rule path serves the server, the device and the Nearby host. It validates seats, turn, game number and move count. | Every variant transition and derived result must run here. A page-only rule is insufficient. |
| `src/session/format.ts` | `CURRENT_FORMAT = 1`. `UPGRADES` is empty. Optional fields get defaults. Stored games are validated by classic replay. | Optional metadata can stay at format 1. A changed action history or changed replay meaning needs a format upgrade. |
| `src/protocol.ts`, `server/api-docs.ts` | Records contain `moves`, `times`, `clock` and `timedOut`. Moves are cells 0–63, at most 64, with classic replay. | A `variant` label alone cannot support repeat placements, non-placement actions or play after a line. Update imports, result uploads and OpenAPI too. |
| `src/board/`, `src/page/` | One cube, a tower rotated by dragging, and four flat layouts. | Keep coordinates tied to the board axes. Rotation of the camera must never change a rule coordinate. Use a slice selector for extra dimensions. |
| `src/clock.ts` | The first move of each seat is untimed. Clocks infer the mover from move parity. Per-move limits are 3–600 seconds; per-game limits are 30–7,200 seconds. | A landing is not a new clock turn. Pie decisions and compound turns need explicit handling. A days-long correspondence clock is a real extension. |
| `src/song.ts`, `src/sound*.ts`, `src/voice/` | Songs and sounds use cell history. Voice input selects cells. Classic sound does not distinguish every coordinate. | Use a coordinate sound set for ear-only play. Non-placement actions need controls and sound events of their own. |
| `src/session/core.ts`, `src/session-link.ts` | Undo replays a shorter history. Shared undo needs consent and only removes the caller's last move before the reply. Timed or locked games forbid it. Links can show history; `watch=1` is an explicit spectator link. | Replay the entire variant state on undo. Spectators and links need the rule version and full public action history. |

`hideBoard`, `hideHistory` and `hideCoordinates` are presentation options. `viewOf` still sends game records to players and spectators. They are suitable for voluntary blind play. They are not a secure fog-of-war system. The repository also has ear training and a friendly sound playoff. Ear modes below build on those features; they do not claim to invent them.

Online and Nearby games already swap seats between games unless seats are fixed. The existing seat swap is a consent action available during play. A pie opening is a different rule: the second person has a one-time opening choice without needing the opener's permission.

### Scores

All seven columns use 1–5, with 5 preferred. Total is the unweighted sum, out of 35. Ties use editorial priority: readable time rules, useful practice, then launch scope.

| Score | Meaning |
| --- | --- |
| Fun | A useful choice, a visible consequence and a reason to replay. Proposed-mode enjoyment is unverified. |
| Fit | Phone input, tower, flat view and blind play together. |
| Balance | Effect on the first-player problem. 1 leaves it intact; 2 has weak grounds; 3 merits analysis but is unverified; 4 removes an ordering advantage or gives the same challenge; 5 gives each person equal starts in a completed pair. This is not a claim that an unsolved rule is a draw. |
| Online | Ease of deterministic validation and safe public views. A private server state is possible but costs more. |
| AI | How much of the current worker and search can remain useful. |
| Cost | **S = 5**, **M = 3**, **L = 1**. S is a small extension. M adds a rule adapter or workflow. L changes geometry, information, search or participants substantially. These are estimates, not schedules. |
| Novelty | 1 has a cube precedent or is already close to tick3d; 2–3 adapts a close precedent; 4–5 has no confirmed exact cube implementation in this search. Absence of an implementation is **unverified**, not proof of originality. |

Player reactions help identify useful risks. Chronotron comments praise cooperation with a past self and complain about slow recorded actions. A loop puzzle should therefore allow quick event stepping; that is a design inference, not a measured preference. The Qubic app's reviews praise learning and ask for more competition. These anecdotes inform Fun, but do not verify the scores of proposed modes. [A8] [D1]

A, B, C and D refer to the requested research categories. The precise launch rules for ranks 1–10 appear below. Other rows are candidates, not complete specifications.

| Rank | Name | One-line rule | Category | Fun | Fit | Balance | Online | AI | Cost | Novelty | Total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Paired Match | Two classic games; each person starts once; add results. [B1] [D6] | D | 4 | 5 | 5 | 5 | 5 | S: 5 | 1 | 30 |
| 2 | Fading Four | Remove your oldest mark before placing your fifth active mark. [A6] | A | 5 | 5 | 3 | 5 | 3 | M: 3 | 4 | 28 |
| 3 | Relay Layers | Your column sends the opponent to that numbered layer. [A5] [A14] | A | 5 | 5 | 3 | 5 | 4 | M: 3 | 3 | 28 |
| 4 | Rewind One | Once per seat, spend a turn restoring one cell from four plies ago. [A7] [A11] | A | 5 | 4 | 3 | 5 | 3 | M: 3 | 5 | 28 |
| 5 | Daily Tactics | Solve the same certified win-in-N position each day. [D1] [D2] | D | 5 | 5 | 4 | 5 | 4 | M: 3 | 1 | 27 |
| 6 | Pie Opening | After the first X, the second person keeps O or takes X. [C5] [C6] | C | 4 | 5 | 3 | 5 | 4 | M: 3 | 3 | 27 |
| 7 | Echo Move | Once per seat, place now and queue one extra mark to land two plies later if empty. [A12] | A | 4 | 4 | 3 | 5 | 3 | M: 3 | 5 | 27 |
| 8 | Replay Clinic | Review a finished game with proved tactics and explicitly uncertain evaluations. [D1] [C17] | D | 4 | 5 | 2 | 5 | 4 | M: 3 | 2 | 25 |
| 9 | Full Cube Score | Fill the cube; count each completed line once; most lines wins. [B9] [C21] | C | 4 | 5 | 3 | 5 | 3 | M: 3 | 2 | 25 |
| 10 | Gravity Cube | Choose a row and column; your mark falls to the lowest free layer. [B16] [B17] | B | 4 | 5 | 3 | 5 | 4 | M: 3 | 1 | 25 |
| 11 | Handicap Draft | Offer three public starting positions; the other person selects position and side. [C5] [C4] | C | 4 | 5 | 3 | 5 | 3 | M: 3 | 2 | 25 |
| 12 | Team Relay / Co-op | Share a color against another team or the computer; alternate teammates' moves. [C11] [C20] [D10] | C/D | 4 | 5 | 2 | 5 | 4 | M: 3 | 2 | 25 |
| 13 | Misère Four | Completing your own four loses; a full board without a line draws. [B3] [C1] | C | 4 | 5 | 2 | 5 | 4 | M: 3 | 2 | 25 |
| 14 | Layer Twist / Slide | Place, then quarter-turn or cyclically shift one layer; check after the whole turn. [C12] [C11] | B | 5 | 4 | 3 | 5 | 2 | L: 1 | 4 | 24 |
| 15 | Correspondence League | Play paired classic matches with days per move and league rounds. [C17] [D6] | D | 4 | 5 | 1 | 5 | 5 | M: 3 | 1 | 24 |
| 16 | Ear-only Duel | Hide the board; hear every accepted coordinate; use keypad or voice to play. [D8] | D | 3 | 4 | 1 | 5 | 5 | S: 5 | 1 | 24 |
| 17 | Tactics Gauntlet | Solve a fixed puzzle sequence against one server clock. [D3] | D | 4 | 5 | 2 | 5 | 4 | M: 3 | 1 | 24 |
| 18 | Wild Four | Either person places X or O; the person completing any line wins. [C1] | C | 4 | 5 | 2 | 5 | 3 | M: 3 | 2 | 24 |
| 19 | Notakto Cube | Both place X; the actor completing four loses; a full cube without four draws. [C2] [C3] | C | 3 | 5 | 3 | 5 | 3 | M: 3 | 2 | 24 |
| 20 | Obstacle Cube | Public blocked cells remove routes; moving a blocker spends a turn. [C1] | B/C | 4 | 4 | 3 | 5 | 3 | M: 3 | 1 | 23 |
| 21 | Branch Lab | Fork a replay prefix into a separate practice game and compare continuations. [A1] [C17] | A/D | 3 | 4 | 1 | 5 | 5 | M: 3 | 2 | 23 |
| 22 | Connect Two | X places one opening mark; later turns place two marks, checking after the turn. [C7] [C8] | C | 4 | 4 | 3 | 5 | 2 | M: 3 | 2 | 23 |
| 23 | Avoider–Enforcer | Avoider places X and must avoid four; Enforcer places O to exhaust safe choices. [C10] | C | 3 | 4 | 3 | 5 | 2 | M: 3 | 3 | 23 |
| 24 | Simultaneous Reveal | Both choose secretly; reveal together; a collision blocks the cell; dual wins draw. [C16] [C18] | C | 4 | 4 | 4 | 3 | 2 | L: 1 | 4 | 22 |
| 25 | Ghost Race | Solve the same puzzle playlist alongside the visible pace of a saved attempt. [D7] [D3] | D | 4 | 4 | 1 | 4 | 4 | M: 3 | 2 | 22 |
| 26 | Order and Chaos | Both place either symbol; Order wants any four; Chaos wants a full cube without four. [C1] | C | 4 | 4 | 2 | 5 | 2 | M: 3 | 2 | 22 |
| 27 | Mutator Run | A seeded sequence of computer matches offers public rule mutators between stages. [D4] | D | 5 | 4 | 2 | 4 | 2 | L: 1 | 4 | 22 |
| 28 | Loop Puzzle | Earlier attempts become fixed ghost actions in a short deterministic puzzle loop. [A8] [A9] [A10] | A/D | 4 | 3 | 2 | 5 | 2 | L: 1 | 5 | 22 |
| 29 | Temporal Relay | Play in four independent time cubes; your cell's column selects the next time cube. [A5] | A | 4 | 3 | 3 | 5 | 2 | L: 1 | 4 | 22 |
| 30 | Open Power Draft | Draft public one-use block, remove or two-cell-swap actions before play. [C20] | C | 4 | 4 | 3 | 5 | 2 | L: 1 | 3 | 22 |
| 31 | Melody Bonus | Fill the cube; add a fixed bonus for lines matching a public pitch pattern. [D9] | D/C | 3 | 4 | 1 | 5 | 3 | M: 3 | 3 | 22 |
| 32 | Maker–Breaker | Maker owns X and seeks a line; Breaker places O only to stop all lines. [C10] [B1] | C | 4 | 4 | 1 | 5 | 2 | M: 3 | 2 | 21 |
| 33 | Quantum Cube | Place numbered pairs of spooky marks; a cycle gives the opponent a collapse choice. [A4] | A | 5 | 2 | 3 | 5 | 1 | L: 1 | 4 | 21 |
| 34 | Toroidal Cube | Lines wrap on all three axes, using the exact 208-line manifest below. [B13] [B14] | B | 4 | 3 | 2 | 5 | 3 | M: 3 | 1 | 21 |
| 35 | Centerless Cube | Use 3×3×3, forbid the center, and keep only the 36 surviving three-cell lines. [B11] | B | 3 | 4 | 3 | 5 | 3 | L: 1 | 2 | 21 |
| 36 | Quixo Push | Remove an eligible edge cell, change it to your mark and push it back through a row. [C11] | C | 4 | 3 | 3 | 5 | 2 | L: 1 | 3 | 21 |
| 37 | Capture Four | Make a line to earn one removal; play to a target line score with a ply cap. [C21] | C | 4 | 4 | 3 | 5 | 2 | L: 1 | 2 | 21 |
| 38 | Richman Bidding | Bid chips for the next placement; pay the bid to the opponent; use a tie-priority token. [C9] | C | 4 | 3 | 3 | 4 | 2 | L: 1 | 4 | 21 |
| 39 | Stack Capture | Three public piece sizes can cover smaller marks; only top marks count. [C14] [C15] | C | 4 | 3 | 3 | 5 | 2 | L: 1 | 2 | 20 |
| 40 | Snapshot Lines | Check selected space-time lines across four consecutive board snapshots. [B3] | A | 4 | 2 | 1 | 5 | 1 | L: 1 | 5 | 19 |
| 41 | Multiverse Match | Spend a charge to fork an earlier cube; active branches contribute to a match score. [A1] [A2] | A | 5 | 1 | 2 | 5 | 1 | L: 1 | 4 | 19 |
| 42 | Five Cube | Play 4-in-a-row on 5×5×5, with 302 winning segments. [B3] [B13] | B | 4 | 3 | 2 | 5 | 2 | L: 1 | 1 | 18 |
| 43 | Three-player Cube | X, O and a third symbol rotate turns; first four wins. [C15] [C19] | C | 4 | 4 | 3 | 4 | 1 | L: 1 | 1 | 18 |
| 44 | Sphere Tracks | Play on a discrete spherical graph with a fixed, published set of four-cell routes. [B15] | B | 3 | 2 | 2 | 5 | 2 | L: 1 | 2 | 17 |
| 45 | Tesseract | Place in 4×4×4×4; four along any of the 520 straight lines wins. [B12] [B13] | B | 4 | 2 | 2 | 5 | 1 | L: 1 | 1 | 16 |

### Costs outside the top ten

These file bundles name actual repository boundaries. A bundle means those files need review and likely changes; it does not imply every file needs the same edit.

- **G, rule and wire:** `src/game.ts`, `src/session/core.ts`, `src/session/format.ts`, `src/protocol.ts`, `server/api-docs.ts`, `server/main.ts`.
- **W, search:** `src/ai.ts`, `src/move-search.ts`, `src/ai-worker.ts`.
- **U, board and controls:** `src/board/board.ts`, `src/board/view-controls.ts`, `src/page/board.ts`, `src/page/game-view.ts`, `src/page/keypad.ts`.
- **R, records:** `src/session-link.ts`, `src/page/results.ts`, `server/stats.ts`, `src/song.ts`.
- **S, sound and voice:** `src/sound.ts`, `src/sound-sets.ts`, `src/voice/engine.ts`, `src/voice/mapping.ts`, `src/sound-training/main.ts`, `src/practice/playoff.ts`.

Format **2** below means one breaking upgrade from the current format 1, shared by the new rule envelope. It does not mean a new migration for every mode. Format **1** means classic game records remain valid; new optional metadata gets a default in `parseDoc`, or a separate feature store holds it.

| Candidates | Cost | Files beyond any new mode module | Stored-format decision |
| --- | --- | --- | --- |
| Handicap Draft | M | G, W, U, R | 2. A starting-position manifest changes replay from an empty cube. |
| Team Relay / Co-op | M | G, U, R; `src/page/players.ts` | 2. Team controller lists and within-team turn order change seat semantics. |
| Misère, Wild, Maker–Breaker, Order and Chaos, Notakto Cube, Avoider–Enforcer | M | G, W, U, R | 2. Same cells; different winners or actors. Explicit mark and actor replace the parity assumption where needed. |
| Layer Twist / Slide, Quixo Push, Capture Four, Stack Capture | L | G, W, U, R, S | 2. Persist compound actions, transformations or piece stacks. |
| Correspondence League | M | `src/clock.ts`, `src/session/core.ts`, `src/session/format.ts`, `src/protocol.ts`, `server/api-docs.ts`, `server/main.ts`, `server/stats.ts`, `src/page/clocks.ts` | 2 for a new correspondence clock shape. League membership alone is optional metadata. |
| Ear-only Duel | S | S; `src/page/settings.ts`, `src/page/game-view.ts`, `src/page/keypad.ts` | 1. Classic moves; a shared voluntary presentation preset. No evidence that a client actually hid its screen. |
| Tactics Gauntlet, Ghost Race | M | W; `src/session/core.ts`, `src/session/format.ts`, `src/protocol.ts`, `server/api-docs.ts`, `server/main.ts`, `src/page/game-view.ts`, `src/page/results.ts` | 1. Separate attempt metadata and server timing; do not turn client elapsed time into a ranked score. |
| Obstacle Cube | M | G, W, U, R | 2. Add a public blocker manifest and blocker-move actions. Static holes are the smaller first experiment. |
| Branch Lab | M | `src/session/core.ts`, `src/session/format.ts`, `src/protocol.ts`, `server/api-docs.ts`, `server/main.ts`, `src/session-link.ts`, `src/page/game-view.ts` | 1 if a new classic session copies a legal prefix. Parent game ID and prefix length default to null. Do not edit the parent. |
| Connect Two | M | G, W, U, R; `src/clock.ts` | 2. A turn contains two cells and one clock debit. Pair search is larger than cell search. |
| Simultaneous Reveal, Richman Bidding | L | G, W, U, R; `src/clock.ts`, `src/nearby/session.ts` | 2. Private choices, reveal phases and independent deadlines replace alternating public moves. |
| Mutator Run | L | G, W, U, R | 2 for non-classic stages. Persist the public seed, PRNG version, stage manifest and chosen powers. A classic-only puzzle campaign can stay at 1. |
| Loop Puzzle, Temporal Relay, Quantum Cube, Snapshot Lines, Multiverse Match | L | G, W, U, R, S; `src/clock.ts` | 2. Histories, queues, graph edges or several active boards are part of the state. |
| Open Power Draft | L | G, W, U, R | 2. Draft order, remaining powers and each power's action are public and replayable. Hidden hands would require more work. |
| Melody Bonus | M | G, W, R, S; `src/page/game-view.ts` | 2. Use fixed integer pitch classes and a scoring manifest. Audio rendering and microphone pitch do not decide points. |
| Toroidal Cube | M | G, W, U, R | 2. Keep 64 cells; replace the line manifest and make wrapped routes visible. W-axis already offers cube wrapping. [B13] |
| Centerless Cube, Five Cube, Sphere Tracks, Tesseract | L | G, W, U, R, S | 2. Board shape, cell range or coordinate count changes. Audit every use of `SIZE`, `CELL_COUNT`, `Line` and 64-cell validation. |
| Three-player Cube | L | G, W, U, R, S; `src/clock.ts`, `src/page/players.ts` | 2. Replace X/O-only seats, marks, winner, `other()` and two-player evaluation. |

For every new rules profile, partition stats and survival records by rule ID. Do not compare a fading game's 160 actions with classic survival placements. Public game imports, offline uploads and songs must replay the same versioned rules as the live session.

## Deep dives

### Shared contract for these designs

The following rules apply to all ten designs unless their own paragraph gives an exception.

Coordinates below are **one-based layer, row, column**. `111` is index 0. `222` is index 21. `444` is index 63. Layer 1 is the bottom. API placement cells remain zero-based: `(L - 1) * 16 + (R - 1) * 4 + C - 1`.

Keep each game's rule ID, rule version and parameters immutable from its first action. The pure transition in `src/session/core.ts` is the authority for local, computer, online and Nearby play. The server supplies `now` for clock settlement. Temporal effects use accepted **plies**, not animation frames, page uptime or network arrival order.

For changed rules, use a format-2 envelope with `rules: { id, version, params }` and `actions`. Each action records its actor, input and accepted timestamp. Keep a separate action count and placement count. Derived boards, queues and scores may be cached, but replay verifies them. Add `UPGRADES[1]` to map each old `moves[i]` and `times[i]` into a classic placement. Preserve `clock`, `timedOut`, games, seats, `flipped` and optional document fields. Keep a format-1 fixture and add a format-2 fixture.

Expose rules and legal actions in `SessionView`. Document the action union, constraints, draw reasons and examples in `server/api-docs.ts`. Add `POST /api/sessions/{code}/actions` with `game`, `actionCount` and a discriminated action. Keep `/moves` as a classic compatibility route. Preserve stale-state checks and `Idempotency-Key`; duplicate requests must never spend two charges. Update `server/main.ts` dispatch with the documented route. An agent using `/api/openapi.json` must be able to understand the rule without reading the webpage. Unknown rule versions fail explicitly.

Resolve expiry, landing or transformation inside one atomic action. Settle an existing timeout before accepting it. No effect runs after a terminal result. The first placement of each seat stays untimed. Later action time belongs to its actor. Automatic effects use no extra clock turn. Changed action types require an actor-based clock adapter in `src/clock.ts` where parity no longer suffices.

Practice undo follows the existing live, untimed, unlocked and consent restrictions. It removes one complete last action and replays the prefix. It restores charges, queues, ages and repetition counts. It never removes half of an action. Rated matches and certified first-attempt results forbid undo. A restart is a separate attempt. Finished links are read-only. Links and spectators receive the public rule envelope and action history, including automatic effects derived from it. They see the same result as the players.

Keep the existing tower and flat controls. Place a new action control in a fixed slot, consistent with the README's layout rules. Blind play gets a coordinate announcement plus an action announcement. Voice selects a coordinate after the user chooses an action; it does not infer a rewind, swap or drop from an ambiguous pitch.

### 1. Paired Match

**Rules.** Start only with both participants assigned. Play two classic games with the same clock, computer level, tuning and presentation preset. A plays X in game one; B plays X in game two. A win is 1 point, a draw is 0.5, and a loss is 0. The larger total wins the pair. Equal totals draw. A timeout is an ordinary loss. An unfinished pair has no match result. A new pair cannot silently reuse half of an old one.

Lock seat assignments during each game and require the swap between games. For the initial release, make this a friendly match mode; a rating service is a separate project. Untimed practice may use ordinary undo before a reply. A competitive pair forbids undo and settings changes. A finished first game cannot be undone. An abandoned pair stays incomplete unless an active clock produces the second result. This avoids inventing a quit-forfeit rule.

**Example.** In game one, A plays `111, 112, 113, 114`; B replies `211, 212, 321`. A wins on ply 7. In game two, B plays X with the same sequence and A supplies those O replies. B wins. The displayed match result is A 1, B 1: draw.

**UI.** Add “Game 1 of 2” above the existing score. After game one, show “B starts game two.” Keep the same tower and flat layouts. The result card shows both game links and the aggregate. Spectators see the same progress. Blind play needs only a spoken game number and starter change.

**Data and API.** Add optional `pair` metadata to `SessionDoc`: pair ID, first game index, public participant references and frozen settings. Derive the total from the two records and `flipped`; do not accept a submitted score. Default `pair` to null in `parseDoc`. **No new `CURRENT_FORMAT` is needed.** Both records remain classic. Change `src/session/core.ts`, `src/session/format.ts`, `src/protocol.ts`, `src/page/players.ts`, `src/page/game-view.ts`, `src/page/results.ts` and `server/api-docs.ts`. Document the optional pair request and pair view on the existing session and new-game routes. Each ordinary game link remains valid; a pair link identifies both records. Cost: **S**.

**AI and balance.** The existing AI can play both games unchanged. Unlock the computer seats at the match level, then enforce the prescribed starts. At perfect play, the known first-player wins give one point to each person. This is a derivation about the pair, not a new solution of Qubic. Equal exposure does not guarantee equal practical difficulty against a particular bot. [B1] [B2]

**Precedents and novelty.** Lichess documents win/draw scoring and Swiss rounds. Allis explicitly discusses evaluating a solved-game program while it plays both sides equally often. tick3d already has the key seat alternation. The proposed addition is a fixed two-game unit. [D6] [B2]

### 2. Fading Four

**Rules.** Each color has an ordered queue of at most four active cells. On a turn, if that player's queue has four entries, remove the oldest entry first. Then place the player's mark in a cell empty on that resulting board and append it to the queue. The removed cell may be chosen again. The move is rejected without any expiry if its target is still occupied. Only the board after both steps is checked for a win.

Use the existing 76 lines. Four of your active marks win. The empty board is the first occurrence of its state. After each non-winning action, count the state `(turn, ordered X queue, ordered O queue)`. Its third occurrence draws. Also draw after 160 accepted plies if nobody won. A win on ply 160 takes precedence. No wall-clock expiry applies. A full-board draw cannot arise with eight active marks, but the engine still rejects an impossible corrupted state.

**Example.** Play `X111, O411, X122, O423, X133, O432, X124, O444`. X's queue is `[111,122,133,124]`. X now plays `114`. Remove `111`; X's queue becomes `[122,133,124,114]`. There is no line. Alternatively, X may replay `111`: the same cell becomes newest, and the queue becomes `[122,133,124,111]`.

**UI.** Show age 1–4 on the player's marks. Outline the next mark to leave. Fade older marks in both views, but do not use transparency alone: a small age label remains readable in the tower. Before confirmation, preview the outgoing and incoming cells together. Blind play announces “X 114; X 111 expired.” Keypad entry can name the expiring cell even though it was occupied before the move.

**Data and API.** Store `rules.id = fading-four`, version 1, queue limit 4, repetition limit 3 and ply cap 160. Derive queues and repetition counts from placement actions. Cache only with replay verification. **Use format 2:** a cell can recur and a log can exceed 64 actions. Change G, W, U and R; `src/clock.ts` must read the action timestamps rather than the old capped record. OpenAPI exposes the expiring cell and legal targets after expiry. An accepted undo restores the removed mark, former queue order and state counts. A timeout ends the game before any new expiry. Links and spectators show the full action sequence, not only eight surviving marks. Cost: **M**.

**AI and balance.** Send both ordered queues to the worker. Generate moves after expiry. A classic three-mark threat is not necessarily a threat if its oldest mark must leave. Use the shared transition in search and include queue order, turn, remaining cap and repetition context in the search key. Classic fork shortcuts need revalidation. Balance on this cube is **unverified**.

**Precedents and novelty.** Penguala implements FIFO three-mark tic-tac-toe and reports a solved first-player win from an edge opening. PartyAt also describes a three-piece Vanish mode. These are 2D precedents. No exact FIFO-four Qubic implementation was confirmed; cube novelty is **unverified**. [A6] [C19]

### 3. Relay Layers

**Rules.** X's opening may use any empty cell. After a placement at `(L,R,C)`, the next player must play in layer `C`. If that layer has no empty cells, the next player may use any empty cell. Their move again chooses the following layer by its column. The turn restriction depends on the physical column, not the camera's direction.

Keep every classic line, including lines between layers. Do not award ownership of a layer. The first four-in-a-row wins. A full cube without a win draws. This avoids trying to arrange four claimed layers into a nonexistent 4×4 meta-board. It is a routing variant of one cube, not full Ultimate 3D.

**Example.** `X112` sends O to layer 2. `O234` sends X to layer 4. `X421` sends O to layer 1. `O143` sends X to layer 3. Thus a harmless-looking placement can decide whether the opponent may reach a needed defensive cell.

**UI.** Brighten the legal layer and dim the other three. After selecting a cell, preview “Sends O to layer 2.” In the flat view, highlight the destination sheet. In the tower, use a border around the destination layer rather than hiding other layers. Keypad and voice reject coordinates in a locked-out layer with a clear explanation. A blind announcement includes both the move and the next layer.

**Data and API.** Add `rules.id = relay-layers`, version 1. Derive `forcedLayer` from the last action; expose its effective value or null when the destination is full. **Use format 2** for changed legality and versioned replay, although placement cells still fit the classic range. Change G, W, U and R. `server/api-docs.ts` documents the routing constraint, full-layer exception and `legalCells`. Existing placement inputs map to the placement action. Undo recomputes the destination from the surviving prefix. Ordinary clocks and full-board draws remain valid. Links and spectators show the restriction at each replay step. Cost: **M**.

**AI and balance.** The worker needs `forcedLayer` and the rule ID. Filter the current and future legal moves, not just the root move. A threat in an inaccessible layer cannot be treated as an immediate win or mandatory block. Reuse line evaluation and alpha-beta after those assumptions are corrected. The cube result is **unverified**; restriction alone is not a balance proof.

**Precedents and novelty.** Minimax.dev states Ultimate's destination rule and its unavailable-board escape. A public Ultimate 3D game routes between whole cubes. This proposal keeps a single 64-cell board and routes between its sheets. Its exact cube precedent is **unverified**. [A5] [A14]

### 4. Rewind One

**Rules.** Each seat starts with one rewind charge. Let `B_p` be the complete board after `p` accepted plies. On a turn at `p >= 4`, instead of placing, a player may select a cell whose current value differs from its value in `B_(p-4)`. Restore that one value, spend the charge and end the turn. The restored value can be empty, X or O. No other cell, accepted action, timestamp or player's turn is erased. There is no rewind action before four plies.

Check the entire resulting board. A line belongs to its mark owner, even if the opponent restored its last mark. If a rules extension ever yields both owners' lines in the same atomic action, draw. Otherwise a four wins. If the next player has neither an empty placement nor a legal charged rewind, draw; there is no pass. Draw at 96 plies if still live, with a win taking precedence. Charges belong to the X/O seats. A seat exchange does not refill them.

**Example.** `X111, O211, X122, O212, X134, O213` gives O three marks at `211–213`. X spends a rewind on `213`. Before that seventh action, `p = 6`, so its source is `B_2`. Cell `213` was empty there. O's `213` disappears, but ply 6 remains in history. O now plays `214`; O still lacks `213` and has no row of four.

**UI.** A “Rewind: 1” button enters target selection. Preview the cell's current value beside its value four plies ago. Only changed cells are selectable. A short scrub strip shows the source boundary. The tower uses one ghost mark at the target; the flat view uses a dashed old symbol. Blind play announces the boundary and exact replacement. Do not animate a whole cube running backward: that would imply clocks and turns were also undone.

**Data and API.** Store `rules.id = rewind-one`, version 1, lookback 4, one charge per seat and cap 96. Add `{kind: rewind, cell}` to the action union. Derive remaining charges and retain a five-boundary board window for simulation. **Use format 2.** Change G, W, U and R, plus `src/clock.ts` and action sound handling in `src/sound.ts`. OpenAPI returns remaining charges, legal rewind targets and the source action count. Practice undo refunds the action's charge through replay. Timeouts beat attempted rewinds. Public histories retain the rewind and original placements; spectators see the same source board. Cost: **M**.

**AI and balance.** Search both placements and legal rewinds. Include the recent board window, charges, actor and remaining cap in the search key. Evaluate threats after restoration. A board-only transposition is wrong: identical present cubes can have different legal rewinds. Balance and enjoyment on the cube are **unverified**.

**Precedents and novelty.** Braid uses controllable rewind. The archived Achron documentation describes a bounded mutable past and time propagation. Rewind One borrows the bounded-history choice, not Achron's real-time simulation. No exact one-cell cube rewind was confirmed; novelty is **unverified**. [A7] [A11]

### 5. Daily Tactics

**Rules.** A puzzle catalog entry contains a legal classic replay prefix, the side to move, a budget `N` of 1–3 own moves, a rule/version hash and a proof. Exclude already-finished starts. The goal is to force a classic win within the budget against every legal opposing reply. Count the challenger's placements, not total plies. Require a unique winning first cell for the first release. Uniqueness is about the budget, not all possible later wins.

Use a published deterministic defensive policy. Prefer a certified refutation after an incorrect move; otherwise choose the reply with greatest certified resistance, breaking ties by smallest cell index. The certificate must cover that policy and the advertised all-replies win. A move proved not to preserve a win within the remaining budget fails the attempt immediately. An opposing win, a board draw or budget exhaustion also fails. Unknown proof results never enter the certified catalog.

Choose the daily catalog ID by a published UTC date mapping. All devices get the same position. Untimed first attempts are the launch default. Restarts and hints are allowed as practice, but are labeled and do not replace the first-attempt result. An optional timed challenge uses a separate server-held challenge deadline from attempt creation, including the opening; this is not the ordinary game's untimed-opening clock.

**Example.** The prefix is `X111, O211, X112, O212, X113, O321`. X has one own move to win. `X114` completes the bottom row. A certificate checks every other empty first cell and rejects this example as a unique-answer puzzle if any other immediate win exists. For this position, the scratch check found only `114` as X's immediate winning move.

**UI.** Show “Win in 1” and the remaining budget beside the usual cube. Keep the prefix marks solid. Distinguish moves made during the attempt with a border, not a new color meaning. The result share contains date, puzzle ID, success, attempts and hint use, with no cells. The same result can be copied manually; sharing is not an automatic message. Spectators watch the attempt. A replay link is clearly marked as a solution and can spoil the puzzle.

**Data and API.** Keep the underlying moves classic. Add optional `challengeRef` and separate attempt metadata: catalog hash, attempt ID, prefix length, submitted actions, outcome and hint/restart flags. Do not put puzzle failure into `Game.status` or upload it as a classic win. **No new `CURRENT_FORMAT` is needed** for this separate metadata. Change `src/session/core.ts`, `src/session/format.ts`, `src/protocol.ts`, W, `src/page/game-view.ts`, `src/page/results.ts`, `server/api-docs.ts` and `server/main.ts`. Add documented puzzle-fetch and attempt-submit routes. The server grades by catalog ID and replay, never a client-supplied success flag. If grading becomes part of the standard game status, that later design would need format 2. Cost: **M**.

**AI and balance.** Build an exhaustive bounded AND/OR search or a proof-number tool for catalog production. At a challenger node, one continuation suffices; at an opponent node, cover every legal reply. Verify certificates independently with classic transitions in the shared core. Hard AI may suggest positions and move ordering. Its pruning and heuristic result cannot certify a forced win or unique answer. The existing first-player solution does not strongly solve every arbitrary position. [B2]

**Precedents and novelty.** The Qubic app advertises handcrafted and daily puzzles, with favorable player reactions to strategy and tutorials. Lichess publishes generated tactics; Connections documents a daily puzzle and copied result sharing. These support the practice loop, not a claim that this new catalog will be fun. Daily Qubic is already public. [D1] [D2] [D11]

### 6. Pie Opening

**Rules.** A starts as X and places one mark. Before the second placement, B chooses either keep O or take X. Taking X swaps the controllers; it does not move the first mark, consume a spatial turn or give X another placement. The next placement is O, now controlled by A. Keeping O may be submitted atomically with B's O placement. No later pie choice is legal.

Freeze the opening controller references and record the choice. A cannot refuse B's swap. Afterward use classic wins and a full-board draw. For this launch rule, the choice is untimed, consistent with the current untimed opening. The ordinary clock starts only after both colors have placed once. A stalled opening therefore has no timeout. A separate decision deadline would be another rule version, not an undocumented timer.

**Example.** A places `X222`. B chooses swap. B now owns the existing X at `222`. A places `O111`. B replies `X223`; A replies `O112`. Move parity still tells the symbol, but no longer tells which original person played it.

**UI.** After X's opening, replace the usual turn prompt with “Keep O” and “Take X.” Show both outcomes before confirmation. The tower and flat board stay put. Update names beside the marks and clock seats only after the authoritative choice. Keypad and voice placement are disabled during the choice. A blind announcement says who now controls X and whose placement is next.

**Data and API.** Add a pie phase, initial public controllers and an opening-choice event. **Use format 2** for controller history and the non-placement event. Change G, U, R and `src/clock.ts`. Document `{kind: pie-choice, choice: keep|swap}`, its chooser and the fact that it does not advance a ply. Use action count for stale guards; placement count for the opening clock rule. Search can use a classic board after the choice, but the worker's opening decision needs a side-value request. Practice undo of the opener is a composite rollback of that placement and its associated choice, allowed only before O places and with consent. It restores initial controllers. There is no independent choice undo after O's placement. Undoing a later placement preserves the choice. Competitive pie games forbid undo. Links and spectators replay controller changes rather than applying a final `flipped` flag to all moves. Cost: **M**.

**AI and balance.** Use opening evaluations to help decide keep or swap. A bounded AI should report an estimate, not a guarantee. A strong first move becomes available to the chooser, which changes the opener's incentive. This alone does **not** prove a draw on Qubic: a balanced opening state must exist and be reachable under the protocol. If all opening states are decisive, the chooser could always select a winning side. The exact cube result is **unverified**.

**Precedents and novelty.** Hex documents a first-move swap. Renju's official Gomoku Swap2 rule lets the opener offer three stones, with the other person choosing a color or offering two more. Renju also restricts some black formations. These are distinct balancing approaches. Start with the simple pie choice; do not label it Swap2. No exact Qubic pie implementation was confirmed. [C6] [C5] [C4]

### 7. Echo Move

**Rules.** Each seat has one echo charge. Every turn places one ordinary mark. With the charge, a player may also name a distinct second cell that is empty before the action. That target becomes a public pending mark, not a reservation. If scheduled by action `i`, it tries to land after action `i + 2`: two further accepted plies. It lands only if the cell is still empty. Otherwise it fizzles and the charge remains spent. An opponent may deliberately occupy it.

Process an action in this order: validate inputs; place its ordinary mark; schedule any new echo; resolve echoes due now in creation order; check the whole board. If both colors now have lines, draw. If only one does, that color wins even when its echo landed during the other player's turn. A full board without a line draws; pending targets are then occupied and cannot change it. No pass is legal. No landing runs after a timeout or finished result.

**Example.** On action 1, X places `111` and spends its echo on `114`, due after action 3. On action 2, O places `114`. On action 3, X places `112`. The queued X at `114` fizzles because O occupies it. If O had played `211`, action 3 would leave X at `111,112,114` after the echo landed.

**UI.** Show pending targets as outlined symbols with “2” then “1.” Keep them visually separate from real marks and never count them in a displayed line score. A selection preview shows both the immediate cell and target. The tower uses a thin target ring; flat sheets can show a dotted symbol. Blind play announces scheduling, due action, landing or fizzle. Voice selects the second target only after the echo control is enabled.

**Data and API.** Store `rules.id = echo-move`, version 1, delay 2 and one charge per seat. A placement action has optional `echoCell`. Derive the public queue `{owner, cell, dueAction}` and charges. **Use format 2:** one action can add two marks and mark ownership no longer follows the count of occupied cells. Change G, W, U, R, `src/clock.ts` and `src/sound.ts`. OpenAPI distinguishes pending targets from occupied cells and lists due effects. Undo removes the complete placement/scheduling/landing action, then reconstructs older pending echoes. A game link or spectator replays the same atomic ordering. Cost: **M**.

**AI and balance.** Search ordinary moves plus charged cell/target pairs. Send the queue and charges to the worker. Evaluate both the next landing and the opponent's chance to occupy its target. Heuristic target ordering can control cost, but it cannot support proof claims. Symmetric charges do not establish fairness: X can exploit an earlier landing. Balance is **unverified**.

**Precedents and novelty.** Into the Breach advertises visible future attacks and tactical counterplay. Its Steam page has positive player reception, but that does not isolate this mechanic's effect. This proposal makes delay valuable by attaching a scarce bonus mark. A pure delayed single placement with a reserved target often just postpones the same decision; that is rejected below. An exact cube echo precedent was not confirmed. [A12]

### 8. Replay Clinic

**Rules.** Open a finished classic game. Reconstruct every prefix and analyze each side's legal alternatives. Show exact immediate wins first. Separate “proved win within N,” “proved loss within N,” “exact draw” and “search estimate.” A failed bounded search means unknown, not draw. Show “first proved losing change” only when the earlier state is proved non-losing and the chosen continuation is proved losing under the same rules. Otherwise say “missed immediate defense” or show an estimate.

The reviewed game's win, draw or timeout never changes. A timeout review ends at the last accepted placement and identifies the clock result. Alternative moves create a separate practice continuation, not edits to the source game. Viewing and analysis have no turn deadline. Retrying a study branch does not affect the original result or stats.

**Example.** Replay `X111, O211, X112, O212, X113, O321, X114`. At O's sixth ply, `114` is X's only immediate completion. The panel shows that `O321` permits `X114`. It may call this a missed immediate block. It may not claim O could force a draw with `O114`, or that this was O's earliest loss, without an additional proof.

**UI.** Add previous/next move controls and “Show threat” beside the existing board. Draw one selected line rather than every potential line. In flat view, highlight all four cells even across sheets; in the tower, connect them briefly and keep coordinate labels. A blind review can read the move, tactic and alternative coordinates. Keep explanations short: “X wins next at 114” is more useful than an unexplained evaluation number.

**Data and API.** Source records remain classic. An optional analysis cache contains the game hash, rule hash, analyzer version, budget, per-prefix proof/estimate type and variation. It is replaceable derived data. **No new `CURRENT_FORMAT` is needed.** Change W, `src/session/core.ts` for proof replay verification, `src/protocol.ts`, `src/page/game-view.ts`, `src/session-link.ts`, `server/api-docs.ts` and `server/main.ts`. `src/session/format.ts` needs a default only if the cache reference is embedded in a session. Document an analysis route separate from mutation routes. Server-verified analysis must validate a certificate rather than trust a client's label. Undo is disabled for the read-only source; a practice branch uses ordinary consent rules. Spectators can share an analysis step through a link without altering the game. Cost: **M**.

**AI and balance.** Reuse the existing worker to find candidates. Add an exhaustive tactical verifier for exact labels, with budgets and cancellation. The classic solved opening does not tell where every human game was lost. This mode teaches the first-player problem; it does not remove it.

**Precedents and novelty.** The Qubic app advertises live analysis and a dictionary. Frozen Synapse Prime's developer describes saved replays, camera control and replay codes for learning. Analysis on a cube is already public. Player reviews of the Qubic app ask for competition and praise learning its spatial rules; those are useful signals, not a playtest of this design. [D1] [C17]

### 9. Full Cube Score

**Rules.** Alternate ordinary placements on empty cells until all 64 cells are occupied. A line never stops play. At the end, count how many of the fixed 76 lines are entirely X and how many are entirely O. Each line counts once, including overlapping lines. The larger count wins. Equal counts draw. Do not count every turn that an already-complete line remains visible.

There is no early score victory in the launch rule. A timeout awards the game to the other seat regardless of current score. Scores are public. A normal untimed practice undo removes the last placement and recomputes both totals. Both colors place 32 marks in a completed game, but equal mark counts do not prove equal score opportunities.

**Example.** `X111, O211, X112, O212, X113, O213, X114, O214`. After ply 7, X has one completed line but play continues. After ply 8, O also has one. This is a live 1–1 position, not the X win that classic replay would return.

**UI.** Show “Lines X 1 — O 1” and “56 cells left.” Newly completed lines flash once. Let a user select a counted line to inspect it; do not leave dozens of strokes across the tower. The flat layouts keep a small line list beneath the sheets. Blind play announces a new line's coordinates and the score. The ordinary per-cell sound remains useful.

**Data and API.** Store `rules.id = full-cube-score`, version 1. Derive score and completed line IDs from the board. **Use format 2:** classic `toGame` stops at the first win and would reject later placements. Change G, W, U and R. `server/api-docs.ts` explains the 64-placement end condition, score result, tie and timeout precedence. Result uploads must validate the complete scoring replay. Add a score-win status `{kind: won, reason: score, winner, scores}` without a mandatory single `line`; a tie is `{kind: draw, reason: score-tie, scores}`. Timeout keeps its own result kind. Game links and spectators show the running counts and final line sets. Cost: **M**.

**AI and balance.** Replace “a line is terminal” in evaluation and search. Score existing lines, viable future lines and moves that complete several lines together. Reuse cell generation and worker scheduling. Exact late-game minimax can help explain small endgames. The result from an empty cube is **unverified**. There is no basis here to promise restored balance.

**Precedents and novelty.** Four Tac Toe's creator rules use full-board line scoring on a 3^4 board with the center forbidden. That is a primary higher-dimensional scoring precedent. [B9] A secondary Score Four reference describes family variants using all beads and comparing completed lines. It is not a verified original Qubic scoring rulebook. Calling this a canonical “Qubic scoring” edition is **unverified**. The proposed rule is explicit regardless of that label. [C21]

### 10. Gravity Cube

**Rules.** A move selects a row and column. Place the mark at the lowest empty layer of that vertical shaft. A full shaft is illegal. Marks are never removed or floated. Keep the same 76 lines and classic four-in-a-row wins. A full cube without a win draws. There is no extra step after a drop.

**Example.** `X drop(1,1) -> 111`; `O drop(1,1) -> 211`; `X drop(1,2) -> 112`; `O drop(1,3) -> 113`; `X drop(1,2) -> 212`; `O drop(4,4) -> 144`; `X drop(1,1) -> 311`. Every non-bottom mark has an occupied cell directly below it.

**UI.** Put sixteen shaft targets on the base of the tower. Preview the landing mark before a tap. In flat view, every cell in a shaft can select that shaft, with only the landing cell highlighted. Keypad entry can accept a resolved legal coordinate; the layer is checked, not trusted. Voice can use the existing coordinate mapping, but an unsupported upper cell is rejected with the actual landing coordinate. Announce the landing and shaft fill count for blind play.

**Data and API.** Store `rules.id = gravity-cube`, version 1 and the fixed direction toward layer 1. Persist `{kind: drop, row, column}`; derive the landing cell. **Use format 2** for the versioned legality and action shape, although the resulting cell sequence is also a valid classic sequence. Change G, W, U and R. OpenAPI exposes rows and columns 0–3, shaft heights, legal drops and resolved cells. The server computes support from replay. An undo removes the whole last drop and restores the shaft. Use ordinary clocks and timeout settlement. Game links and spectators replay drops and their landing cells. Cost: **M**.

**AI and balance.** There are at most sixteen legal moves per turn. Search only supported landings at every depth. Preserve line evaluation, but remove threat shortcuts that assume any empty cell is immediately playable. Existing hard search may benefit from the smaller branching factor; strength must be measured. The opening result for this exact profile is **unverified**.

**Precedents and novelty.** The SOGO patent describes a 4×4 base, four-high stacks and four-in-a-row in space. An opened SOGO repository implements the same cube family. Gravity on a 3D cube is established, so this is a usability and variety choice, not a novelty claim. [B16] [B17]

## Time dimension

### Ten mechanics compared

Time can mean a playable coordinate, a delayed consequence, a scarce change to history or a repeated attempt. Those are different games. The table compares them on one cube before adding more boards.

| Mechanic | Published precedent | Proposed cube decision | State and display | Main risk | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Age and decay | FIFO disappearing tic-tac-toe. [A6] [C19] | Keep four marks; renew a cell or move the threat before an old support expires. | Ordered queues; age labels on one cube. | Cycles require a draw rule; fading is not proved to balance play. | **First time prototype: Fading Four.** |
| Future landing | Telegraphed attacks in Into the Breach. [A12] | Spend an echo charge now; the opponent can occupy its target before it lands. | Public due-action queue; outlined targets. | A delay without a benefit is just slower placement. | Prototype Echo Move after the action envelope. |
| Local past restoration | Braid rewind; Achron's bounded mutable past. [A7] [A11] | Spend one turn and charge to restore one cell from four plies ago. | Recent snapshots; one target preview. | The same present board can have different legal futures. | Best bounded experiment for directly playing with the past. |
| Space-time lines | Hypercube line geometry. [B3] | Treat four chronological snapshots as a 4×4×4×4 window. | Four linked cubes or a selected time slice. | Pure time lines reward one unchanged mark; see the failure below. | Defer until the win condition is redesigned. |
| History fork for study | Shared replay and analysis in Frozen Synapse Prime; branching inspiration from 5D Chess. [C17] [A1] | Copy a legal prefix into a new practice game and compare it with the original. | Immutable parent link and prefix count. | A replay fork is useful but does not itself create temporal tactics. | Useful companion to Replay Clinic. |
| Live branching timelines | 5D Chess moves into past boards and parallel timelines. [A1] [A2] | Play on a bounded tree of cube histories; changing a past node creates a child branch. | Timeline ID, time boundary and three cell coordinates. | Active-branch scheduling and wins must be defined; many boards overload phones. | Research prototype only. |
| Superposition and collapse | Goff's quantum tic-tac-toe. [A4] | Choose two potential cells; cycles let the opponent choose a deterministic collapse. | A public graph on 64 cells with numbered edge marks. | Spooky marks are dense; collapse can create several lines at once. | Small teaching puzzles before full cube PvP. |
| Routing into a time slice | Ultimate's send rule. [A5] | Four independent cubes represent epochs; the chosen column sends the next move to an epoch. | Four boards, a forced slice and ordinary marks. | The fiction of time adds no causality unless history can affect a slice. | Prefer Relay Layers first. |
| Recorded action loops | Chronotron clones and Clockwinder automata. [A8] [A9] | A short recorded sequence repeats while the player supplies missing defensive or scoring moves. | Seeded schedule, loop counter and ghost events. | Repeated occupied targets and paradoxes need an explicit fizzle policy. | Puzzle mode, not an initial competitive rule. |
| Knowledge across resets | Outer Wilds' time loop and changing environment. [A10] | Reset the board but keep discovered puzzle facts and a campaign map. | Attempts stay separate; learned facts persist. | Extra knowledge changes a first attempt's difficulty; separate practice records. | Good campaign structure after Daily Tactics. |

The launch recommendation is **Fading Four**. Every turn changes a visible deadline, it uses one small board, and it works without a real-time scheduler or hidden state. Rewind One is the next experiment if the aim is specifically to alter the past. Do not market either as balanced before analysis.

### What to borrow from 5D Chess

The official description confirms moves into the past, branching timelines and parallel dimensions. The community guide explains temporal movement. A player thread asks how the present works with several active timelines; that is direct evidence of a readability problem for at least one player, not a measured usability result. The Steam page also reports positive player reception. There is demand for the concept, but neither signal proves it fits tick3d. [A1] [A2] [A3]

A tick3d mapping would replace each chess board with a cube snapshot. A coordinate becomes `(branch, boundary, layer, row, column)`. Branches form rows in a history strip; time boundaries form columns. Select one node to show its four layers in the existing tower or flat layout. A cell-only keypad needs a prior branch/time selection and a spoken label. Display at most two branch heads beside the selected cube on a phone.

Keep accepted nodes immutable. A past-directed action creates a new child node rather than rewriting the source link. Existing undo only shortens the current history; it does not retain alternative heads. Branch Lab can first reuse replay and a parent reference to establish this UI without changing competitive rules.

For a later live Multiverse Match, freeze these choices before implementation:

- A public branch cap and a per-seat fork charge.
- Which past boundaries are legal destinations, and whether marks move or are copied.
- Whether one global turn advances one head or every active head.
- Whether a line wins one branch, the entire match or a score point.
- What makes a branch inactive, and how clocks charge multi-head actions.

The ranked candidate uses charged forks and branch scores. Its complete scheduling and match-end rule are **unverified design work**, so it is not implementation-ready. Porting 5D Chess's apparent board layout while omitting its scheduling rules would leave ambiguous turns. Achron suggests another warning: mutable history needs a defined cutoff and propagation order, not a page timer that races the server. [A11]

### Quantum is a graph, not a clock

Goff's game places two numbered spooky marks for a move. Marks link cells into an entanglement graph. A cycle triggers collapse; the player who did not create it chooses the collapse, then still makes their normal move. The choice and propagation are rule decisions, not random physical measurement. [A4]

On the cube, use the 64 cells as graph vertices and spooky pairs as edges. Public edge IDs and creation order must be stored. A collapse action chooses one endpoint of the triggering pair; the shared core propagates the remaining component deterministically. After collapse, check the 76 ordinary lines. Define dual-line results explicitly; a cube adaptation need not inherit the paper's smaller-board scoring convention. Search must consider pair choices and opponent collapse choices. The current one-cell worker is insufficient.

A repository named `qubic` can mislead this search: its author says the planned 3D quantum version did not happen. It is a 2D implementation, so it is not evidence of a public quantum cube. Exact cube novelty remains **unverified**. [A13]

### Why the obvious fourth time axis fails

Take the four boards after plies 1, 2, 3 and 4. X's opening at `111` remains in all four. The line `(time 1,111) -> (time 2,111) -> (time 3,111) -> (time 4,111)` is already four X marks. In a monotone placement game, allowing that pure time line awards X a win after only its second placement. This is a direct consequence of the proposed rule, not a published balance result.

Three possible repairs need separate evaluation:

1. Exclude pure time-axis lines. Require at least one changing spatial coordinate. Then a winning line uses four distinct spatial cells across the window.
2. Use a fading or removable board, then award held-cell points only at a fixed match end. The opponent needs a way to disturb a held cell.
3. Treat four cubes as independent future boards. Marks belong to a selected time cube; persistence is not automatic. This is closer to a tesseract than a snapshot history.

An absolute snapshot boundary and a storage slot are different things. `ply % 4` can select a ring-buffer slot, but old snapshots must be ordered oldest to newest when checking a chronological line. Wrapping time diagonals is another rule and needs another line manifest. A backward-facing ghost is a preview, not an extra playable mark.

### Geometry and scale checks

For a side-`n`, dimension-`d` board with **n in a row**, all axis-aligned and diagonal straight lines number:

$$
L(n,d)=\frac{(n+2)^d-n^d}{2}.
$$

This is the hypercube formula proved by Golomb and Hales. It does not count arbitrary curves, wrap-around paths or shorter segments. [B3]

For **k in a row** on the same bounded grid, the scratch enumeration was cross-checked against:

$$
L_k(n,d)=\sum_{j=1}^{d}\binom{d}{j}2^{j-1}n^{d-j}(n-k+1)^j,
\qquad 2\leq k\leq n.
$$

Each term chooses the changing coordinates, direction signs, stationary coordinates and allowed starts. This is the report's calculation. A short scratch Python script enumerated directions in `{-1,0,1}^d`, retained one of each opposite pair, enumerated valid starts and deduplicated cell sets. It was not added to the repository. Holes excluded any line containing a missing cell. Wrapped coordinates used modulo 4 and a separate set deduplication.

| Proposed board and exact line convention | Cells | Winning lines | Calculation |
| --- | --- | --- | --- |
| Classic 4×4×4, four in a row | 64 | 76 | `(6^3 - 4^3) / 2`; 48 axis, 24 plane-diagonal, 4 space-diagonal. |
| 4×4×4×4, four in a row | 256 | 520 | `(6^4 - 4^4) / 2`; 256 axis, 192 two-axis, 64 three-axis, 8 four-axis. |
| 5×5×5, four consecutive in a row | 125 | 302 | `150 + 120 + 32` segments. The full-length formula would be wrong here. |
| 5×5×5, five in a row | 125 | 109 | `(7^3 - 5^3) / 2`. |
| 3×3×3, three in a row | 27 | 49 | `(5^3 - 3^3) / 2`. |
| 3×3×3 with center forbidden, three in a row | 26 | 36 | Remove the 13 lines through the center. No winning line may jump over the hole. |
| 4×4×4 torus, directions in `{-1,0,1}^3`, four distinct cells, duplicate sets counted once | 64 | 208 | 48 axis, 96 plane-diagonal, 64 space-diagonal. Each cell lies on 13 lines. |

The torus convention excludes other modular slopes such as `(1,2,0)`. Adding them would produce a different game. Rotation of a drawn cube alone changes no geometry. Projecting the same cells and lines onto a sphere also changes no rules; a genuine spherical variant needs an explicit graph and route list. W-axis publicly offers cube wrapping and configurable dimensions. The Surfaces project discusses discrete spheres and tori. Neither is evidence that this report's spherical graph is balanced. [B13] [B15]

State sizes below are raw upper bounds on cell assignments, not reachable positions or game trees:

| Representation | Count | Meaning |
| --- | --- | --- |
| Classic 64-cell ternary board | `3^64 = 3,433,683,820,292,512,484,657,849,089,281` | About `3.433684 × 10^30`; ignores turn counts and early termination. |
| Static 256-cell tesseract | `3^256 ≈ 1.390085 × 10^122` | Does not include actor, clock or history. |
| 125-cell cube | `3^125 ≈ 4.366735 × 10^59` | A larger board is a substantial search change. |
| 26 playable cells | `3^26 = 2,541,865,828,329` | Removing the center does not itself prove a draw. |
| Fading board, queues and side to move | `2 * sum(P(64,a+b), a,b=0..4) = 369,781,057,022,082` | Ordered, disjoint queues of length at most four. Excludes the repetition ledger and ply-cap counter; many configurations are unreachable. |

Four snapshots from one actual history are correlated. Do not describe them as `3^256` independent choices. Likewise, fading queue order matters even when two displayed boards look identical.

### What the theory actually establishes

Hales–Jewett says that for each fixed side length and number of colors, sufficiently many dimensions force a monochromatic combinatorial line. It does not identify 4×4×4×4 as fair. The original paper's accessible catalog record and a later primary proof are listed separately. The latter states the theorem explicitly. [B6] [B5]

For monotone normal play, strategy stealing rules out a second-player forced win. It does not rule out a first-player win. A pairing defense dedicates two cells to each winning line; reply in the paired cell. The cell-count inequality is necessary for that particular defense, not a sufficient balance test. These arguments do not transfer unchanged to expiry, removal or forced destinations. [B3]

| Side n, dimension d; full-length lines | Verified result relevant here |
| --- | --- |
| n=3, d=2 | Ordinary tic-tac-toe is a draw under perfect play. [B2] |
| n=4, d=2 | Set Matching directly proves the empty 4×4 board draws. [B4] |
| n=4, d=3 | Qubic is a first-player win. A draw coloring can exist without a drawing strategy. [B1] [B2] |
| n=5, d=2; n=8, d=3 | Published pairing constructions give drawing defenses for full-length lines. These are not results for 4-in-a-row on a larger board. [B3] |
| n=4, d=4 | A full-board draw coloring is exhibited. This report does not verify a perfect-play drawing strategy or a solved outcome. [B3] |
| n=3, d=3 with forbidden center | The 36-line geometry is computed above. The altered game's outcome is **unverified**. |

The 4D visualization precedents point toward slices. Miegakure and 4D Toys describe a spatial fourth coordinate; they are not time-travel games. Four Tac Toe uses flattened views for a 3^4 board. The Newgrounds author explicitly offers 4×4×4×4; player comments praise the challenge but ask for clearer rules and presentation. Keep one selected cube, a small slice map and a four-coordinate line preview. Showing 256 equal-sized targets at once is a poor phone default; this is a design judgment to test. [B7] [B8] [B9] [B12]

## Rejected ideas and why

These are rejections for the next release or for a claimed benefit. Some remain useful lower-ranked experiments.

| Idea or claim | Reason |
| --- | --- |
| Three active marks each on the current cube | Four-in-a-row is impossible with only three active marks. Change the win length or retain at least four. This follows from the rule. |
| Automatic victory for holding one cell through four snapshots | Persistent opening marks make the pure time axis trivial. Exclude it or add real disruption and scoring. |
| Single delayed placement with a reserved empty target | In the simple version, the opponent cannot affect the target. The delay adds waiting with little extra choice. Echo Move adds a benefit and a visible counter. This is an unverified design judgment. |
| Unlimited rewind or branching | It needs a repetition rule, branch cap, history ownership, clock policy and bounded UI. Existing undo is not a live multiverse engine. |
| Literal nested Ultimate 3D as the first extension | A public implementation already exists. A 3^3 macro-grid of 3^3 cubes has 729 cells; that is a large jump from 64. Relay Layers tests the routing choice at lower cost. [A14] [C1] |
| “Add a fourth dimension to fix balance” | More lines and a bigger state space are not a draw proof. A 4D implementation existed in 2009. Novelty and balance claims need narrower wording. [B12] |
| “Fading, twisting or symmetric powers must be fair” | Penguala reports a first-player win in its fading game. Pentago is strongly solved as a first-player win despite rotations. These results do not solve the cube variants, but they refute a general fairness guarantee. [A6] [C13] |
| Renju-style forbidden forks without analysis | Public Renju restrictions are specific formations. A cube has many crossing planes and directions. Define forbidden threats exactly and solve or sample openings before claiming an improvement. [C4] |
| “Connect6 proves the 1–2–2 cube rule is balanced” | The original Connect6 abstract calls the game potentially fair. Its search paper explains the difficulty of two-piece turns. Neither proves a four-in-a-row cube result. [C7] [C11a] |
| Fog implemented by hiding CSS or the move list | Current session views expose full records. A real fog mode must hold private marks on the authority and redact every player, watcher, replay, sound and result view until reveal. [C17] |
| Hidden simultaneous choices sent through the ordinary move endpoint | The first request could reveal a tactical advantage. Use private server choices and a public resolve event. An honest Nearby host can hold them; secrecy against that host needs commit/reveal or a stronger protocol. [C16] [C18] |
| Random bomb/card effects chosen only on a client | A public seed and versioned deterministic action rule are needed for replay. Start with public drafts. Tic Tac K.O. establishes card powers, not these particular cube powers. [C20] |
| Microphone accuracy or subjective musical beauty as a ranked bonus | The server cannot reproduce a listener's perception or verify that a screen stayed hidden. A score must use submitted coordinates and fixed integer musical rules. Simon is a memory-sequence precedent, not a musical-quality judge. [D9] |
| Perfect-play labels from the existing hard worker | A time-limited search estimate cannot certify all opposing replies. Use proofs or display unknown. |
| Free-for-all as a direct first-player fix | It removes the two-player framing but introduces alliances and kingmaking. A third symbol touches seats, clocks, AI and results. Those are design costs; the cube's outcome is unverified. Otrio and PartyAt show actual multiplayer precedents. [C15] [C19] |
| A sphere skin advertised as a new rule | Changing camera geometry while preserving the same line sets leaves the game unchanged. New routes require a fixed manifest and a flat explanation. [B15] |

Misère, Wild, Order and Chaos and Notakto are worth keeping distinct. Misère punishes your own line. Wild lets either actor use either symbol and rewards the actor completing a line. Order and Chaos assigns different goals. Notakto uses one symbol, so mark color cannot identify the actor. Its published multi-board analysis concerns 3×3 boards; it cannot be copied as a cube solution. [C1] [C2] [C3]

Maker–Breaker and Avoider–Enforcer are also distinct. Maker seeks an X line while Breaker uses O to occupy its possible cells. With Maker first and one cell each, Qubic's winning X strategy still suffices: this is an inference from the classic solution, so that rule does not repair the opening advantage. [B1] Avoider instead loses by forming an X line while Enforcer occupies safe alternatives. Biases such as two blocker marks per turn could be tuned. Their fairness is **unverified** until the exact 76-edge game is analyzed. The paper supplies the positional-game framework. [C10]

For later removal modes, use the published games as rule lessons. Quixo specifies eligible perimeter pieces and push direction; its rulebook also has team play. Gobblet specifies covering sizes and what happens when lifting exposes an enemy line. Otrio supports several players and piece sizes, but its rings are not capture stacks. A cube adaptation must state simultaneous-line priority, exposed-line losses and repetition, rather than leaving animation to decide them. [C11] [C14] [C15]

For the meta-structure, start with certified puzzles, replay steps and paired results. A later league can use Swiss rounds and an Elo-style expected-score update with separate pools per rule and clock. FIDE is a mathematical rating precedent, not a policy to copy into a new game's ladder. Frozen Synapse demonstrates correspondence play; Trackmania demonstrates saved ghosts; Slay the Spire demonstrates a run with changing build choices. A ghost race here should compare the same fixed puzzle playlist, not replay an opponent's old moves after the boards diverge. [D5] [D6] [C17] [D7] [D4]

A cooperative option can let two people alternate one team's X moves against the computer, or give one the sound/coordinate role and the other the placement role. Keep Talking and Nobody Explodes gives a concrete precedent for split information and communication. Reuse tick3d's voice, per-cell sounds and spectator roles, but make the team's controller order explicit in the shared core. This is a later extension of Team Relay; the exact tick3d experience is unverified. [D10] [D8]

## Sources

The following **64 distinct URLs** were opened and their cited content inspected. Primary papers, publisher rules and creator pages are preferred. Community guides, archives and secondary references are labeled. Player reactions are anecdotes or store snapshots, not controlled evidence. Failed opens and search snippets alone are not counted.

The AMS original Hales–Jewett PDF and several BoardGameGeek rule pages could not be fetched. They are not listed as verified content. B6 verifies the original report's identity; B5 supplies an opened primary theorem statement. The requested Wordle-style daily cadence is a design brief; D11 is the verified publisher reference for daily puzzles and copied result sharing.

### A. Time, history and routing

- **A1.** [5D Chess, official Steam page][A1]. Past moves, branching and parallel boards; also a snapshot of player reception.
- **A2.** [5D Chess community movement guide][A2]. A player-authored guide to spatial and temporal piece movement.
- **A3.** [5D Chess discussion about the present][A3]. A player asks how several active timelines work; evidence of a specific readability concern.
- **A4.** [Allan Goff, Quantum tic-tac-toe (2006)][A4]. Primary paper on spooky marks, entanglement cycles and chosen collapse.
- **A5.** [Ultimate tic-tac-toe rules, Minimax.dev][A5]. Solver author's destination rule and the unavailable-board exception.
- **A6.** [Disappearing Tic Tac Toe, creator notes][A6]. FIFO three-piece rule and the developer's reported solved 2D outcome.
- **A7.** [Braid Anniversary Edition, Nintendo publisher listing][A7]. Rewind and world-specific time behavior.
- **A8.** [Chronotron, creator's Kongregate page][A8]. Recorded selves, time-pod loops and paradoxes; visible player comments.
- **A9.** [The Last Clockwinder, Pontoco press kit][A9]. Developer description of looping recorded automata.
- **A10.** [Outer Wilds, Annapurna official page][A10]. A changing world caught in a repeating time loop.
- **A11.** [Achron time-window archive][A11]. Community documentation of time waves and mutable versus immutable history; not a newly verified official manual.
- **A12.** [Into the Breach, official Steam page][A12]. Telegraphed attacks, response tactics and returning help to another timeline.
- **A13.** [cochaviz/qubic, creator repository][A13]. Quantum tic-tac-toe whose README explicitly says the planned 3D version was not completed.
- **A14.** [Ultimate 3D Tic-Tac-Toe, public game][A14]. Rules route moves between cubes and award macro-cube lines.

[A1]: https://store.steampowered.com/app/1349230/5D_Chess_With_Multiverse_Time_Travel/
[A2]: https://steamcommunity.com/sharedfiles/filedetails/?id=2176513845
[A3]: https://steamcommunity.com/app/1349230/discussions/0/4040356791022189800/
[A4]: https://archive.org/download/wikipedia-scholarly-sources-corpus/10.1119.zip/10.1119%252F1.2213635.pdf
[A5]: https://minimax.dev/docs/ultimate/the-game/
[A6]: https://www.penguala.com/disappearing_ttt/about/
[A7]: https://www.nintendo.com/US/store/products/braid-anniversary-edition-switch/
[A8]: https://www.kongregate.com/en/games/scarybug/chronotron
[A9]: https://pontoco.com/the-last-clockwinder-presskit
[A10]: https://annapurnainteractive.com/games/outer-wilds
[A11]: https://archive.chronocloned.net/backup/Time_window.html
[A12]: https://store.steampowered.com/app/590380/Into_the_Breach/
[A13]: https://github.com/cochaviz/qubic
[A14]: https://dhkts1.github.io/ultimate-nd-tictactoe-3d/

### B. Dimensions, theory and geometry

- **B1.** [Oren Patashnik, Qubic: 4×4×4 Tic-Tac-Toe (1980)][B1]. Primary proof of Qubic's first-player win.
- **B2.** [Louis Victor Allis, Searching for Solutions (1994)][B2]. Opened thesis; chapter 4 solves Qubic and chapter 1 distinguishes levels of solving.
- **B3.** [Golomb and Hales, Hypercube Tic-Tac-Toe (2002)][B3]. Primary line formula, draw colorings, pairing constructions and misère discussion.
- **B4.** [Jos Uiterwijk, Set Matching (2017)][B4]. Primary abstract gives a direct drawing proof for empty 4×4 four-in-a-row.
- **B5.** [D. H. J. Polymath, density Hales–Jewett proof][B5]. Primary paper states Hales–Jewett as Theorem 1.3 before its density extension.
- **B6.** [NASA catalog: Regularity and Positional Games][B6]. Verified identity and date of Hales and Jewett's original JPL report; metadata only.
- **B7.** [Miegakure, official site][B7]. Developer explanation of spatial 4D slices and visualization.
- **B8.** [4D Toys, official site][B8]. Developer explanation of changing the fourth spatial coordinate to inspect slices.
- **B9.** [Four Tac Toe, Simple Games][B9]. Creator rules use a flattened 3^4 board, a forbidden center and full-board line scoring.
- **B10.** [4D Tic-Tac-Toe, computercow on itch.io][B10]. Creator's released desktop 4D game; exact board size is not inferred.
- **B11.** [4D TicTacToe, Pygame project][B11]. Creator project and a comment about removing cube centers; no balance proof.
- **B12.** [4D Tic Tac Toe, Newgrounds (2009)][B12]. Author specifies 4×4×4×4; player comments request clearer presentation and rules.
- **B13.** [W-axis, multidimensional tic-tac-toe][B13]. Creator offers 4^3, 4^4, larger boards, player counts and wrapped “slider” rules.
- **B14.** [Non-Euclidean Tic-Tac-Toe, creator repository][B14]. Torus and other surface experiments with automatic win detection.
- **B15.** [Surfaces project: games on discrete surfaces][B15]. Creator discussion of cylindrical, toroidal and spherical board topology; no cube theorem.
- **B16.** [SOGO patent DE102016003894A1][B16]. Primary description of a 4×4 base, four-high stacks and spatial lines of four.
- **B17.** [SOGO_3D-Moba, creator repository][B17]. Public 4×4×4 gravity-game implementation and rules.

[B1]: https://ranger.uta.edu/~weems/NOTES6319/PAPERSONE/patashnik.pdf
[B2]: https://project.dke.maastrichtuniversity.nl/games/files/phd/SearchingForSolutions.pdf
[B3]: https://library.slmath.org/books/Book42/files/golomb.pdf
[B4]: https://arxiv.org/abs/1703.10678
[B5]: https://arxiv.org/pdf/0910.3926
[B6]: https://ntrs.nasa.gov/citations/19620001495
[B7]: https://miegakure.com/
[B8]: https://4dtoys.com/
[B9]: https://simplegames.io/four-tac-toe/
[B10]: https://computercow.itch.io/4d-tic-tac-toe
[B11]: https://www.pygame.org/project-4D%2BTicTacToe-2123-.html
[B12]: https://www.newgrounds.com/portal/view/500930
[B13]: https://w-axis.com/
[B14]: https://github.com/Mvalverde00/Non-Euclidean-Tic-Tac-Toe
[B15]: https://surfaces.sourceforge.net/game.html
[B16]: https://patents.google.com/patent/DE102016003894A1/en
[B17]: https://github.com/moriken2004/SOGO_3D-Moba

### C. Rule modifiers and multiplayer

- **C1.** [TicTacTop rules library][C1]. Creator rules for misère, Wild, Order and Chaos, obstacles and dimensional variants; not treated as a source of solved outcomes.
- **C2.** [Plambeck and Whitehead, The Secrets of Notakto][C2]. Primary analysis of multi-board impartial misère 3×3 tic-tac-toe.
- **C3.** [Berkeley GamesCrafters: Notakto][C3]. Academic project states neutral marks, dead boards and the last-board loss.
- **C4.** [Renju International Federation rules][C4]. Official black forbidden formations and opening rules.
- **C5.** [RenjuNet: Gomoku Swap2][C5]. Official three-stone offer, color choice and optional two-stone extension.
- **C6.** [HexWiki: swap rule][C6]. Community rules for exchanging sides after the first placement.
- **C7.** [Connect6, authors' university publication record][C7]. Original paper abstract calls the game potentially fair.
- **C8.** [Connect6 rules, Plyyard][C8]. Creator's implementation states the one-stone opening and later two-stone turns.
- **C9.** [Develin and Payne, Discrete Bidding Games][C9]. Primary framework for integer-chip bidding, including tic-tac-toe.
- **C10.** [Avoider–Enforcer games, primary paper][C10]. Positional-game rules and biased play; distinguishes the asymmetric goals.
- **C11.** [Quixo, Gigamic rulebook][C11]. Official perimeter selection, push moves, line priority and team rules.
- **C11a.** [Dependency-based search for Connect6][C11a]. Authors' abstract explains the search difficulty created by two-piece turns.
- **C12.** [Pentago, Tactic rulebook][C12]. Official placement and quarter-turn rules, including its win timing.
- **C13.** [Geoffrey Irving, Pentago is a first player win][C13]. Primary strong-solution paper; rotation is not a general balance guarantee.
- **C14.** [Gobblet, Blue Orange rulebook][C14]. Official size covering, moving, exposed enemy lines and repetition draw.
- **C15.** [Otrio, official rules page][C15]. Piece sizes and two-, three- and four-player arrangements; rings are not Gobblet stacks.
- **C16.** [Frozen Synapse Prime combat, developer post][C16]. Both sides plan, commit and resolve simultaneously.
- **C17.** [Frozen Synapse Prime multiplayer, developer post][C17]. Correspondence, dark information, leaderboards and saved replay codes.
- **C18.** [Hidden Move tic-tac-toe, publisher Play Store listing][C18]. Simultaneous secret cells, blocked collisions and dual-win draws.
- **C19.** [PartyAt tic-tac-toe, creator page][C19]. Vanish, Ultimate and three-player 5×5 rules.
- **C20.** [Tic Tac K.O., Asmodee Italian rulebook][C20]. Official translated rules for teams, objectives and cards that remove, move or affect characters.
- **C21.** [Score Four, Board Game Rules][C21]. Secondary reference reports scoring and capture variants in this game family; not an original Qubic scoring rulebook.

[C1]: https://tictactop.tech/learn
[C2]: https://arxiv.org/abs/1301.1672
[C3]: https://gamescrafters.berkeley.edu/games/software.php?game=notakto
[C4]: https://gomoku.renju.net/rifrules/
[C5]: https://www.renju.net/rule/11/
[C6]: https://www.hexwiki.net/index.php/Swap_rule
[C7]: https://scholar.nycu.edu.tw/en/publications/connect6/
[C8]: https://connect6.plyyard.com/rules/
[C9]: https://arxiv.org/abs/0801.0579
[C10]: https://www.cs.tau.ac.il/~krivelev/Avoi-new.pdf
[C11]: https://export.gigamic.com/wp-content/uploads/2021/01/INS-RULES_QUIXO_03-2017.pdf
[C11a]: https://scholar.nycu.edu.tw/en/publications/dependency-based-search-for-connect6/
[C12]: https://www.tactic.net/site/rules/UK/12609.pdf
[C13]: https://arxiv.org/abs/1404.0743
[C14]: https://blueorangegames.eu/wp-content/uploads/2023/04/Gobblet-Rules-EN.pdf
[C15]: https://otrio.com/pages/how-to-play
[C16]: https://blog.playstation.com/archive/2014/09/10/new-frozen-synapse-prime-video-explains-combat-mechanics-2/
[C17]: https://blog.playstation.com/2014/09/18/how-multiplayer-works-in-frozen-synapse-prime/
[C18]: https://play.google.com/store/apps/details?hl=en-US&id=com.tictactoe.newmode
[C19]: https://partyat.games/games/tic-tac-toe/
[C20]: https://cdn.svc.asmodee.net/production-asmodeeit/uploads/2024/06/TicTacKO_Adorabili_vs_Malvagi_ITA.pdf.pdf
[C21]: https://board-game-rules.com/boardgames/score-four/

### D. Puzzles, runs, competition, sound and voice

- **D1.** [Qubic — 3D tic tac toe, publisher App Store listing][D1]. Actual 4^3 app with daily puzzles and analysis; player reviews discuss learning and competition.
- **D2.** [Lichess puzzle database][D2]. Official description and data for generated tactics from games.
- **D3.** [Lichess Puzzle Storm][D3]. Official timed sequence, increasing difficulty and combo rules.
- **D4.** [Slay the Spire, Mega Crit press kit][D4]. Developer's deck-building roguelike and run structure.
- **D5.** [FIDE rating regulations, 2024 edition][D5]. Primary expected-score tables and rating calculation precedent; not claimed to be the latest edition.
- **D6.** [Lichess Swiss tournaments][D6]. Official round structure and win/draw point values.
- **D7.** [Trackmania replay documentation][D7]. Official game documentation for loading and watching saved ghosts.
- **D8.** [Blindfold 3D Tic Tac Toe, Perkins][D8]. Developer guest post on an audio 3×3×3 game and labeled spatial concepts.
- **D9.** [Simon, Hasbro instructions page][D9]. Publisher description of repeating light-and-sound sequences.
- **D10.** [Keep Talking and Nobody Explodes, official site][D10]. Split visual/manual roles and communication-based cooperation.
- **D11.** [Connections, New York Times Help Center][D11]. Publisher documents the daily cadence and copying results for sharing.

[D1]: https://apps.apple.com/us/app/qubic-3d-tic-tac-toe/id1480301899
[D2]: https://database.lichess.org/
[D3]: https://lichess.org/page/storm
[D4]: https://www.megacrit.com/press-kits/slay-the-spire/
[D5]: https://handbook.fide.com/chapter/B022024
[D6]: https://lichess.org/swiss
[D7]: https://doc.trackmania.com/play/watch-replays/
[D8]: https://www.perkins.org/resource/blindfold-3d-tic-tac-toe/
[D9]: https://instructions.hasbro.com/en-us/instruction/simon-game
[D10]: https://www.keeptalkinggame.com/
[D11]: https://thenewyorktimeshelpcenter.helpjuice.com/360011158491-New-York-Times-Games/28525912587924-Connections
