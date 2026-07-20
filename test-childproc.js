/**
 * Test: Run claude as child_process (not PTY) and check if session persists
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
        const fp = path.join(projectDir, f);
        if (fs.statSync(fp).isDirectory()) fs.rmSync(fp, { recursive: true });
        else fs.unlinkSync(fp);
    }
}
console.log('🧹 Cleaned up. File exists:', fs.existsSync(expectedFile));

// Spawn claude via cmd.exe /c
console.log('\n🚀 Spawning: cmd.exe /c claude --session-id 52a1eb69-4496-43a2-8fee-0ad5e80965da');
const claude = spawn('cmd.exe', ['/c', 'claude', '--session-id', sessionId], {
    cwd: 'E:\\AntibridgeTelegram',
    env: { ...process.env },
    windowsHide: true
});

claude.stdout.on('data', (data) => {
    const text = data.toString();
    const cleaned = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0e-\x1f]/g, '').trim();
    if (cleaned.length > 3) {
        console.log(`  [CLAUDE] ${cleaned.slice(0, 150)}`);
    }
});

claude.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) console.log(`  [ERR] ${text.slice(0, 100)}`);
});

claude.on('exit', (code) => {
    console.log(`\n🔌 Claude exited with code ${code}`);
    finalCheck();
});

claude.on('error', (err) => {
    console.log(`\n❌ Error: ${err.message}`);
});

// Wait for Claude to start (it should show interactive prompt)
setTimeout(() => {
    console.log(`\n[8s] File exists: ${fs.existsSync(expectedFile)}`);
    checkNow();
}, 8000);

function checkNow() {
    if (fs.existsSync(expectedFile)) {
        console.log(`  Size: ${fs.statSync(expectedFile).size} bytes`);
        console.log('✅ File was created!');
    } else {
        console.log('  File not yet created');
        // Check directory
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
        console.log('  Current files:', files.join(', '));
    }
}

// Send a message
setTimeout(() => {
    console.log('\n📤 SENDING: "hello from child_process test"');
    claude.stdin.write('hello from child_process test\n');
}, 10000);

setTimeout(() => {
    console.log(`\n[20s] File exists: ${fs.existsSync(expectedFile)}`);
    checkNow();
}, 20000);

// Send /exit
setTimeout(() => {
    console.log('\n📤 SENDING: /exit');
    claude.stdin.write('/exit\n');
}, 25000);

function finalCheck() {
    console.log('\n=== FINAL ===');
    console.log(`File ${sessionId}.jsonl exists: ${fs.existsSync(expectedFile)}`);
    if (fs.existsSync(expectedFile)) {
        console.log(`Size: ${fs.statSync(expectedFile).size} bytes`);
    }
    console.log('\nProject files:');
    for (const f of fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))) {
        const fp = path.join(projectDir, f);
        console.log(`  ${f} (${fs.statSync(fp).size} bytes, ${new Date(fs.statSync(fp).mtime).toISOString()})`);
    }
    process.exit(0);
}

// Timeout
setTimeout(() => {
    try { claude.kill(); } catch (_) {}
    console.log('\n⏰ Timeout reached');
    finalCheck();
}, 40000);
