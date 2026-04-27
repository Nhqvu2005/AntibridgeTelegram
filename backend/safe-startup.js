/**
 * Safe-mode startup wrapper for AntiBridge Telegram.
 *
 * START_BOT.bat runs this file instead of telegram-server.js directly.
 * This catches SyntaxError/import-time crashes, reports them to Telegram,
 * and rolls back to the latest pushed GitHub version: origin/main.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { execSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'Data');
const SAFE_MODE_FILE = path.join(DATA_DIR, '.safe_mode');
const CRASH_LOG_FILE = path.join(DATA_DIR, 'crash_error.log');
const STABLE_AFTER_MS = 15000;

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadEnv() {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) {
        console.log('⚠️ .env not found. Telegram crash report may not work.');
        return;
    }

    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^([^=]+)=(.*)$/);
        if (m) process.env[m[1].trim()] = m[2].trim();
    }
}

function sendTelegram(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        console.log('⚠️ Missing Telegram token/chatId. Cannot send crash report.');
        return;
    }

    const payload = JSON.stringify({ chat_id: chatId, text });
    const req = http.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    }, (res) => console.log('📱 Telegram report status:', res.statusCode));

    req.on('error', (e) => console.log('⚠️ Telegram send failed:', e.message));
    req.setTimeout(8000, () => req.destroy());
    req.write(payload);
    req.end();
}

function writeMarker(type, message, detail = '') {
    ensureDataDir();
    fs.writeFileSync(SAFE_MODE_FILE, `${type}|${Date.now()}|${String(message || '').slice(0, 200)}`);
    fs.writeFileSync(CRASH_LOG_FILE, String(detail || '').slice(0, 8000));
}

function readMarker() {
    if (!fs.existsSync(SAFE_MODE_FILE)) return null;
    const marker = fs.readFileSync(SAFE_MODE_FILE, 'utf-8').trim();
    const [type, timestamp, ...msgParts] = marker.split('|');
    const detail = fs.existsSync(CRASH_LOG_FILE) ? fs.readFileSync(CRASH_LOG_FILE, 'utf-8') : '';
    return { type, timestamp, message: msgParts.join('|'), detail };
}

function clearMarker() {
    try { fs.unlinkSync(SAFE_MODE_FILE); } catch (_) { }
    try { fs.unlinkSync(CRASH_LOG_FILE); } catch (_) { }
}

function rollbackToGithubLatest() {
    try {
        console.log('🔄 Stashing local changes before rollback...');
        execSync('git stash push -u -m "auto-safe-startup-crash"', { cwd: ROOT, stdio: 'ignore' });
    } catch (_) { }

    try {
        console.log('📥 Fetching latest origin/main from GitHub...');
        execSync('git remote set-url origin https://github.com/Nhqvu2005/AntibridgeTelegram.git', { cwd: ROOT, stdio: 'ignore' });
        execSync('git fetch origin main', { cwd: ROOT, stdio: 'inherit' });

        const latest = execSync('git rev-parse origin/main', { cwd: ROOT, encoding: 'utf-8' }).trim();
        console.log('🔄 Resetting hard to GitHub latest:', latest.slice(0, 8));
        execSync('git reset --hard origin/main', { cwd: ROOT, stdio: 'inherit' });
        execSync('git clean -fd', { cwd: ROOT, stdio: 'inherit' });
        return latest;
    } catch (e) {
        console.log('❌ GitHub rollback failed:', e.message);
        return null;
    }
}

function recoverPreviousCrash() {
    const info = readMarker();
    if (!info) return;

    console.log('🛡️ Previous crash marker detected:', info.type);
    const detail = info.detail || info.message || 'Unknown error';
    const time = info.timestamp ? new Date(Number(info.timestamp)).toLocaleString('vi-VN') : 'Unknown';

    sendTelegram([
        '🛡️ CRASH DETECTED — Auto recovery started',
        `Type: ${info.type || 'unknown'}`,
        `Time: ${time}`,
        '',
        'Error:',
        detail.slice(0, 3000),
        '',
        '📥 Rolling back to latest stable version on GitHub: origin/main...'
    ].join('\n'));

    const rolled = rollbackToGithubLatest();
    clearMarker();

    sendTelegram(rolled
        ? `✅ Auto rollback complete from GitHub origin/main: ${rolled.slice(0, 8)}\nBot will restart with the latest pushed stable version.`
        : '❌ Auto rollback from GitHub failed. Please remote in and inspect the repository.');
}

function main() {
    loadEnv();
    ensureDataDir();

    console.log('🛡️ safe-startup.js running...');
    console.log('   ROOT:', ROOT);

    recoverPreviousCrash();

    writeMarker('pre_startup', 'Server about to start', 'Waiting for server startup stability...');

    const mainScript = path.join(__dirname, 'telegram-server.js');
    console.log('🚀 Starting telegram-server.js...');

    let output = '';
    let stable = false;

    const child = spawn(process.execPath, [mainScript], {
        cwd: ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (d) => {
        const text = d.toString();
        process.stdout.write(text);
        output += text;
    });

    child.stderr.on('data', (d) => {
        const text = d.toString();
        process.stderr.write(text);
        output += text;
    });

    setTimeout(() => {
        if (child.exitCode === null) {
            stable = true;
            clearMarker();
            console.log(`✅ Server stable for ${STABLE_AFTER_MS / 1000}s. Crash marker cleared.`);
        }
    }, STABLE_AFTER_MS);

    child.on('exit', (code, signal) => {
        console.log(`\n🔍 telegram-server.js exited. code=${code}, signal=${signal}`);

        if (code === 0) {
            clearMarker();
            process.exit(0);
        }

        writeMarker('child_crash', `exit_code_${code}`, output);

        sendTelegram([
            '💥 AntiBridge crashed during startup/runtime',
            `Exit code: ${code}`,
            `Stable before crash: ${stable ? 'yes' : 'no'}`,
            '',
            output.slice(0, 3000),
            '',
            'The next START_BOT.bat loop will rollback to GitHub origin/main.'
        ].join('\n'));

        process.exit(code || 1);
    });

    child.on('error', (err) => {
        writeMarker('spawn_error', err.message, err.stack || err.message);
        sendTelegram(`💥 Failed to spawn telegram-server.js:\n${err.stack || err.message}`);
        process.exit(1);
    });
}

main();
