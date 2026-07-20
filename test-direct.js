/**
 * Test v3: Focused test - check where Claude saves session data
 * by monitoring file system changes
 */
const path = require('path');
const fs = require('fs');

const cwd = process.env.USERPROFILE + '\\.claude\\projects\\E--AntibridgeTelegram';

// Before test, capture all files in project dir
console.log('=== BEFORE TEST ===');
const before = {};
for (const f of fs.readdirSync(cwd)) {
    const fp = path.join(cwd, f);
    try {
        before[f] = { size: fs.statSync(fp).size, mtime: fs.statSync(fp).mtimeMs };
    } catch (_) { before[f] = { size: -1, mtime: 0 }; }
    console.log(`  ${f} (${before[f].size} bytes, ${new Date(before[f].mtime).toISOString()})`);
}

console.log('\n=== RUNNING CLAUDE --SESSION-ID IN SHELL ===');
const { execSync } = require('child_process');
try {
    // Use cmd.exe to run claude (avoid PowerShell parsing issues)
    const result = execSync(
        `claude --session-id 52a1eb69-4496-43a2-8fee-0ad5e80965da --print "just say hello"`,
        { cwd: 'E:\\AntibridgeTelegram', encoding: 'utf8', timeout: 120000, windowsHide: true }
    );
    console.log('STDOUT:', result.slice(0, 500));
} catch (e) {
    console.log('ERROR:', e.message?.slice(0, 200));
    if (e.stdout) console.log('STDOUT:', e.stdout.slice(0, 500));
    if (e.stderr) console.log('STDERR:', e.stderr.slice(0, 500));
}

console.log('\n=== AFTER TEST ===');
const after = {};
for (const f of fs.readdirSync(cwd)) {
    const fp = path.join(cwd, f);
    try {
        after[f] = { size: fs.statSync(fp).size, mtime: fs.statSync(fp).mtimeMs };
    } catch (_) { after[f] = { size: -1, mtime: 0 }; }
}

// Compare
for (const f of Object.keys(after)) {
    const b = before[f];
    const a = after[f];
    if (!b) {
        console.log(`  NEW: ${f} (${a.size} bytes)`);
    } else if (b.size !== a.size || b.mtime !== a.mtime) {
        console.log(`  CHANGED: ${f} (${b.size} -> ${a.size} bytes)`);
    }
}
for (const f of Object.keys(before)) {
    if (!after[f]) {
        console.log(`  DELETED: ${f}`);
    }
}
