/**
 * Test: Chạy claude ko có --session-id, xem nó tạo file session nào
 */
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const projectDir = path.join(process.env.USERPROFILE, '.claude', 'projects', 'E--AntibridgeTelegram');

// List files trước khi test
console.log('=== FILES BEFORE ===');
const before = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
for (const f of before) {
    const fp = path.join(projectDir, f);
    console.log(`  ${f} (${fs.statSync(fp).size} bytes)`);
}

const ptyProcess = pty.spawn('powershell.exe', [], {
    name: 'xterm-256color', cols: 80, rows: 150,
    cwd: 'E:\\AntibridgeTelegram', env: process.env
});

let output = '';
ptyProcess.onData((data) => {
    output += data;
    const cleaned = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x0f]/g, '').trim();
    if (cleaned.length > 5) console.log(`  [OUT] ${cleaned.slice(0, 100)}`);
});

// Chạy claude ko có --session-id
setTimeout(() => {
    console.log('\n📤 SENDING: claude (NO --session-id)');
    ptyProcess.write('claude\r');
}, 3000);

// Check sau 5s
setTimeout(() => {
    console.log('\n=== FILES AFTER 5s ===');
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
        const fp = path.join(projectDir, f);
        console.log(`  ${f} (${fs.statSync(fp).size} bytes, ${new Date(fs.statSync(fp).mtime).toISOString()})`);
    }
    // Tìm file mới
    const newFiles = files.filter(f => !before.includes(f));
    if (newFiles.length > 0) {
        console.log(`\n✅ NEW FILES: ${newFiles.join(', ')}`);
        // Lấy session ID từ tên file
        const sessionId = newFiles[0].replace('.jsonl', '');
        console.log(`📝 Session ID: ${sessionId}`);
    } else {
        console.log('\n❌ Chưa thấy file mới');
    }
}, 8000);

// Send message
setTimeout(() => {
    console.log('\n📤 SENDING: "test message"');
    ptyProcess.write('test message\r');
}, 12000);

// Check lại
setTimeout(() => {
    console.log('\n=== FILES AFTER 15s ===');
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
        const fp = path.join(projectDir, f);
        console.log(`  ${f} (${fs.statSync(fp).size} bytes)`);
    }
    const newFiles = files.filter(f => !before.includes(f));
    if (newFiles.length > 0) {
        console.log(`\n✅ New session: ${newFiles[0]}`);
    }
}, 15000);

// Exit
setTimeout(() => {
    console.log('\n📤 SENDING: /exit');
    ptyProcess.write('/exit\r');
}, 20000);

setTimeout(() => {
    ptyProcess.write('exit\r');
}, 25000);

setTimeout(() => {
    console.log('\n=== FINAL ===');
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
        const fp = path.join(projectDir, f);
        console.log(`  ${f} (${fs.statSync(fp).size} bytes)`);
    }
    ptyProcess.kill();
    process.exit(0);
}, 30000);
