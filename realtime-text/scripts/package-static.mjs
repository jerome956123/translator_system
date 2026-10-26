import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
let html = await readFile(resolve(dist, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g)];
for (const match of scripts) {
  const js = await readFile(resolve(dist, match[1]), 'utf8');
  html = html.replace(match[0], () => `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`);
}
const styles = [...html.matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g)];
for (const match of styles) {
  const css = await readFile(resolve(dist, match[1]), 'utf8');
  html = html.replace(match[0], () => `<style>${css}</style>`);
}
if (/src="[^" ]+\.js"|href="[^" ]+\.css"/.test(html)) throw new Error('單檔打包仍有外部程式資源。');
const notices = await Promise.all(['LICENSE', 'THIRD_PARTY_LICENSES.md', 'LICENSES/Apache-2.0.txt']
  .map(file => readFile(resolve(root, 'node_modules/opencc-js', file), 'utf8')));
html = html.replace('</head>', `<!-- opencc-js and dictionary licenses\n${notices.join('\n').replace(/--/g, '- -')}\n-->\n</head>`);
await writeFile(resolve(dist, 'standalone.html'), html);
await writeFile(resolve(root, '..', 'index.html'), html);
console.log('已產生純前端網站 dist/，以及可直接更新 GitHub Pages 首頁的 index.html。');
