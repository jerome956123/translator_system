// 只提供靜態檔案，沒有 Gemini 代理、金鑰或應用後端；用於本機預覽。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const port = Number(process.env.PORT || 3000);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, `http://localhost:${port}`).pathname);
    const file = resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(base + sep)) { response.writeHead(403).end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch { response.writeHead(404).end('找不到檔案，請先執行 npm run build。'); }
});
server.on('error', error => { console.error(`無法開啟本機預覽：${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`純前端預覽：http://localhost:${port}（Ctrl+C 結束）`));
