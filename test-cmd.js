/**
 * Test: Use cmd.exe instead of powershell.exe in node-pty
 */
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const projectDir = path.join(process.env.USERPROFILE, '.claude', 'projects', 'E--AntibridgeTelegram');

// Clean up 52 files
for (const f of fs.readdirSync(projectDir)) {
    if (f.startsWith('52a1eb69')) {
        const fp = path.join(projectDir, f);
        if (fs.statSync(fp).isDirectory()) fs.rmSync(fp, { recursive: true });
        else fs.unlinkSync(fp);
    }
}

console.log('=== TEST WITH cmd.exe ===');
const pty1 = pty.spawn('cmd.exe', [], {
    name: 'xterm-256color', cols: 80, rows: 150,
    cwd: 'E:\\AntibridgeTelegram', env: process.env
});

let output1 = '';
pty1.onData((data) => {
    output1 += data;
    const cleaned = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x0f]/g, '').trim();
    if (cleaned.length > 3 && cleaned.includes('claude') === false) {
        // just log silently
    }
});

setTimeout(() => {
    console.log('📤 SENDING: claude --session-id 52a1eb69-4496-43a2-8fee-0ad5e80965da');
    pty1.write('claude --session-id 52a1eb69-4496-43a2-8fee-0ad5e80965da\r');
}, 3000);

setTimeout(() => {
    pty1.write('test message from cmd\r');
    console.log('📤 SENDING: test message');
}, 15000);

setTimeout(() => {
    pty1.write('/exit\r');
    console.log('📤 SENDING: /exit');
}, 25000);

setTimeout(() => {
    pty1.write('exit\r');
}, 32000);

setTimeout(() => {
    console.log(`\n=== CHECK ===`);
    console.log(`File 52a1eb69.jsonl exists: ${fs.existsSync(path.join(projectDir, '52a1eb69-4496-43a2-8fee-0ad5e80965da.jsonl'))}`);
    console.log('\nAll jsonl files:');
    for (const f of fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))) {
        const fp = path.join(projectDir, f);
        console.log(`  ${f} (${fs.statSync(fp).size} bytes, ${new Date(fs.statSync(fp).mtime).toISOString()})`);
    }
    pty1.kill();
    process.exit(0);
}, 40000);
