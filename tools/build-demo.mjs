// Builds docs/demo/: the real panel page plus demo/demo.js (a fake proxy with sample data),
// so the panel can be tried on a static host such as GitHub Pages. Run: node tools/build-demo.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'demo');
mkdirSync(join(out, 'api'), { recursive: true });

const page = readFileSync(join(root, 'public', 'index.html'), 'utf8');
// WHY: demo.js must replace XMLHttpRequest before the panel's own script runs, so it goes in front of the first <script>
const i = page.indexOf('<script>');
if (i < 0) throw new Error('No inline <script> found in public/index.html');
writeFileSync(join(out, 'index.html'), page.slice(0, i) + '<script src="demo.js"></script>\n' + page.slice(i));
copyFileSync(join(root, 'demo', 'demo.js'), join(out, 'demo.js'));
// Camera stills: a static host ignores the query string, so every camera shows this one sample picture
copyFileSync(join(root, 'demo', 'camera.jpg'), join(out, 'api', 'cam'));
console.log('docs/demo built');
