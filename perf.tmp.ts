import { DuckDBInstance } from '@duckdb/node-api';
import { computeStats } from './server/stats.ts';
import { ALL_STATS } from './src/protocol.ts';
const instance = await DuckDBInstance.create('/perf/db.duckdb', { memory_limit: '256MB', threads: '2', storage_compatibility_version: 'v1.5.0' });
const db = await instance.connect();
const times: [number, string][] = [];
const rows = async (sql: string, values: Record<string, unknown>) => {
  const t = performance.now();
  const r = (await db.runAndReadAll(sql, values as never)).getRowObjectsJS();
  times.push([performance.now() - t, sql.replace(/\s+/g, ' ').slice(0, 100)]);
  return r;
};
console.log('results', (await db.runAndReadAll('SELECT count(*)::INTEGER AS n FROM results')).getRowObjectsJS(), 'sessions', (await db.runAndReadAll('SELECT count(*)::INTEGER AS n FROM sessions')).getRowObjectsJS());
for (const [name, filter, tokens] of [['everyone', ALL_STATS, null], ['mine', { ...ALL_STATS, scope: 'mine' }, ['seed-ava-7k2m9q4x8w1z']]] as const) {
  times.length = 0;
  const t = performance.now();
  await computeStats(rows as never, Date.now(), filter as never, tokens as never);
  console.log(name, 'total', Math.round(performance.now() - t));
  for (const [ms, sql] of times.sort((a, b) => b[0] - a[0]).slice(0, 5)) console.log('  ', Math.round(ms), sql);
}
