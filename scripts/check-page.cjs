// Check the actual uploadable page, including the microphone worklet's embedded code.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function assertNoConflicts(text, name) {
    const marker = /^(?:<<<<<<<(?: .*)?|======={1,}|>>>>>>>(?: .*)?)\r?$/m.exec(text);
    if (marker) {
        const line = text.slice(0, marker.index).split('\n').length;
        throw new Error(`${name}:${line} 還有未處理的 Git 合併衝突，請先保留完整版本再上傳。`);
    }
}

function validatePage(html) {
    assertNoConflicts(html, 'index.html');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    if (!scripts.length || !/id=["']root["']/.test(html)) throw new Error('首頁缺少啟動程式或介面容器。');
    for (const [index, script] of scripts.entries()) {
        try { new vm.Script(script[1]); }
        catch (error) { throw new Error(`首頁第 ${index + 1} 段程式語法錯誤：${error.message}`); }
    }
    const code = scripts.map(script => script[1]).join('\n');
    const worklet = code.match(/`(class Pcm16Resampler[\s\S]*?registerProcessor\('pcm16-resampler',[^\n]*\);\s*)`/);
    if (!worklet) throw new Error('找不到持續收音程式，請檢查完整首頁。');
    try { new vm.Script(worklet[1]); }
    catch (error) { throw new Error(`持續收音程式語法錯誤：${error.message}`); }
    return { scripts: scripts.length, worklet: true };
}

module.exports = { assertNoConflicts, validatePage };
if (require.main === module) {
    const root = path.resolve(__dirname, '..');
    try {
        const result = validatePage(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
        assertNoConflicts(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '.gitignore');
        console.log(`首頁檢查通過：${result.scripts} 段啟動程式、持續收音程式，且沒有合併衝突標記。`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
