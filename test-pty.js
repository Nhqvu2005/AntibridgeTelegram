/**
 * Test script: spawn PowerShell via node-pty and send claude --session-id
 * Then check if the .jsonl file gets created.
 */
const path = require('path');
const fs = require('fs');

// Load node-pty
let pty;
try {
    pty = require('node-pty');
    console.log('✅ node-pty loaded');
} catch (e) {
    console.error('❌ node-pty:', e.message);
    process.exit(1);
}

const cwd = 'E:\\AntibridgeTelegram';
const shell = 'powershell.exe';
const sessionId = '52a1eb69-4496-43a2-8fee-0ad5e80965da';
const projectDir = path.join(process.env.USERPROFILE || 'C:\\Users\\PC', '.claude', 'projects', 'E--AntibridgeTelegram');
const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);

console.log(`📁 Project dir: ${projectDir}`);
console.log(`📄 Expected file: ${expectedFile}`);
console.log(`🔍 File exists NOW: ${fs.existsSync(expectedFile)}`);

// Remove the file if it exists (from our manual test)
try { fs.unlinkSync(expectedFile); } catch (_) {}
try { fs.unlinkSync(expectedFile + '.bak'); } catch (_) {}
console.log(`🧹 Cleaned up. File exists: ${fs.existsSync(expectedFile)}`);

// Spawn PowerShell
console.log(`\n🚀 Spawning ${shell} in ${cwd}...`);
const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 150,
    cwd: cwd,
    env: process.env
});

let output = '';
ptyProcess.onData((data) => {
    output += data;
    // Only print last bit to keep output manageable
    const lines = data.split('\n');
    for (const line of lines.slice(-3)) {
        if (line.trim()) console.log(`  [PTY] ${line.trim().slice(0, 120)}`);
    }
});

ptyProcess.onExit((e) => {
    console.log(`\n🔌 PTY exited with code ${e.exitCode}`);
});

// Wait for shell to be ready, then send command
setTimeout(() => {
    console.log(`\n📤 Sending: claude --session-id ${sessionId}`);
    ptyProcess.write(`claude --session-id ${sessionId}\r`);
}, 3000);

// Wait for Claude to start, check file
setTimeout(() => {
    console.log(`\n🔍 After 8s - File "${sessionId}.jsonl" exists: ${fs.existsSync(expectedFile)}`);
    if (fs.existsSync(expectedFile)) {
        const stat = fs.statSync(expectedFile);
        console.log(`   File size: ${stat.size} bytes`);
        console.log('✅ SUCCESS - Claude created the session file!');
    }

    // Send a message to Claude
    console.log(`\n📤 Sending: hello test message`);
    ptyProcess.write('hello test message\r');
}, 8000);

// Send /exit to Claude and exit shell
setTimeout(() => {
    console.log(`\n📤 Sending /exit to Claude...`);
    ptyProcess.write('/exit\r');
}, 15000);

setTimeout(() => {
    console.log(`\n📤 Sending exit to shell...`);
    ptyProcess.write('exit\r');
}, 18000);

// Final check
setTimeout(() => {
    console.log(`\n🔍 After 20s (post-exit) - File "${sessionId}.jsonl" exists: ${fs.existsSync(expectedFile)}`);
    if (fs.existsSync(expectedFile)) {
        const stat = fs.statSync(expectedFile);
        console.log(`   File size: ${stat.size} bytes`);
        console.log('✅ SUCCESS - Claude created the file on exit!');
    } else {
        console.log('❌ FAIL - File was NOT created even after /exit');
        console.log(`   Checking all files in ${projectDir}:`);
        const files = fs.readdirSync(projectDir);
        for (const f of files) {
            console.log(`   - ${f} (${f.endsWith('.jsonl') ? (fs.statSync(path.join(projectDir, f)).size + ' bytes') : fs.statSync(path.join(projectDir, f)).isDirectory() ? 'DIR' : 'FILE'})`);
        }
        // Check if it was created with a different name
        console.log(`\n   Looking for ANY new jsonl files...`);
        const files2 = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
        const newFiles = files2.filter(f => !['da2600a2-5571-419c-b40a-00cd5432b8db.jsonl', 'dca173f1-bd2a-4a37-8bfc-687b017ee0ef.jsonl'].includes(f));
        if (newFiles.length > 0) {
            console.log(`   Found NEW files: ${newFiles.join(', ')}`);
        } else {
            console.log(`   No new files found. Checking sessions dir...`);
            const sessionsFiles = require('fs').readdirSync(path.join(process.env.USERPROFILE, '.claude', 'sessions'));
            console.log(`   Sessions: ${sessionsFiles.join(', ')}`);
        }
    }

    console.log(`\n   PTY output tail:\n${output.slice(-2000)}`);
    ptyProcess.kill();
    process.exit(0);
}, 20000);
