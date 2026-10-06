// The SQL of the sound practice room: the leaderboards of GET /api/practice/best and the practice part of
// the stats page. Only player names leave this file, never a token.
import { listValue } from '@duckdb/node-api';
import { PRACTICE_MODES, PRESET_IDS, type PracticeBoard, type PracticeLeader, type PracticeMode, type PracticeStats, type PresetId } from '../src/practice/practice.ts';
import { PERSON, type Rows, num, oneOf, personName } from './stats.ts';

// One row per run, with the person (the GitHub account, else the token) and a sort key: a target run by
// its total time, an echo run by its points (more first), then its time. The best run of a person has the
// smallest key.
const RUNS = `WITH runs AS (
  FROM practice_runs LEFT JOIN player_tokens pt USING (token) LEFT JOIN users u ON u.github_id = pt.github_id
  SELECT mode, preset, ${PERSON} AS person, u.login, total_ms, score, round_ms,
    CASE WHEN mode = 'echo' THEN (1000 - score)::BIGINT * 1000000000 + total_ms ELSE total_ms::BIGINT END AS key
), best AS (
  SELECT mode, preset, person, any_value(login) AS login, min(key) AS key, arg_min(total_ms, key) AS total_ms, arg_min(score, key) AS score
  FROM runs GROUP BY mode, preset, person
)`;

function leader(row: Record<string, unknown>): PracticeLeader {
  return {
    mode: oneOf(PRACTICE_MODES, row.mode),
    preset: oneOf(PRESET_IDS, row.preset),
    rank: num(row.rank),
    player: personName(row),
    totalMs: num(row.total_ms),
    score: num(row.score),
  };
}

// The best `limit` people of each mode and preset.
// `only` limits the list to one mode and preset.
async function leaders(rows: Rows, limit: number, only?: { mode: PracticeMode; preset: PresetId }): Promise<PracticeLeader[]> {
  const found = await rows(
    `${RUNS} SELECT mode, preset, row_number() OVER (PARTITION BY mode, preset ORDER BY key, login NULLS LAST, person)::INTEGER AS rank,
       login, person, total_ms, score
     FROM best ${only === undefined ? '' : 'WHERE mode = $mode AND preset = $preset'}
     QUALIFY rank <= $limit ORDER BY mode, preset, rank`,
    only === undefined ? { limit } : { limit, ...only },
  );
  return found.map(leader);
}

// `tokens` are the tokens of the caller (its device and its linked devices), for its own best.
export async function practiceBoard(rows: Rows, mode: PracticeMode, preset: PresetId, tokens: readonly string[]): Promise<PracticeBoard> {
  const top = await leaders(rows, 10, { mode, preset });
  if (tokens.length === 0) return { mode, preset, top, you: null };
  const [own] = await rows(
    `FROM practice_runs SELECT total_ms, score
     WHERE mode = $mode AND preset = $preset AND list_contains($tokens, token)
     ORDER BY CASE WHEN mode = 'echo' THEN -score ELSE 0 END, total_ms LIMIT 1`,
    { mode, preset, tokens: listValue([...tokens]) },
  );
  return { mode, preset, top, you: own === undefined ? null : { totalMs: num(own.total_ms), score: num(own.score) } };
}

export async function practiceStats(rows: Rows): Promise<PracticeStats> {
  const runs = await rows(
    `${RUNS} SELECT mode, preset, count(*)::INTEGER AS runs, count(DISTINCT person)::INTEGER AS players,
       (SELECT avg(t) FROM (SELECT unnest(r.round_ms) AS t FROM runs r WHERE r.mode = runs.mode AND r.preset = runs.preset)) AS avg_round_ms
     FROM runs GROUP BY mode, preset ORDER BY mode, preset`,
    {},
  );
  return {
    runs: runs.map((row) => ({
      mode: oneOf(PRACTICE_MODES, row.mode),
      preset: oneOf(PRESET_IDS, row.preset),
      runs: num(row.runs),
      players: num(row.players),
      avgRoundMs: row.avg_round_ms === null ? null : num(row.avg_round_ms),
    })),
    best: await leaders(rows, 5),
  };
}
