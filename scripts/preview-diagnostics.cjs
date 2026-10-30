// Local QA: / serves the real page; /qa uses synthetic audio and mock AI, never a real key.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
http.createServer((req,res) => {
  if (!['/','/index.html','/qa'].includes(req.url)) { res.writeHead(404); res.end(); return; }
  let html = fs.readFileSync(path.join(root,'index.html'),'utf8');
  if (req.url === '/qa') {
    const fixture = fs.readFileSync(path.join(root,'realtime-text/tests/fixtures/diagnostics-preview.js'),'utf8');
    html = html.replace('<head>','<head><script>'+fixture+'</script>');
  }
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); res.end(html);
}).listen(3036,'127.0.0.1',()=>console.log('Local preview ready on port 3036 (/qa is synthetic).'));
