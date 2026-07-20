/**
 * Test v4: Interactive Claude via node-pty with multiple exchanges
 * Then send /exit and check if .jsonl appears
 */
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const cwd = 'E:\\AntibridgeTelegram';
const shell = 'powershell.exe';
const sessionId = '52a1eb69-4496-43a2-8fee-0ad5e80965da';
const projectDir = path.join(process.env.USERPROFILE, '.claude', 'projects', 'E--AntibridgeTelegram');
const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);

// Clean up any 52a1eb69 files first
for (const f of fs.readdirSync(projectDir)) {
    if (f.startsWith('52a1eb69')) {
        const fp = path.join(projectDir, f);
        if (fs.statSync(fp).isDirectory()) fs.rmSync(fp, { recursive: true });
        else fs.unlinkSync(fp);
    }
}
console.log('🧹 Cleaned up. File after cleanup:', fs.existsSync(expectedFile));

// List files before
console.log('\nFiles BEFORE:');
for (const f of fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl') || f.startsWith('52'))) {
    const fp = path.join(projectDir, f);
    console.log(`  ${f} (${fs.statSync(fp).size} bytes)`);
}

const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color', cols: 80, rows: 150,
    cwd: cwd, env: process.env
});

let output = '';
ptyProcess.onData((data) => {
    output += data;
    // Print only human-readable lines
    const lines = data.split('\n').filter(l => l.trim());
    for (const line of lines.slice(-2)) {
        const cleaned = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[▘▝▀▄▌▐▖▗▟▙▛▜▞▚▆▇█▎▍▌▋▊▉▃▂▁▔▕║═─╔╗╚╝╠╣╦╩╬╒╓╫╪┌┐└┘├┬┴┼╭╮╯╰│…✶✻✽✢✣✤✦✧·●❯←⬩▯▮◉]/g, '').trim();
        if (cleaned.length > 3) console.log(`  [OUT] ${cleaned.slice(0, 150)}`);
    }
});

// Wait, send claude --session-id
setTimeout(() => {
    const cmd = `claude --session-id ${sessionId}`;
    console.log(`\n📤 SENDING: ${cmd}`);
    ptyProcess.write(`${cmd}\r`);
}, 3000);

// Wait for Claude to start, then send a message
setTimeout(() => {
    console.log(`\n📤 SENDING: "Hello, this is test message 1"`);
    ptyProcess.write('Hello, this is test message 1\r');
}, 15000);

// Wait for response, send another message
setTimeout(() => {
    console.log(`\n📤 SENDING: "This is test message 2 - please list 3 numbers"`);
    ptyProcess.write('This is test message 2 - please list 3 numbers\r');
}, 30000);

// Send /exit
setTimeout(() => {
    console.log(`\n📤 SENDING: "/exit"`);
    ptyProcess.write('/exit\r');
}, 45000);

// Wait a bit and check
setTimeout(() => {
    console.log(`\n📤 SENDING: "exit" (shell exit)`);
    ptyProcess.write('exit\r');
}, 55000);

// Final check
setTimeout(() => {
    console.log('\n═══════════ FINAL CHECK ═══════════');
    const exists = fs.existsSync(expectedFile);
    console.log(`File ${sessionId}.jsonl exists: ${exists}`);
    if (exists) {
        console.log(`Size: ${fs.statSync(expectedFile).size} bytes`);
    } else {
        console.log('\nAll jsonl files:');
        for (const f of fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl') && !f.includes('.bak'))) {
            const fp = path.join(projectDir, f);
            console.log(`  ${f} (${fs.statSync(fp).size} bytes, ${new Date(fs.statSync(fp).mtime).toISOString()})`);
        }
        // Search more broadly
        console.log('\nSearching for NEW jsonl files (< 5 min old):');
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        for (const dir of fs.readdirSync(path.join(process.env.USERPROFILE, '.claude', 'projects'))) {
            const subdir = path.join(process.env.USERPROFILE, '.claude', 'projects', dir);
            if (!fs.statSync(subdir).isDirectory()) continue;
            for (const f of fs.readdirSync(subdir).filter(f => f.endsWith('.jsonl') && !f.includes('.bak'))) {
                const fp = path.join(subdir, f);
                if (fs.statSync(fp).mtimeMs > fiveMinAgo) {
                    console.log(`  NEW: ${dir}/${f} (${fs.statSync(fp).size} bytes)`);
                }
            }
        }
    }
    ptyProcess.kill();
    process.exit(0);
}, 65000);
