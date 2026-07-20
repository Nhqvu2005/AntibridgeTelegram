/**
 * Test: Spawn claude directly via node-pty using cmd.exe /c
 * (not starting shell then typing command, but passing claude as args)
 */
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const projectDir = path.join(process.env.USERPROFILE, '.claude', 'projects', 'E--AntibridgeTelegram');
const sessionId = '52a1eb69-4496-43a2-8fee-0ad5e80965da';
const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);

// Clean up
for (const f of fs.readdirSync(projectDir)) {
    if (f.startsWith('52a1eb69')) {
        fs.unlinkSync(path.join(projectDir, f));
    }
}
console.log('🧹 Cleaned up');

// Spawn claude via cmd.exe /c
console.log('🚀 Spawning: cmd.exe /c claude --session-id <uuid>');
const proc = pty.spawn('cmd.exe', ['/c', 'claude', '--session-id', sessionId], {
    name: 'xterm-256color', cols: 80, rows: 150,
    cwd: 'E:\\AntibridgeTelegram', env: process.env
});

let output = '';
proc.onData((data) => {
    output += data;
    const cleaned = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0e-\x1f]/g, '').trim();
    if (cleaned.length > 5) console.log(`  [CLAUDE] ${cleaned.slice(0, 120)}`);
});

proc.onExit((code) => {
    console.log(`\n🔌 Claude exited with code ${code}`);
    finish();
});

setTimeout(() => {
    console.log(`\n[5s] File: ${fs.existsSync(expectedFile)}`);
    if (fs.existsSync(expectedFile)) {
        console.log(`  Size: ${fs.statSync(expectedFile).size}`);
    }
    console.log('📤 SENDING: "hello"');
    proc.write('hello\r');
}, 5000);

setTimeout(() => {
    console.log(`\n[15s] File: ${fs.existsSync(expectedFile)}`);
    if (fs.existsSync(expectedFile)) {
        console.log(`  Size: ${fs.statSync(expectedFile).size}`);
    }
}, 15000);

setTimeout(() => {
    console.log('📤 SENDING: /exit');
    proc.write('/exit\r');
}, 20000);

setTimeout(() => {
    finish();
}, 30000);

function finish() {
    console.log('\n=== FINAL ===');
    console.log(`File ${sessionId}.jsonl exists: ${fs.existsSync(expectedFile)}`);
    if (fs.existsSync(expectedFile)) {
        console.log(`Size: ${fs.statSync(expectedFile).size} bytes`);
    }
    console.log('\nProject jsonl files:');
    for (const f of fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))) {
        const fp = path.join(projectDir, f);
        console.log(`  ${f} (${fs.statSync(fp).size} bytes, ${new Date(fs.statSync(fp).mtime).toISOString()})`);
    }
    try { proc.kill(); } catch (_) {}
    process.exit(0);
}
