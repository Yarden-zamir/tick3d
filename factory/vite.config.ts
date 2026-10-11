import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const FACTORY = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(FACTORY, '..');
const BINARY = /\.(png|jpe?g|webp|gif|ico|svg|woff2?|ttf|mp4|wav|mp3|pdf|zip)$/i;

// Two dev endpoints. /__factory runs a fresh scan of the repository (so Rescan sees new commits and
// edits), and /__source answers the text of one file that git tracks, for the Inspector's Source view.
function repository(): Plugin {
  return {
    name: 'tick3d-repository',
    configureServer(server) {
      server.middlewares.use('/__factory', (_req, res) => {
        try {
          const json = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', join(FACTORY, 'scan/scan.ts'), '--stdout'], { cwd: FACTORY, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(json);
        } catch (error) {
          res.statusCode = 500;
          res.end(String(error));
        }
      });
      // A dev aid: the page posts a rendered frame here, saved as factory/.snapshots/<name>.png.
      server.middlewares.use('/__snapshot', (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const name = (new URL(req.url ?? '', 'http://local').searchParams.get('name') ?? 'frame').replace(/[^\w-]/g, '');
          const data = Buffer.concat(chunks).toString('utf8').replace(/^data:image\/png;base64,/, '');
          mkdirSync(join(FACTORY, '.snapshots'), { recursive: true });
          writeFileSync(join(FACTORY, '.snapshots', `${name}.png`), Buffer.from(data, 'base64'));
          res.end('ok');
        });
      });
      server.middlewares.use('/__source', (req, res) => {
        const path = new URL(req.url ?? '', 'http://local').searchParams.get('path') ?? '';
        let tracked = '';
        try {
          tracked = execFileSync('git', ['ls-files', '--', path], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {
          // A path outside the repository: git refuses it, and so do we.
        }
        if (!path || tracked !== path || BINARY.test(path)) {
          res.statusCode = 404;
          res.end('not tracked');
          return;
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(join(REPO, path), 'utf8'));
      });
    },
  };
}

export default defineConfig({
  plugins: [repository()],
  server: { port: 5199 },
  build: { target: 'es2023', chunkSizeWarningLimit: 2000 },
});
