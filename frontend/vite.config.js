import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// pdf.js fetches these at run time by URL rather than importing them, so Vite cannot see them:
// the pure-JavaScript JBIG2 / JPEG 2000 decoders scanned PDFs need (the WebAssembly builds are not
// allowed by the app's CSP), the metric-compatible fonts for PDFs that do not embed theirs, and the
// character maps for CJK fonts that are not embedded (a Chinese invoice in STSong-Light shows no
// text without them). They are copied from whichever pdfjs-dist is installed, so they never drift
// from it, under a path named for its version: the server caches them as immutable, and without the
// version a browser would keep the old decoders after an upgrade.
function pdfjsRuntimeAssets() {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  const { version } = require('pdfjs-dist/package.json');
  const base = `pdfjs/${version}/`;
  const files = [
    ...readdirSync(join(root, 'wasm')).filter(f => f.endsWith('_nowasm_fallback.js') || f.startsWith('LICENSE')).map(f => ['wasm', f]),
    ...readdirSync(join(root, 'standard_fonts')).map(f => ['standard_fonts', f]),
    ...readdirSync(join(root, 'cmaps')).filter(f => f.endsWith('.bcmap') || f.startsWith('LICENSE')).map(f => ['cmaps', f]),
  ];
  return {
    name: 'pdfjs-runtime-assets',
    configureServer(server) {
      server.middlewares.use(`/${base}`, (req, res, next) => {
        const [dir, name] = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\//, '').split('/');
        if (!files.some(([d, f]) => d === dir && f === name)) return next();
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        res.end(readFileSync(join(root, dir, name)));
      });
    },
    generateBundle() {
      for (const [dir, name] of files) {
        this.emitFile({ type: 'asset', fileName: `${base}${dir}/${name}`, source: readFileSync(join(root, dir, name)) });
      }
    },
  };
}

// The page a password-protected message's recipient opens (/s/<token>, secure.html) is its own
// small entry, without the mail app. Its strings live with the app's, under securePage in each
// locale file, so they are translated and checked with the rest; this hands the page only that
// part of each file, rather than eleven whole locales.
function securePageStrings() {
  const id = 'virtual:secure-page-strings';
  const dir = new URL('./src/locales/', import.meta.url);
  return {
    name: 'secure-page-strings',
    resolveId(source) { return source === id ? `\0${id}` : null; },
    load(resolved) {
      if (resolved !== `\0${id}`) return null;
      const strings = {};
      for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
        const path = new URL(file, dir);
        this.addWatchFile(fileURLToPath(path));
        strings[file.replace(/\.json$/, '')] = JSON.parse(readFileSync(path, 'utf8')).securePage || {};
      }
      return `export default ${JSON.stringify(strings)};`;
    },
    // In development, /s/<token> is that page too, as the backend serves it in the image.
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (/^\/s\/[^/?]+\/?(?:\?|$)/.test(req.url || '')) req.url = '/secure.html';
        next();
      });
    },
  };
}

// public/sw.js names the release it belongs to, so that every release is a different file and the
// browser installs the new worker (and drops the old one's cache). The id is a hash of the emitted
// file names, which carry Vite's content hashes: a rebuild of the same sources keeps the same id,
// and an unchanged app does not ask anyone to reload.
function serviceWorkerBuildId() {
  let buildId = null;
  let outDir = null;
  return {
    name: 'service-worker-build-id',
    apply: 'build',
    configResolved(config) { outDir = config.build.outDir.startsWith('/') ? config.build.outDir : join(config.root, config.build.outDir); },
    generateBundle(_options, bundle) {
      buildId = createHash('sha256').update(Object.keys(bundle).sort().join('\n')).digest('hex').slice(0, 16);
    },
    closeBundle() {
      if (!buildId) return;
      const file = join(outDir, 'sw.js');
      const source = readFileSync(file, 'utf8');
      for (const marker of ['__PLIMAIL_BUILD_ID__', '/* __PLIMAIL_PRECACHE__ */']) {
        if (!source.includes(marker)) this.error(`sw.js has no ${marker} placeholder`);
      }
      // The whole bundle and the fonts, fetched when the worker installs, so the app opens offline
      // with every screen it has. Source maps are left for whoever debugs.
      const precache = ['assets', 'fonts']
        .flatMap(dir => readdirSync(join(outDir, dir), { recursive: true, withFileTypes: true })
          .filter(entry => entry.isFile() && !entry.name.endsWith('.map'))
          .map(entry => '/' + relative(outDir, join(entry.parentPath, entry.name)).split(sep).join('/')))
        .sort();
      writeFileSync(file, source
        .replace("'__PLIMAIL_BUILD_ID__'", JSON.stringify(buildId))
        .replace('/* __PLIMAIL_PRECACHE__ */', precache.map(path => JSON.stringify(path)).join(', ')));
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsRuntimeAssets(), securePageStrings(), serviceWorkerBuildId()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        secure: fileURLToPath(new URL('./secure.html', import.meta.url)),
      },
    },
  },
  // Module workers, so the pdf.js worker (an ES module) keeps its dynamic imports of the decoders.
  worker: { format: 'es' },
  // The backend the dev server forwards to: `npm run dev` in backend/ by default.
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/api', '/ws', '/oauth', '/auth/oidc', '/carddav', '/.well-known/carddav'].map(path => [path, {
      target: process.env.BACKEND_URL || 'http://localhost:3000',
      ws: path === '/ws',
    }])),
  },
});
