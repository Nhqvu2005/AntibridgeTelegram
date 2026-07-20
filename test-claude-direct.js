/**
 * Test: Spawn claude DIRECTLY via cmd.exe /c, bypassing PowerShell
 */
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const projectDir = path.join(process.env.USERPROFILE, '.claude', 'projects', 'E--AntibridgeTelegram');
const sessionId = '52a1eb69-4496-43a2-8fee-0ad5e80965da';
const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);

// Clean
for (const f of fs.readdirSync(projectDir)) {
    if (f.startsWith('52a1eb69')) fs.unlinkSync(path.join(projectDir, f));
}
console.log('🧹 Cleaned');

// Spawn claude directly via cmd.exe /c
const proc = pty.spawn('cmd.exe', ['/c', 'claude', '--session-id', sessionId], {
    name: 'xterm-256color', cols: 80, rows: 150,
    cwd: 'E:\\AntibridgeTelegram', env: process.env
});

let output = '';
let fileChecked = false;

proc.onData((data) => {
    output += data;
    const cleaned = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0e-\x1f]/g, '').trim();
    if (cleaned.length > 3) console.log(`  [CLAUDE] ${cleaned.slice(0, 120)}`);

    // Check file as soon as we see Claude is ready
    if (!fileChecked && output.length > 1000) {
        fileChecked = true;
        setTimeout(() => {
            console.log(`\n📁 File exists: ${fs.existsSync(expectedFile)}`);
            if (fs.existsSync(expectedFile)) console.log(`   Size: ${fs.statSync(expectedFile).size}`);
        }, 1000);
    }
});

proc.onExit((code) => {
    console.log(`\n🔌 Exit: ${JSON.stringify(code)}`);
    finish();
});

// Send message at 8s
setTimeout(() => {
    console.log('📤 "hi"');
    proc.write('hi\n');
}, 8000);

// /exit at 18s
setTimeout(() => {
    console.log('📤 /exit');
    proc.write('/exit\n');
}, 18000);

// Wait for clean exit
setTimeout(() => finish(), 30000);

function finish() {
    console.log('\n=== RESULT ===');
    console.log(`File ${sessionId}.jsonl: ${fs.existsSync(expectedFile)}`);
    if (fs.existsSync(expectedFile)) console.log(`Size: ${fs.statSync(expectedFile).size}`);
    console.log('\nAll jsonl:');
    for (const f of fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))) {
        const fp = path.join(projectDir, f);
        console.log(`  ${f} (${fs.statSync(fp).size} bytes)`);
    }
    try { proc.kill(); } catch(_) {}
    process.exit(0);
}
