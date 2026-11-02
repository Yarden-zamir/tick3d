// The stored rule cases must match what the TypeScript rules give now. After a rule change, write them again:
// UPDATE_RULE_CASES=1 npx vitest run src/session/rule-cases.test.ts
// Then the second copy of the rules (#265) must pass the new cases too.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type RuleCases, allCases } from './rule-cases.ts';

const FILE = new URL('./rule-cases.json', import.meta.url);

describe('the rule cases', () => {
  const cases = allCases();

  it('are the results of the TypeScript rules now', () => {
    if (process.env.UPDATE_RULE_CASES === '1') writeFileSync(FILE, `${JSON.stringify(cases)}\n`);
    expect(existsSync(FILE), 'rule-cases.json is missing: write it with UPDATE_RULE_CASES=1').toBe(true);
    const stored = JSON.parse(readFileSync(FILE, 'utf8')) as RuleCases;
    // A plain JSON round trip, so undefined fields compare as the file stores them.
    expect(stored).toEqual(JSON.parse(JSON.stringify(cases)));
  });

  // Random play that rarely gets past the first errors checks little. Each kind of action must change a game
  // in some case, and fail in some case.
  it('apply and refuse each kind of action', () => {
    const steps = cases.sessions.flatMap((session) => session.steps);
    for (const op of ['join', 'move', 'newGame', 'update', 'lock', 'chat', 'playoff', 'seat', 'answerSeat'] as const) {
      const results = steps.filter((step) => step.op === op).map((step) => step.result);
      expect(results.some((result) => 'doc' in result), `${op} never applies`).toBe(true);
      expect(results.some((result) => 'error' in result), `${op} never fails`).toBe(true);
    }
    for (const op of ['settle', 'abandonLive'] as const) {
      expect(steps.some((step) => step.op === op && 'doc' in step.result), `${op} never changes a game`).toBe(true);
    }
    expect(steps.some((step) => step.op === 'view' && 'view' in step.result && JSON.stringify(step.result.view).includes('"won"'))).toBe(true);
    expect(steps.some((step) => step.op === 'answerSeat' && 'doc' in step.result)).toBe(true);
    expect(steps.some((step) => 'doc' in step.result && step.result.doc.games.some((game) => game.moves.length >= 7))).toBe(true);
  });
});
