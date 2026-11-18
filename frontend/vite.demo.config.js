import { readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import appConfig from './vite.config.js';

// The online demo (site/demo/, served at plimail.pages.dev/demo/): the real app, built from
// demo.html, which installs an in-browser fake backend (demo/) before the app loads. Built with
// `npm run build:demo`. Nothing here reaches the production build: vite.config.js does not know
// demo.html, and the demo build leaves out the service worker, the manifest and the secure page.
const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');

// The fonts and icons the page needs, under /demo/. fonts.css names its files from the site root,
// so its URLs are moved under the demo's base.
function demoStatic(base) {
  return {
    name: 'demo-static',
    apply: 'build',
    // demo.html names the fonts and icons from the site root, as index.html does.
    transformIndexHtml: html => html.replace(/(href)="\/(fonts|favicon|apple-touch)/g, `$1="${base}$2`),
    writeBundle(options) {
      renameSync(join(options.dir, 'demo.html'), join(options.dir, 'index.html'));
    },
    generateBundle() {
      for (const entry of readdirSync(join(publicDir, 'fonts'), { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        const fileName = path.slice(publicDir.length + 1);
        const source = entry.name === 'fonts.css'
          ? readFileSync(path, 'utf8').replaceAll('url(/fonts/', `url(${base}fonts/`)
          : readFileSync(path);
        this.emitFile({ type: 'asset', fileName, source });
      }
      for (const name of ['favicon.svg', 'apple-touch-icon.png']) {
        this.emitFile({ type: 'asset', fileName: name, source: readFileSync(join(publicDir, name)) });
      }
    },
  };
}

const base = '/demo/';
const keep = new Set();

export default defineConfig({
  base,
  plugins: [
    ...appConfig.plugins.filter(p => !p.name || keep.has(p.name)),
    demoStatic(base),
  ],
  publicDir: false,
  build: {
    outDir: join(root, '..', 'site', 'demo'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: { demo: join(root, 'demo.html') } },
  },
  worker: appConfig.worker,
});
