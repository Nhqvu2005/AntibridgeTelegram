/**
 * Test v5: Run claude WITHOUT --session-id, check if .jsonl appears
 * This tests if the issue is specific to --session-id or general
 */
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const projectDir = path.join(process.env.USERPROFILE, '.claude', 'projects', 'E--AntibridgeTelegram');

// List files before
console.log('=== FILES BEFORE ===');
const filesBefore = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
for (const f of filesBefore) {
    const fp = path.join(projectDir, f);
    console.log(`  ${f} (${fs.statSync(fp).size} bytes, ${new Date(fs.statSync(fp).mtime).toISOString()})`);
}

const ptyProcess = pty.spawn('powershell.exe', [], {
    name: 'xterm-256color', cols: 80, rows: 150,
    cwd: 'E:\\AntibridgeTelegram', env: process.env
});

let output = '';
ptyProcess.onData((data) => {
    output += data;
    const cleaned = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x1f]|[\x80-\x9f]/g, '').trim();
    if (cleaned.length > 10) console.log(`  [OUT] ${cleaned.slice(0, 120)}`);
});

// Wait, run claude WITHOUT session-id
setTimeout(() => {
    console.log('\n📤 SENDING: claude (WITHOUT --session-id)');
    ptyProcess.write('claude\r');
}, 3000);

// Send a message
setTimeout(() => {
    console.log('📤 SENDING: "hi"');
    ptyProcess.write('hi\r');
}, 15000);

// Exit
setTimeout(() => {
    console.log('📤 SENDING: /exit');
    ptyProcess.write('/exit\r');
}, 30000);

setTimeout(() => {
    ptyProcess.write('exit\r');
}, 38000);

// Check
setTimeout(() => {
    console.log('\n=== FILES AFTER ===');
    const filesAfter = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl') || f.startsWith('5') || f.startsWith('d'));
    for (const f of filesAfter) {
        const fp = path.join(projectDir, f);
        console.log(`  ${f} (${fs.statSync(fp).size} bytes, ${new Date(fs.statSync(fp).mtime).toISOString()})`);
    }

    // Find new files
    console.log('\n=== NEW FILES ===');
    const afterSet = new Set(filesAfter);
    const beforeFiles = new Set(fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl') || f.startsWith('5') || f.startsWith('d')));
    for (const f of filesAfter) {
        if (!beforeFiles.has(f)) {
            console.log(`  NEW: ${f}`);
        }
    }
    for (const f of beforeFiles) {
        if (!afterSet.has(f)) {
            console.log(`  REMOVED: ${f}`);
        }
    }

    ptyProcess.kill();
    process.exit(0);
}, 45000);
