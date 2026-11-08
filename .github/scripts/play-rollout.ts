// The staged rollout of a production release on Google Play (.github/workflows/play-rollout.yml), once a day.
// A tag uploads a production release at 5 % (android.yml, with the repository variable PLAY_RELEASE_TRACK=production).
// This script then raises the share by the age of the release, while Android vitals stay healthy:
// day 0: 5 %, day 1: 20 %, day 2: 50 %, day 3: 100 %. A crash or ANR rate over the bad behaviour threshold of Google
// halts the release, and the job fails, so a person looks. It keeps no state: the age comes from the android run whose
// run number is the version code.
// Run: TOKEN=<Play token> PACKAGE=<package> GH_TOKEN=<token> REPOSITORY=<owner/name> [DRY_RUN=1] node .github/scripts/play-rollout.ts

const DAY_MS = 24 * 3_600_000;
// The share of users by full days since the upload.
const STEPS = [0.05, 0.2, 0.5, 1] as const;
// The bad behaviour thresholds of Google Play for user-perceived crashes and ANRs.
export const CRASH_LIMIT = 0.0109;
export const ANR_LIMIT = 0.0047;

export type Release = { name?: string; versionCodes?: string[]; status: string; userFraction?: number; releaseNotes?: unknown };
// ok: the rates are under the limits. none: vitals has no data for the version yet (few users).
// bad: a rate is over its limit. unknown: the Reporting API failed, so nothing changes.
export type Health = { kind: 'ok' | 'none' | 'unknown' } | { kind: 'bad'; reason: string };
export type Decision =
  | { action: 'none'; reason: string }
  | { action: 'raise'; fraction: number }
  | { action: 'complete' }
  | { action: 'halt'; reason: string };

export function targetFraction(ageMs: number): number {
  const days = Math.max(0, Math.floor(ageMs / DAY_MS));
  return STEPS[Math.min(days, STEPS.length - 1)] ?? 1;
}

export function decide(release: Release, ageMs: number, health: Health): Decision {
  if (release.status !== 'inProgress') return { action: 'none', reason: `the release is ${release.status}` };
  if (health.kind === 'bad') return { action: 'halt', reason: health.reason };
  if (health.kind === 'unknown') return { action: 'none', reason: 'Android vitals did not answer' };
  const current = release.userFraction ?? 0;
  const target = targetFraction(ageMs);
  if (target <= current) return { action: 'none', reason: `${percent(current)} until the next step` };
  return target >= 1 ? { action: 'complete' } : { action: 'raise', fraction: target };
}

const percent = (fraction: number) => `${Math.round(fraction * 100)} %`;

// The in-progress release of the production track, with its highest version code, or undefined.
export function stagedRelease(releases: Release[]): { release: Release; versionCode: number } | undefined {
  const release = releases.find((each) => each.status === 'inProgress');
  const codes = (release?.versionCodes ?? []).map(Number).filter(Number.isSafeInteger);
  return release === undefined || codes.length === 0 ? undefined : { release, versionCode: Math.max(...codes) };
}

// The releases of the track after the decision. A completed release replaces the one that was complete before. A
// halted or a draft release stays, for a person to resume or publish.
export function releasesAfter(releases: Release[], decision: Decision): Release[] {
  return releases.flatMap((release): Release[] => {
    if (release.status !== 'inProgress') return decision.action === 'complete' && release.status === 'completed' ? [] : [release];
    if (decision.action === 'raise') return [{ ...release, userFraction: decision.fraction }];
    if (decision.action === 'halt') return [{ ...release, status: 'halted' }];
    if (decision.action === 'complete') {
      const { userFraction: _, ...rest } = release;
      return [{ ...rest, status: 'completed' }];
    }
    return [release];
  });
}

type Row = {
  startTime?: { year: number; month: number; day: number };
  dimensions?: { dimension: string; int64Value?: string; stringValue?: string }[];
  metrics?: { metric: string; decimalValue?: { value: string } }[];
};

const dayOf = (row: Row): number => {
  const start = row.startTime;
  if (start === undefined) throw new Error('a vitals row has no startTime');
  return Date.UTC(start.year, start.month - 1, start.day);
};

// The 7-day user-weighted rate of the newest row of the version (by its start day) that holds the metric, or
// undefined without one. A newer row without the value must not hide an older rate over the limit.
export function latestRate(rows: Row[], versionCode: number, metric: string): number | undefined {
  const valueOf = (row: Row) => row.metrics?.find((m) => m.metric === metric)?.decimalValue?.value;
  const mine = rows.filter(
    (row) => valueOf(row) !== undefined && row.dimensions?.some((d) => d.dimension === 'versionCode' && Number(d.int64Value ?? d.stringValue) === versionCode),
  );
  const newest = mine.reduce<Row | undefined>((best, row) => (best === undefined || dayOf(row) > dayOf(best) ? row : best), undefined);
  const value = newest === undefined ? undefined : valueOf(newest);
  if (value === undefined) return undefined;
  const rate = Number(value);
  if (!Number.isFinite(rate)) throw new Error(`${metric} is not a number: ${value}`);
  return rate;
}

export function healthOf(crash: number | undefined, anr: number | undefined): Health {
  if (crash !== undefined && crash > CRASH_LIMIT) return { kind: 'bad', reason: `user-perceived crash rate ${(crash * 100).toFixed(2)} % is over ${CRASH_LIMIT * 100} %` };
  if (anr !== undefined && anr > ANR_LIMIT) return { kind: 'bad', reason: `user-perceived ANR rate ${(anr * 100).toFixed(2)} % is over ${ANR_LIMIT * 100} %` };
  return crash === undefined && anr === undefined ? { kind: 'none' } : { kind: 'ok' };
}

type DateTime = { year: number; month: number; day: number; timeZone?: { id: string } };

// The date `days` days before `end`, in the time zone of `end` (America/Los_Angeles for DAILY rows).
export function daysBefore(end: DateTime, days: number): DateTime {
  const date = new Date(Date.UTC(end.year, end.month - 1, end.day - days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), ...(end.timeZone ? { timeZone: end.timeZone } : {}) };
}

// ---- The calls ----

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
};

async function request(url: string, init: RequestInit & { token: string }): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { ...init, headers: { authorization: `Bearer ${init.token}`, 'content-type': 'application/json', accept: 'application/json' } });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

async function ok(url: string, init: RequestInit & { token: string }): Promise<unknown> {
  const { status, body } = await request(url, init);
  if (status < 200 || status > 299) throw new Error(`${init.method ?? 'GET'} ${url} answered ${status}: ${JSON.stringify(body)}`);
  return body;
}

async function vitals(token: string, pkg: string, versionCode: number): Promise<Health> {
  const base = `https://playdeveloperreporting.googleapis.com/v1beta1/apps/${pkg}`;
  const rate = async (set: string, metric: string): Promise<number | undefined> => {
    const info = (await ok(`${base}/${set}`, { token })) as { freshnessInfo?: { freshnesses?: { aggregationPeriod: string; latestEndTime: DateTime }[] } };
    const end = info.freshnessInfo?.freshnesses?.find((f) => f.aggregationPeriod === 'DAILY')?.latestEndTime;
    if (end === undefined) return undefined;
    const answer = (await ok(`${base}/${set}:query`, {
      token,
      method: 'POST',
      body: JSON.stringify({
        timelineSpec: { aggregationPeriod: 'DAILY', startTime: daysBefore(end, 7), endTime: end },
        dimensions: ['versionCode'],
        metrics: [metric],
        filter: `versionCode = ${versionCode}`,
      }),
    })) as { rows?: Row[] };
    return latestRate(answer.rows ?? [], versionCode, metric);
  };
  try {
    return healthOf(await rate('crashRateMetricSet', 'userPerceivedCrashRate7dUserWeighted'), await rate('anrRateMetricSet', 'userPerceivedAnrRate7dUserWeighted'));
  } catch (error) {
    console.log(`::warning::Android vitals failed, so the rollout waits: ${String(error)}`);
    return { kind: 'unknown' };
  }
}

// The start of the android run that built the version: its run number is the version code (android.yml).
async function uploadedAt(ghToken: string, repository: string, versionCode: number): Promise<number> {
  for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
    const answer = (await ok(`https://api.github.com/repos/${repository}/actions/workflows/android.yml/runs?per_page=100&page=${pageNumber}`, { token: ghToken })) as {
      workflow_runs: { run_number: number; created_at: string }[];
    };
    const run = answer.workflow_runs.find((each) => each.run_number === versionCode);
    if (run !== undefined) return Date.parse(run.created_at);
    if (answer.workflow_runs.length < 100) break;
  }
  throw new Error(`no android run has the run number ${versionCode}`);
}

// True while an android run is in progress: its upload holds a Play edit, and a new edit would make that edit fail.
async function uploadRuns(ghToken: string, repository: string): Promise<boolean> {
  const answer = (await ok(`https://api.github.com/repos/${repository}/actions/workflows/android.yml/runs?status=in_progress&per_page=1`, { token: ghToken })) as {
    total_count: number;
  };
  return answer.total_count > 0;
}

async function main(): Promise<void> {
  const token = env('TOKEN');
  const pkg = env('PACKAGE');
  const dryRun = process.env.DRY_RUN === '1';
  // The rollout runs once a day and follows the age of the release, so a skipped day only delays a step.
  if (await uploadRuns(env('GH_TOKEN'), env('REPOSITORY'))) {
    console.log('An android run is in progress, so the rollout waits for the next day.');
    return;
  }
  const edits = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}/edits`;
  const edit = (await ok(edits, { token, method: 'POST', body: '{}' })) as { id: string };
  const done = async (commit: boolean) => {
    if (commit) await ok(`${edits}/${edit.id}:commit`, { token, method: 'POST' });
    else await request(`${edits}/${edit.id}`, { token, method: 'DELETE' });
  };
  const track = await request(`${edits}/${edit.id}/tracks/production`, { token });
  // 404: the app has no production track yet. Any other failure must show, not look like an empty track.
  if (track.status !== 200 && track.status !== 404) {
    await done(false);
    throw new Error(`the production track answered ${track.status}: ${JSON.stringify(track.body)}`);
  }
  const releases = track.status === 200 ? ((track.body as { releases?: Release[] }).releases ?? []) : [];
  const staged = stagedRelease(releases);
  if (staged === undefined) {
    console.log('No staged production release.');
    await done(false);
    return;
  }
  const age = Date.now() - (await uploadedAt(env('GH_TOKEN'), env('REPOSITORY'), staged.versionCode));
  const health = await vitals(token, pkg, staged.versionCode);
  const decision = decide(staged.release, age, health);
  const summary = `Version code ${staged.versionCode}, ${(age / DAY_MS).toFixed(1)} days old, at ${percent(staged.release.userFraction ?? 0)}. Vitals: ${health.kind}. Decision: ${JSON.stringify(decision)}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await import('node:fs').then((fs) => fs.appendFileSync(env('GITHUB_STEP_SUMMARY'), `${summary}\n`));
  if (decision.action === 'none' || dryRun) {
    await done(false);
    return;
  }
  await ok(`${edits}/${edit.id}/tracks/production`, { token, method: 'PUT', body: JSON.stringify({ track: 'production', releases: releasesAfter(releases, decision) }) });
  await done(true);
  if (decision.action === 'halt') {
    console.log(`::error::Halted version code ${staged.versionCode}: ${decision.reason}. Resume it in Play Console after a fix.`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
