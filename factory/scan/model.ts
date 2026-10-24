// The factory model: every entity and edge that the 3D world draws. The scanner (scan.ts) writes it,
// the page (src/) reads it. Only types here, so both Node and Vite load this file.

export type ZoneId =
  | 'materials'
  | 'studio'
  | 'storefront'
  | 'assembly'
  | 'foundry'
  | 'api'
  | 'vault'
  | 'acoustics'
  | 'ai'
  | 'nearby'
  | 'device'
  | 'qa'
  | 'ci'
  | 'packaging'
  | 'android'
  | 'ios';

export type EntityKind =
  // Files of the repository.
  | 'module'
  | 'test'
  | 'spec'
  | 'style'
  | 'page'
  | 'config'
  | 'doc'
  | 'asset'
  | 'script'
  // Things inside files, or outside the repository, that the scanner finds.
  | 'route'
  | 'table'
  | 'volume'
  | 'workflow'
  | 'job'
  | 'stage'
  | 'service'
  | 'dep'
  | 'hub';

export interface Entity {
  id: string;
  kind: EntityKind;
  zone: ZoneId;
  label: string;
  /** The repository file that holds this entity (itself, for a file). */
  file?: string;
  lines?: number;
  /** The first comment block of the file, or the comment above a table, job or stage. */
  summary?: string;
  /** The subject file of a unit test, or the tests of a file. */
  testOf?: string;
  tests?: string[];
  /** npm packages that a file imports. */
  packages?: string[];
  /** Kind-specific facts, shown in the inspector as is. */
  data?: Record<string, string | number | boolean | string[]>;
}

export type EdgeKind =
  | 'import' // `from` provides code, `to` imports it: items travel from → to
  | 'needs' // a workflow job waits for another job
  | 'stage' // a Docker stage copies from another stage
  | 'serves' // a stage becomes a compose service, or a service depends on another
  | 'stores' // the store writes a table
  | 'package' // an npm package feeds a file
  | 'entry' // an HTML page loads its script
  | 'calls' // client code calls an API route over HTTP (or listens to its event stream)
  | 'message'; // a page posts messages to a Web Worker

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** A type-only import moves no runtime code. */
  typeOnly?: boolean;
  /** For calls: the HTTP method and the path as the client writes it; stream for an EventSource. */
  via?: string;
  stream?: boolean;
}

export interface FactoryModel {
  meta: {
    repo: string;
    branch: string;
    commit: string;
    subject: string;
    scannedAt: string;
    files: number;
    lines: number;
  };
  entities: Entity[];
  edges: Edge[];
}
