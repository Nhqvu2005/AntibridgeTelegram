/**
 * Test: spawn claude via winpty from child_process
 * winpty provides a proper Windows console
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

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

// Test via winpty
console.log('🚀 Spawning: winpty claude --session-id <uuid>');
const claude = spawn('winpty.exe', ['claude', '--session-id', sessionId], {
    cwd: 'E:\\AntibridgeTelegram',
    env: { ...process.env },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
});

let output = '';
claude.stdout.on('data', (data) => {
    output += data.toString();
    const cleaned = data.toString().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0e-\x1f]/g, '').trim();
    if (cleaned.length > 3) console.log(`  [CLAUDE] ${cleaned.slice(0, 150)}`);
});
claude.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`  [ERR] ${msg.slice(0, 100)}`);
});
claude.on('exit', (code) => {
    console.log(`\n🔌 Exit code: ${code}`);
    finish();
});

setTimeout(() => {
    console.log(`\n[8s] File: ${fs.existsSync(expectedFile)}`);
    console.log('📤 Sending hello');
    claude.stdin.write('hello\r\n');
}, 8000);

setTimeout(() => {
    console.log(`\n[18s] File: ${fs.existsSync(expectedFile)}`);
    console.log('📤 Sending /exit');
    claude.stdin.write('/exit\r\n');
}, 18000);

setTimeout(() => {
    finish();
}, 30000);

function finish() {
    console.log('\n=== FINAL ===');
    console.log(`File ${sessionId}.jsonl exists: ${fs.existsSync(expectedFile)}`);
    if (fs.existsSync(expectedFile)) {
        console.log(`Size: ${fs.statSync(expectedFile).size} bytes`);
    } else {
        console.log('❌ NOT CREATED');
        console.log('Project files:');
        for (const f of fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))) {
            console.log(`  ${f}`);
        }
        console.log(`\nOutput:\n${output.slice(-1000)}`);
    }
    try { claude.kill(); } catch (_) {}
    process.exit(0);
}
