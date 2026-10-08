// A release: the page bundle that one deploy built, with a name that people can read.
// The build writes release.json (vite.config.ts). The API stores it in the `releases` table at start,
// and the stats page shows the name for the version that game metrics carry.
import { type EpochMs, isEpochMs } from './epoch.ts';
import { isRecord } from './guards.ts';
import { isVersion, toVersion } from './protocol.ts';

export type Release = {
  // The page script file name, as Metrics.version carries it, for example "main-B2x9kQ".
  version: string;
  name: string;
  // The commit time of the build.
  at: EpochMs;
};

export const RELEASE_FILE = 'release.json';

// The version of a page script: its file name up to the first dot, for example "main-B2x9kQ" from
// "/assets/main-B2x9kQ.js". In development it is the module name.
export const versionOfScript = (path: string): string => toVersion(path.split('/').at(-1)?.split('.')[0] ?? '');
export const MAX_RELEASE_NAME = 200;

// The commit that a build comes from, as git log gives it.
export type Commit = { parents: number; subject: string; body: string };

// The release name of a commit. A GitHub merge commit has the pull request title as its body:
// "Merge pull request #115 from owner/branch", an empty line, then the title. Any other commit, such as a
// direct push to main, uses its subject. A preview (environment pr-<n>) builds the branch head, which does
// not hold the pull request title, so the name is the head subject with the environment.
export function releaseName(commit: Commit, environment: string | undefined): string {
  const title = commit.body.split('\n').map((line) => line.trim()).find((line) => line !== '');
  const isPullMerge = commit.parents > 1 && commit.subject.startsWith('Merge pull request #') && title !== undefined;
  const name = isPullMerge ? title : commit.subject.trim();
  if (name === '') throw new Error('release name: the commit has no subject');
  const named = environment?.startsWith('pr-') ? `${name} (${environment})` : name;
  return named.slice(0, MAX_RELEASE_NAME);
}

// The name that the stats page shows for a release. A version without a release row shows its hash.
export const releaseLabel = ({ version, name }: { version: string; name: string | null }): string => name ?? `Unknown (${version})`;

// Refuses a missing key, a wrong type or a value out of range. Throws: a bad release file is a build fault.
export function parseRelease(value: unknown): Release {
  if (!isRecord(value)) throw new Error('release: not an object');
  const { version, name, at } = value;
  if (!isVersion(version)) throw new Error('release: bad version');
  if (typeof name !== 'string' || name === '' || name.length > MAX_RELEASE_NAME) throw new Error('release: bad name');
  if (!isEpochMs(at)) throw new Error('release: bad time');
  return { version, name, at };
}
