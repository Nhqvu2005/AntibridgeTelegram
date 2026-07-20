/**
 * TerminalSession — Quản lý 1 session terminal duy nhất.
 * Mỗi session có pty process, xterm headless, và state riêng.
 */

const { Terminal } = require('@xterm/headless');
const fs = require('fs');
const path = require('path');
const os = require('os');

class TerminalSession {
    constructor(telegramBot, name, cwd) {
        this.telegramBot = telegramBot;
        this.name = name;
        this.cwd = cwd || process.cwd();
        this.ptyProcess = null;
        this.term = null;
        this.debounceTimeout = null;
        this.activeMsgId = null;
        this.isActive = false;
        this.needsFlush = false;
        this.isFlushing = false;
        this.flushInterval = 500;
        this.cols = 80;
        this.rows = 150;
        this.createdAt = Date.now();
        // Session ID dùng chung — sync giữa Telegram terminal và local máy
        this.claudeSessionId = TerminalSession._getOrCreateSharedSessionId(this.cwd);
        this._sessionDetectInterval = null;
    }

    /**
     * Tạo / đọc shared session ID từ file .claude-sync-session trong project.
     * Dùng chung cho cả Telegram terminal và local machine → cùng 1 conversation.
     */
    static _getOrCreateSharedSessionId(cwd) {
        const syncFile = path.join(cwd, '.claude-sync-session');
        try {
            if (fs.existsSync(syncFile)) {
                const existing = fs.readFileSync(syncFile, 'utf8').trim();
                if (existing) return existing;
            }
        } catch (_) {}

        // Tạo UUID v4 mới và lưu lại
        const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
        try {
            fs.writeFileSync(syncFile, uuid, 'utf8');
            console.log(`🔑 [TerminalSession] Created shared session ID: ${uuid} → ${syncFile}`);
        } catch (_) {}
        return uuid;
    }

    // Lazy load node-pty - chỉ load khi cần, tránh crash khi AttachConsole failed
    _getPty() {
        if (!this._pty) {
            try {
                this._pty = require('node-pty');
            } catch (e) {
                console.error(`❌ [${this.name}] Không thể load node-pty: ${e.message}`);
                throw new Error('node-pty not available: ' + e.message);
            }
        }
        return this._pty;
    }

    start() {
        if (this.ptyProcess) return;

        const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';

        console.log(`🖥️ [${this.name}] Khởi động session tại ${this.cwd}...`);

        // Khởi tạo xterm headless engine giả lập môi trường terminal
        this.term = new Terminal({
            cols: this.cols,
            rows: this.rows,
            allowProposedApi: true
        });

        try {
            // node-pty process - bọc try/catch để không crash bot khi AttachConsole failed
            const nodePty = this._getPty();

            // Lọc environment: loại bỏ biến Claude để PTY không auto-resume session cũ
            // Trên local terminal (mở PowerShell mới) các biến này không tồn tại,
            // nên claude trong PTY cũng cần môi trường sạch như vậy.
            const cleanEnv = {};
            for (const key of Object.keys(process.env)) {
                // Bỏ qua biến Claude session/child — giữ API key và base URL để còn gọi API
                if (key.startsWith('CLAUDE_CODE_SESSION') ||
                    key === 'CLAUDE_CODE_CHILD_SESSION' ||
                    key === 'CLAUDE_CODE_ENTRYPOINT' ||
                    key === 'CLAUDE_CODE_EXECPATH') {
                    continue;
                }
                cleanEnv[key] = process.env[key];
            }

            this.ptyProcess = nodePty.spawn(shell, [], {
                name: 'xterm-256color',
                cols: this.cols,
                rows: this.rows,
                cwd: this.cwd,
                env: cleanEnv
            });
        } catch (e) {
            console.error(`❌ [${this.name}] Lỗi khởi tạo pty: ${e.message}`);
            if (this.term) {
                try { this.term.dispose(); } catch (_) {}
                this.term = null;
            }
            this.isActive = false;
            return;
        }

        this.ptyProcess.onData((data) => {
            if (this.term) {
                this.term.write(data, () => {
                    this.scheduleFlush();
                });
            }
        });

        this.ptyProcess.onExit((e) => {
            console.log(`🔌 [${this.name}] PTY exit: code=${e.exitCode}`);
            if (this.term) {
                try {
                    this.term.write(`\n\n[Terminal exited with code ${e.exitCode}]\n`);
                } catch (err) {
                    // Term đã dispose rồi, ignore
                }
                this.scheduleFlush();
            }
            // KHÔNG tự restart - để user quyết định
            this.ptyProcess = null;
            this.isActive = false;
        });

        // Handle uncaught error từ pty
        this.ptyProcess.on('error', (e) => {
            console.error(`❌ [${this.name}] PTY error: ${e.message}`);
            // Không crash bot - chỉ log
        });

        this.isActive = true;
    }

    stop() {
        if (this.ptyProcess) {
            try {
                this.ptyProcess.kill();
            } catch (e) {
                console.log(`⚠️ [${this.name}] Lỗi khi kill pty: ${e.message}`);
            }
            this.ptyProcess = null;
        }
        if (this.term) {
            try { this.term.dispose(); } catch (_) {}
            this.term = null;
        }
        if (this.debounceTimeout) {
            clearTimeout(this.debounceTimeout);
            this.debounceTimeout = null;
        }
        this.isActive = false;
        this.isFlushing = false;
        this.needsFlush = false;
        this.isShuttingDown = false;
        this._stopSessionDetection();
    }

    /**
     * Graceful shutdown — gửi lệnh /exit cho Claude Code trước khi kill pty,
     * đảm bảo conversation được flush ra .jsonl kịp thời.
     * @param {number} timeoutMs - thời gian chờ Claude save (mặc định 3s)
     */
    async stopGraceful(timeoutMs = 3000) {
        if (!this.ptyProcess && !this.term) return;

        console.log(`🛑 [${this.name}] Graceful shutdown (timeout=${timeoutMs}ms)...`);
        this.isShuttingDown = true;

        if (this.ptyProcess) {
            try {
                // Step 1: Gửi lệnh /exit vào PTY — nếu Claude đang chạy, nó sẽ
                // nhận được lệnh này, save conversation, và thoát.
                // Nếu chỉ có shell prompt, /exit sẽ báo "command not found".
                console.log(`   [${this.name}] Sending /exit to Claude...`);
                this.ptyProcess.write('/exit\r');
                await new Promise(r => setTimeout(r, 1500));

                // Step 2: Nếu Claude đã thoát (step 1), lúc này đang ở shell prompt.
                // Gửi exit để đóng shell.
                console.log(`   [${this.name}] Sending exit to shell...`);
                this.ptyProcess.write('exit\r');
                await new Promise(r => setTimeout(r, 800));

                // Step 3: Ctrl+C dự phòng — nếu có process nào còn chạy
                if (this.ptyProcess) {
                    console.log(`   [${this.name}] Sending Ctrl+C (fallback)...`);
                    this.ptyProcess.write('\x03');
                    await new Promise(r => setTimeout(r, 500));
                }

                // Step 4: Chờ thêm thời gian cho Claude kịp flush file
                const remainingWait = Math.max(0, timeoutMs - 2800);
                if (remainingWait > 0 && this.ptyProcess) {
                    console.log(`   [${this.name}] Waiting ${remainingWait}ms more for save...`);
                    await new Promise(r => setTimeout(r, remainingWait));
                }
            } catch (e) {
                if (e.message && !e.message.includes('Cannot read properties of null')) {
                    console.log(`⚠️ [${this.name}] Graceful shutdown error: ${e.message}`);
                }
            }
        }

        console.log(`   [${this.name}] Hard cleanup...`);

        // Final safety: copy .jsonl → .jsonl.bak nếu có thể
        try {
            const slug = this.cwd.replace(/:/g, '-').replace(/[\\/]/g, '-');
            const projectDir = path.join(os.homedir(), '.claude', 'projects', slug);
            if (fs.existsSync(projectDir)) {
                const files = fs.readdirSync(projectDir);
                for (const f of files.filter(f => f.endsWith('.jsonl') && !f.endsWith('.bak'))) {
                    const src = path.join(projectDir, f);
                    const dst = path.join(projectDir, f + '.bak');
                    try { fs.copyFileSync(src, dst); } catch (_) { }
                }
            }
        } catch (_) {}

        this.stop();
    }

    isRunning() {
        return this.isActive && this.ptyProcess !== null;
    }

    write(text) {
        if (!this.ptyProcess) {
            this.start();
            // Khi start session mới, bắt đầu theo dõi session ID thực tế
            this._startSessionDetection();
        }

        // Reset activeMsgId để lệnh chat mới luôn sinh ra bubble terminal mới
        this.activeMsgId = null;

        const trimmed = text.trim();

        // Nếu user gõ "claude" — chỉ chạy claude đơn giản, KHÔNG gán --session-id
        // Quan trọng: dọn session tracking file cũ để claude tạo session MỚI
        if (/^claude\s*$/.test(trimmed)) {
            console.log(`🔄 [${this.name}] Starting Claude (let it manage its own session)...`);

            // Dọn session tracking file cũ (PID không còn chạy)
            this._cleanStaleSessionFiles();

            this.telegramBot.sendMessage(
                `🔄 Starting Claude...\nSession sẽ được tự động phát hiện và ghi vào \`.claude-sync-session\``
            ).catch(() => {});
            // text giữ nguyên là "claude" — ko thêm --session-id
            this.ptyProcess.write(text);
            setTimeout(() => {
                if (this.ptyProcess) this.ptyProcess.write('\r');
            }, 100);
            return;
        }

        // Gửi text trước (giả lập thao tác paste)
        this.ptyProcess.write(text);

        // Gửi phím Enter (\r) cắm đuôi sau delay nhỏ
        setTimeout(() => {
            if (this.ptyProcess) this.ptyProcess.write('\r');
        }, 100);
    }

    writeRaw(data) {
        if (!this.ptyProcess) {
            this.start();
            this._startSessionDetection();
        }
        this.ptyProcess.write(data);
    }

    // ─── Session ID Detection ──────────────────────────────────────────────
    // Khi Claude chạy trong PTY, nó tự quản lý session ID.
    // Ta cần detect file .jsonl nào đang được ghi để cập nhật .claude-sync-session.
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Dọn session tracking file cũ của claude.
     * File ở ~/.claude/sessions/<pid>.json chứa session ID + cwd.
     * Nếu PID không còn chạy nữa, claude sẽ auto-resume session cũ thay vì tạo mới.
     * Xóa nó đi → lần chạy claude tiếp theo sẽ tạo session MỚI.
     */
    _cleanStaleSessionFiles() {
        const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
        if (!fs.existsSync(sessionsDir)) return;

        const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
        let cleaned = 0;

        for (const file of files) {
            try {
                const content = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
                if (content.cwd === this.cwd) {
                    // process.kill(pid, 0) = kiểm tra PID còn sống ko (ESRCH = dead)
                    let alive = true;
                    try {
                        process.kill(content.pid, 0);
                    } catch (e) {
                        alive = (e.code === 'ESRCH' ? false : true);
                    }

                    if (!alive) {
                        fs.unlinkSync(path.join(sessionsDir, file));
                        console.log(`🧹 [${this.name}] Removed stale session: ${content.sessionId} (PID ${content.pid} not running)`);
                        cleaned++;
                    }
                }
            } catch (_) {
                // File lỗi format hoặc ko đọc được → xóa luôn cho sạch
                try {
                    fs.unlinkSync(path.join(sessionsDir, file));
                    cleaned++;
                } catch (_) {}
            }
        }

        if (cleaned > 0) {
            console.log(`🧹 [${this.name}] Cleaned ${cleaned} stale session file(s)`);
        }
    }

    /**
     * Bắt đầu theo dõi session ID thực tế của Claude.
     * Quét thư mục .claude/projects/<slug>/ mỗi 3s để tìm .jsonl đang active.
     */
    _startSessionDetection() {
        if (this._sessionDetectInterval) return;

        const slug = this.cwd.replace(/:/g, '-').replace(/[\\/]/g, '-');
        const projectDir = path.join(os.homedir(), '.claude', 'projects', slug);
        const syncFile = path.join(this.cwd, '.claude-sync-session');

        let lastDetectedId = null;

        console.log(`🔍 [${this.name}] Session detection started → ${projectDir}`);

        this._sessionDetectInterval = setInterval(() => {
            try {
                if (!fs.existsSync(projectDir)) return;

                // Lấy tất cả file .jsonl (ko tính .bak)
                let files = fs.readdirSync(projectDir)
                    .filter(f => f.endsWith('.jsonl') && !f.endsWith('.bak'))
                    .map(f => ({
                        name: f,
                        path: path.join(projectDir, f),
                        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs
                    }))
                    .sort((a, b) => b.mtime - a.mtime); // mới nhất lên đầu

                if (files.length === 0) return;

                // File .jsonl được modify gần đây nhất là session đang active
                const newest = files[0];
                const detectedId = newest.name.replace('.jsonl', '');

                // Nếu file này mới hơn 30s → đang active
                const age = Date.now() - newest.mtime;
                if (age > 30000) return; // quá cũ, bỏ qua

                if (detectedId !== lastDetectedId) {
                    lastDetectedId = detectedId;
                    console.log(`🔍 [${this.name}] Detected active session: ${detectedId} (${Math.round(age/1000)}s old)`);

                    // Kiểm tra file sync có cần update ko
                    let currentSyncId = null;
                    try {
                        if (fs.existsSync(syncFile)) {
                            currentSyncId = fs.readFileSync(syncFile, 'utf8').trim();
                        }
                    } catch (_) {}

                    if (detectedId !== currentSyncId) {
                        try {
                            fs.writeFileSync(syncFile, detectedId, 'utf8');
                            console.log(`🔑 [${this.name}] Updated .claude-sync-session → ${detectedId}`);
                            this.claudeSessionId = detectedId;

                            // Reset activeMsgId để lần flush tới tạo message mới với session info
                            if (this.isRunning()) {
                                // Gửi thông báo session mới (nhưng không spam)
                                this.telegramBot.sendMessage(
                                    `📝 Session: \`${detectedId}\``,
                                    { parse_mode: 'Markdown' }
                                ).catch(() => {});
                            }
                        } catch (e) {
                            console.log(`⚠️ [${this.name}] Could not write .claude-sync-session: ${e.message}`);
                        }
                    }
                }
            } catch (e) {
                // Silent — không crash vì lỗi detection
            }
        }, 3000);
    }

    _stopSessionDetection() {
        if (this._sessionDetectInterval) {
            clearInterval(this._sessionDetectInterval);
            this._sessionDetectInterval = null;
        }
    }

    sendCtrlC() {
        if (!this.ptyProcess) return;
        this.ptyProcess.write('\x03');
        this.telegramBot.sendMessage(`🛑 Đã gửi Ctrl+C tới Terminal session **${this.name}**.`);
    }

    scheduleFlush() {
        if (this.isShuttingDown) return;
        this.needsFlush = true;
        if (!this.isFlushing && !this.debounceTimeout) {
            this.processFlushQueue();
        }
    }

    async processFlushQueue() {
        if (!this.needsFlush) return;

        this.isFlushing = true;
        this.needsFlush = false;

        try {
            await this.flushOutput();
        } finally {
            this.debounceTimeout = setTimeout(() => {
                this.debounceTimeout = null;
                this.isFlushing = false;

                if (this.needsFlush) {
                    this.processFlushQueue();
                }
            }, this.flushInterval);
        }
    }

    getDisplay() {
        if (!this.term) return '';

        let lines = [];
        const buffer = this.term.buffer.active;
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (line) {
                lines.push(line.translateToString(true));
            }
        }

        let display = lines.join('\n').replace(/\n+$/, '');
        display = display.replace(/[─-╿■-◿☀-⛿⠀-⣿←-⇿╭─╮│╰╯]/g, '');

        return display;
    }

    async flushOutput() {
        let display = this.getDisplay();
        if (!display || !display.trim()) return;

        if (display.length > 3800) {
            display = display.substring(display.length - 3800);
        }

        const safeDisplay = display.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
        const markdownDisplay = `\`\`\`\n${safeDisplay}\n\`\`\``;

        if (!this.activeMsgId) {
            try {
                const msg = await this.telegramBot.bot.sendMessage(this.telegramBot.chatId, markdownDisplay, { parse_mode: 'MarkdownV2' });
                this.activeMsgId = msg.message_id;
            } catch (e) {
                try {
                    const msg = await this.telegramBot.bot.sendMessage(this.telegramBot.chatId, display);
                    this.activeMsgId = msg.message_id;
                } catch (err2) {
                    console.error(`❌ [${this.name}] Lỗi sendMessage:`, err2.message);
                }
            }
        } else {
            try {
                await this.telegramBot.bot.editMessageText(markdownDisplay, {
                    chat_id: this.telegramBot.chatId,
                    message_id: this.activeMsgId,
                    parse_mode: 'MarkdownV2'
                });
            } catch (e) {
                if (!e.message.includes('not modified')) {
                    try {
                        const msg = await this.telegramBot.bot.sendMessage(this.telegramBot.chatId, markdownDisplay, { parse_mode: 'MarkdownV2' });
                        this.activeMsgId = msg.message_id;
                    } catch (err2) {
                        try {
                            const msg = await this.telegramBot.bot.sendMessage(this.telegramBot.chatId, display);
                            this.activeMsgId = msg.message_id;
                        } catch (err3) {
                            console.error(`❌ [${this.name}] Lỗi editMessage/fallback:`, err3.message);
                        }
                    }
                }
            }
        }
    }

    getInfo() {
        return {
            name: this.name,
            cwd: this.cwd,
            isRunning: this.isRunning(),
            createdAt: this.createdAt,
            uptime: this.isRunning() ? Date.now() - this.createdAt : null,
            claudeSessionId: this.claudeSessionId
        };
    }
}

module.exports = TerminalSession;
