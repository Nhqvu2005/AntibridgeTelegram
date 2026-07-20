/**
 * TerminalSession — Quản lý 1 session terminal duy nhất.
 * Mỗi session có pty process, xterm headless, và state riêng.
 */

const { Terminal } = require('@xterm/headless');

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
            this.ptyProcess = nodePty.spawn(shell, [], {
                name: 'xterm-256color',
                cols: this.cols,
                rows: this.rows,
                cwd: this.cwd,
                env: process.env
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
    }

    /**
     * Graceful shutdown — gửi Ctrl+C và Ctrl+D để Claude Code save conversation
     * trước khi kill pty. Tránh mất conversation history khi bot restart/sập.
     * @param {number} timeoutMs - thời gian chờ Claude save (mặc định 3s)
     */
    async stopGraceful(timeoutMs = 3000) {
        if (!this.ptyProcess && !this.term) return;

        console.log(`🛑 [${this.name}] Graceful shutdown (timeout=${timeoutMs}ms)...`);
        this.isShuttingDown = true;

        if (this.ptyProcess) {
            try {
                // Step 1: Ctrl+C để ngắt mọi operation đang chạy
                console.log(`   [${this.name}] Sending Ctrl+C...`);
                this.ptyProcess.write('\x03');
                await new Promise(r => setTimeout(r, 500));

                // Step 2: Ctrl+D (EOF) để yêu cầu Claude Code graceful exit
                // Claude sẽ flush conversation ra .jsonl trước khi thoát
                console.log(`   [${this.name}] Sending Ctrl+D (EOF)...`);
                this.ptyProcess.write('\x04');

                // Chờ Claude save conversation
                console.log(`   [${this.name}] Waiting ${timeoutMs}ms for save...`);
                await new Promise(r => setTimeout(r, timeoutMs));

                // Step 3: Ctrl+C dự phòng nếu pty chưa exit
                if (this.ptyProcess) {
                    this.ptyProcess.write('\x03');
                    await new Promise(r => setTimeout(r, 200));
                }
            } catch (e) {
                // Nếu pty đã exit từ Ctrl+D thì bỏ qua lỗi
                if (e.message && !e.message.includes('Cannot read properties of null')) {
                    console.log(`⚠️ [${this.name}] Graceful shutdown error: ${e.message}`);
                }
            }
        }

        console.log(`   [${this.name}] Hard cleanup...`);
        this.stop();
    }

    isRunning() {
        return this.isActive && this.ptyProcess !== null;
    }

    write(text) {
        if (!this.ptyProcess) this.start();

        // Reset activeMsgId để lệnh chat mới luôn sinh ra bubble terminal mới
        this.activeMsgId = null;

        // Gửi text trước (giả lập thao tác paste)
        this.ptyProcess.write(text);

        // Gửi phím Enter (\r) cắm đuôi sau delay nhỏ
        setTimeout(() => {
            if (this.ptyProcess) this.ptyProcess.write('\r');
        }, 100);
    }

    writeRaw(data) {
        if (!this.ptyProcess) this.start();
        this.ptyProcess.write(data);
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
            uptime: this.isRunning() ? Date.now() - this.createdAt : null
        };
    }
}

module.exports = TerminalSession;
