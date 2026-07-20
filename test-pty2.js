/**
 * Test script v2: Test various claude session-id scenarios
 */
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const cwd = 'E:\\AntibridgeTelegram';
const shell = 'powershell.exe';
const sessionId = '52a1eb69-4496-43a2-8fee-0ad5e80965da';
const projectDir = path.join(process.env.USERPROFILE, '.claude', 'projects', 'E--AntibridgeTelegram');

function checkFile(label) {
    const exists = fs.existsSync(path.join(projectDir, `${sessionId}.jsonl`));
    console.log(`[${label}] File ${sessionId}.jsonl exists: ${exists}`);
    return exists;
}

// Setup: clean up any existing 52a1eb69 files
const patterns = ['52a1eb69*'];
const existing = fs.readdirSync(projectDir).filter(f => f.startsWith('52a1eb69'));
for (const f of existing) {
    const fp = path.join(projectDir, f);
    try {
        if (fs.statSync(fp).isDirectory()) fs.rmSync(fp, { recursive: true });
        else fs.unlinkSync(fp);
    } catch (_) {}
}
console.log('🧹 Cleaned up existing 52a1eb69 files');
checkFile('after-cleanup');

// Test 1: claude --session-id <uuid> --print "hello" from node-pty
console.log('\n═══════════════════════════════════');
console.log('TEST 1: claude --session-id <uuid> --print "test"');
console.log('═══════════════════════════════════\n');

const pty1 = pty.spawn(shell, [], {
    name: 'xterm-256color', cols: 80, rows: 150,
    cwd: cwd, env: process.env
});

let output1 = '';
pty1.onData((data) => {
    output1 += data;
    const lastLine = data.split('\n').filter(l => l.trim()).pop() || '';
    if (lastLine.length > 5) console.log(`  [PTY1] ${lastLine.trim().slice(0, 120)}`);
});

// Send command with --print (non-interactive)
setTimeout(() => {
    const cmd = `claude --session-id ${sessionId} --print "just say hello"`;
    console.log(`📤 Sending: ${cmd}`);
    pty1.write(`${cmd}\r`);
}, 2000);

// Check after command completes
setTimeout(() => {
    checkFile('test1-after-print');

    // Exit shell
    pty1.write('exit\r');
}, 15000);

// Cleanup
setTimeout(() => {
    try { pty1.kill(); } catch (_) {}

    console.log('\n═══════════════════════════════════');
    console.log('TEST 1 DONE');
    console.log('═══════════════════════════════════\n');

    const exists = checkFile('test1-final');

    // List all files in project dir
    console.log('\nAll files in project dir:');
    for (const f of fs.readdirSync(projectDir)) {
        const fp = path.join(projectDir, f);
        const size = fs.statSync(fp).isDirectory() ? 'DIR' : fs.statSync(fp).size + ' bytes';
        console.log(`  - ${f} (${size})`);
    }

    process.exit(exists ? 0 : 1);
}, 20000);
