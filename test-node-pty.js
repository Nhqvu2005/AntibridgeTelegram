const pty = require('node-pty');
const fs = require('fs');
const path = require('path');

const projectDir = path.join(process.env.USERPROFILE, '.claude', 'projects', 'E--AntibridgeTelegram');

// List files trước
console.log('=== FILES BEFORE ===');
const before = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl') && !f.endsWith('.bak'));
before.forEach(f => console.log(`  ${f}`));

// Spawn powershell
const proc = pty.spawn('powershell.exe', [], {
    name: 'xterm-256color', cols: 80, rows: 150,
    cwd: 'E:\\AntibridgeTelegram', env: process.env
});

proc.onData((data) => {
    const cleaned = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x0f]/g, '').trim();
    if (cleaned.length > 3) console.log(`  [OUT] ${cleaned.slice(0, 80)}`);
});

// Chạy claude đơn giản
setTimeout(() => {
    console.log('\n📤 claude');
    proc.write('claude\r');
}, 3000);

// Gửi tin nhắn
setTimeout(() => {
    console.log('📤 test...');
    proc.write('test\r');
}, 12000);

// Thoát
setTimeout(() => {
    console.log('📤 /exit');
    proc.write('/exit\r');
}, 20000);

setTimeout(() => {
    proc.write('exit\r');
}, 25000);

// Check kết quả
setTimeout(() => {
    console.log('\n=== FILES AFTER ===');
    const after = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl') && !f.endsWith('.bak'));
    after.forEach(f => console.log(`  ${f}`));

    const newFiles = after.filter(f => !before.includes(f));
    if (newFiles.length > 0) {
        console.log(`\n✅ FILE MỚI: ${newFiles.join(', ')}`);
    } else {
        console.log('\n❌ KHÔNG có file mới nào!');
    }

    proc.kill();
    process.exit(0);
}, 30000);
