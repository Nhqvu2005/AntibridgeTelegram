const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

class TerminalBridge {
    constructor(telegramBotService) {
        this.telegramBot = telegramBotService;
        this.ptyProcess = null;
        this.term = null;
        this.debounceTimeout = null;
        this.activeMsgId = null;
        this.isActive = false;
        this.flushInterval = 1000; // Cập nhật màn hình 1s/lần
        this.cols = 80;
        this.rows = 150; // Cho Terminal dài ra để chứa nội dung
    }

    start(cwdPath) {
        if (this.ptyProcess) return;

        if (cwdPath) { this._savedCwd = cwdPath; }
        const actualCwd = cwdPath || this._savedCwd || (this.telegramBot && this.telegramBot.terminalProjectRoot) || process.cwd();

        console.log(`🖥️ Khởi động Terminal Mode tại ${actualCwd}...`);
        const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';

        // Khởi tạo xterm headless engine giả lập môi trường terminal
        this.term = new Terminal({
            cols: this.cols,
            rows: this.rows,
            allowProposedApi: true
        });

        // node-pty process (không cần NO_COLOR để dùng full tính năng Claude)
        this.ptyProcess = pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols: this.cols,
            rows: this.rows,
            cwd: actualCwd,
            env: process.env // Cứ xài full VT100
        });

        this.ptyProcess.onData((data) => {
            // Nạp data (nhấn phím, vẽ box, đưa con trỏ) vào xterm engine
            if (this.term) {
                this.term.write(data, () => {
                    this.scheduleFlush();
                });
            }
        });

        this.ptyProcess.onExit((e) => {
            if (this.term) {
                this.term.write(`\n\n[Terminal Exited with code ${e.exitCode}]\n`);
                this.scheduleFlush();
            }
            this.ptyProcess = null;
        });

        this.isActive = true;
    }

    stop() {
        if (this.ptyProcess) {
            this.ptyProcess.kill();
            this.ptyProcess = null;
        }
        if (this.term) {
            this.term.dispose();
            this.term = null;
        }
        this.isActive = false;
    }

    write(text) {
        if (!this.ptyProcess) this.start();

        // Gửi text trước (giả lập thao tác paste)
        this.ptyProcess.write(text);
        
        // Gửi phím Enter (\r) cắm đuôi sau một khoảng delay nhỏ
        // Việc này giúp các TUI xịn (như Claude Code / Inquirer) không hiểu lầm \r là một phần của chuỗi paste
        setTimeout(() => {
            if (this.ptyProcess) this.ptyProcess.write('\r');
        }, 100);
    }

    writeRaw(data) {
        if (!this.ptyProcess) this.start();
        // Không reset activeMsgId để tránh tạo tin nhắn mới liên tục khi bấm phím điều hướng
        this.ptyProcess.write(data);
    }

    sendCtrlC() {
        if (!this.ptyProcess) return;
        this.ptyProcess.write('\x03');
        this.telegramBot.sendMessage('🛑 Đã gửi Ctrl+C tới Terminal.');
    }

    scheduleFlush() {
        if (this.debounceTimeout) {
            clearTimeout(this.debounceTimeout);
        }
        this.debounceTimeout = setTimeout(() => {
            this.flushOutput();
        }, this.flushInterval);
    }

    async flushOutput() {
        if (!this.term) return;

        // Trích xuất buffer màn hình đã render hoàn chỉnh từ xterm-headless
        let lines = [];
        const buffer = this.term.buffer.active;
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (line) {
                // Lấy nội dung hiển thị text trên dòng đó, translateToString(true) cắt bỏ space thừa bên phải
                lines.push(line.translateToString(true));
            }
        }

        // Tạo raw text và xoá các dòng trống thừa phía dưới cùng màn hình
        let display = lines.join('\n').replace(/\n+$/, '');
        
        // Cân nhắc xoá ký tự unicode GUI box nếu Telegram font bị lỗi lệch (tuỳ chọn)
        display = display.replace(/[\u2500-\u257F\u25A0-\u25FF\u2600-\u26FF\u2800-\u28FF\u2190-\u21FF╭─╮│╰╯]/g, '');

        if (!display.trim()) return;

        // Giữ tối đa 3800 kí tự cuối (trong hạn mức 4096 của Telegram)
        if (display.length > 3800) {
            display = display.substring(display.length - 3800);
        }

        const markdownDisplay = `\`\`\`\n${display}\n\`\`\``;

        if (!this.activeMsgId) {
            try {
                const msg = await this.telegramBot.bot.sendMessage(this.telegramBot.chatId, markdownDisplay, { parse_mode: 'MarkdownV2' });
                this.activeMsgId = msg.message_id;
            } catch (e) {
                try {
                    const msg = await this.telegramBot.bot.sendMessage(this.telegramBot.chatId, display);
                    this.activeMsgId = msg.message_id;
                } catch(err2) {
                    console.error("❌ Lỗi sendMessage (mã gốc):", err2.message);
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
                    } catch(err2) {
                        try {
                            const msg = await this.telegramBot.bot.sendMessage(this.telegramBot.chatId, display);
                            this.activeMsgId = msg.message_id;
                        } catch(err3) {
                            console.error("❌ Lỗi editMessage/fallback sendMessage do Rate Limit hoặc Network:", err3.message);
                        }
                    }
                }
            }
        }
    }
}

module.exports = TerminalBridge;
