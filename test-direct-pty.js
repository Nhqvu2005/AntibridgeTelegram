/**
 * Test: Start claude AS THE PTY SHELL directly (not via typing)
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
        const fp = path.join(projectDir, f);
        if (fs.statSync(fp).isDirectory()) fs.rmSync(fp, { recursive: true });
        else fs.unlinkSync(fp);
    }
}
console.log('🧹 Cleaned up');

// Start claude DIRECTLY as the PTY process (not starting shell then typing command)
console.log(`\n🚀 Spawning: claude --session-id ${sessionId} DIRECTLY`);
const ptyProcess = pty.spawn('claude', ['--session-id', sessionId], {
    name: 'xterm-256color', cols: 80, rows: 150,
    cwd: 'E:\\AntibridgeTelegram', env: { ...process.env }
});

let output = '';
ptyProcess.onData((data) => {
    output += data;
    const cleaned = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0e-\x1f]/g, '').trim();
    if (cleaned.length > 5) console.log(`  [CLAUDE] ${cleaned.slice(0, 100)}`);
});

ptyProcess.onExit((code) => {
    console.log(`\n🔌 Claude exited with code ${code}`);
    checkAndFinish();
});

// Check after 5s for file creation
setTimeout(() => {
    console.log(`\n[5s] File exists: ${fs.existsSync(expectedFile)}`);
    if (fs.existsSync(expectedFile)) {
        console.log(`  Size: ${fs.statSync(expectedFile).size}`);
    }

    // Send a message
    console.log('\n📤 SENDING: "hello from pty session"');
    ptyProcess.write('hello from pty session\r');
}, 5000);

setTimeout(() => {
    console.log(`\n[15s] File exists: ${fs.existsSync(expectedFile)}`);
    if (fs.existsSync(expectedFile)) {
        console.log(`  Size: ${fs.statSync(expectedFile).size}`);
    } else {
        console.log('  File still not created');
    }

    // Exit
    console.log('\n📤 SENDING: /exit');
    ptyProcess.write('/exit\r');
}, 15000);

setTimeout(() => {
    process.exit(0);
}, 25000);

function checkAndFinish() {
    console.log('\n=== FINAL CHECK ===');
    console.log(`File ${sessionId}.jsonl exists: ${fs.existsSync(expectedFile)}`);
    if (fs.existsSync(expectedFile)) {
        console.log(`Size: ${fs.statSync(expectedFile).size} bytes`);
    }
    console.log('\nAll jsonl files:');
    for (const f of fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))) {
        const fp = path.join(projectDir, f);
        console.log(`  ${f} (${fs.statSync(fp).size} bytes)`);
    }
}
