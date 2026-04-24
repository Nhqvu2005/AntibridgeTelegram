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
        this.flushInterval = 2000; // Cập nhật màn hình 2s/lần
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
        
        // Cố tình xoá activeMsgId để lệnh chat mới luôn sinh ra một Bubble Terminal mới ở dưới cùng
        this.activeMsgId = null;

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
        // Không reset activeMsgId để tránh tạo tin nhắn mới liên tục khi bấm phím điều hướng tpad
        this.ptyProcess.write(data);
    }

    sendCtrlC() {
        if (!this.ptyProcess) return;
        this.ptyProcess.write('\x03');
        this.telegramBot.sendMessage('🛑 Đã gửi Ctrl+C tới Terminal.');
    }

    scheduleFlush() {
        this.needsFlush = true;
        // Chỉ chạy ngay nếu không bị khoá bởi API hoặc Cooldown
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
            // Sau khi xả API xong, thiết lập Cooldown cứng 1 giây để chống Telegram Rate Limit
            this.debounceTimeout = setTimeout(() => {
                this.debounceTimeout = null;
                this.isFlushing = false; // Mở khoá
                
                // Đủ 1 giây ngơi nghỉ, nếu còn hàng tồn đọng thì đẩy tiếp
                if (this.needsFlush) {
                    this.processFlushQueue();
                }
            }, this.flushInterval);
        }
    }

    getDisplay() {
        if (!this.term) return '';

        // Trích xuất buffer màn hình đã render hoàn chỉnh từ xterm-headless
        let lines = [];
        const buffer = this.term.buffer.active;
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (line) {
                lines.push(line.translateToString(true));
            }
        }

        // Tạo raw text và xoá các dòng trống thừa phía dưới cùng
        let display = lines.join('\n').replace(/\n+$/, '');
        display = display.replace(/[\u2500-\u257F\u25A0-\u25FF\u2600-\u26FF\u2800-\u28FF\u2190-\u21FF╭─╮│╰╯]/g, '');
        
        return display;
    }

    async flushOutput() {
        const display = this.getDisplay();
        if (!display || !display.trim()) return;

        // Giữ tối đa 3800 kí tự cuối (Telegram limit 4096)
        if (display.length > 3800) {
            display = display.substring(display.length - 3800);
        }

        // Với MarkdownV2 của Telegram, nếu ở bên trong thẻ code block (```), 
        // ta BẮT BUỘC phải escape tất cả các kí tự xuyệt chéo (\) và dấu tick ngược (`)
        // Nếu không escape, Telegram sẽ báo lỗi Parse và quăng qua Catch -> gửi thành dạng plain text xấu xí
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
                            console.error("❌ Lỗi editMessage/fallback:", err3.message);
                        }
                    }
                }
            }
        }
    }
}

module.exports = TerminalBridge;
