// Rebuild the single uploadable page from the existing v2.3.2 production artifact.
// No API key, network request, extra package, or .env file is used by this script.
const fs = require('node:fs');
const path = require('node:path');
const { validatePage } = require('./check-page.cjs');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'realtime-text/dist/standalone.html'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'realtime-text/src/lib/listening-fix.js'), 'utf8');
let page = source;
function replaceOnce(before, after) {
    if (page.split(before).length !== 2) throw new Error('Unexpected production version: ' + before.slice(0, 70));
    page = page.replace(before, after);
}
replaceOnce('mode:"SMART",...s.length?', 'mode:"VERBATIM",...s.length?');
replaceOnce('disabled:!1,prefixPaddingMs:100,silenceDurationMs:800',
    'disabled:!1,startOfSpeechSensitivity:"START_SENSITIVITY_HIGH",prefixPaddingMs:20,silenceDurationMs:800');
replaceOnce('Sv.createRoot(document.getElementById("root"))',
    '\n/* continuous-listening-fix:start */\n' + runtime + '\n/* continuous-listening-fix:end */\nSv.createRoot(document.getElementById("root"))');
replaceOnce('版本 2.3.2 ·', '版本 2.3.3 · 持續聆聽 ·');
validatePage(page);
fs.writeFileSync(path.join(root, 'index.html'), page);
console.log('Created index.html v2.3.3 (bidirectional translation and TWD preserved).');
