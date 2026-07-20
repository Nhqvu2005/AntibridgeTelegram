/**
 * ConversationAutoSave — Tự động fsync file .jsonl của Claude Code liên tục
 *
 * Vấn đề: Khi chạy Claude Code trong terminal session, conversation được ghi
 * vào file .jsonl nhưng OS có thể buffer chưa flush xuống đĩa. Nếu máy sập
 * bất ngờ (mất điện, blue screen) thì mất conversation.
 *
 * Giải pháp Windows:
 * - fsync từ Node.js không hiệu quả cross-process trên Windows vì file lock
 * - Dùng PowerShell để mở file với FILE_SHARE_READ | FILE_SHARE_WRITE
 *   và gọi FlushFileBuffers API → force OS flush xuống ổ cứng
 *
 * Ngoài ra còn backup copy .jsonl → .jsonl.bak để dự phòng.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

class ConversationAutoSave {
    /**
     * @param {string} cwd - Thư mục làm việc nơi Claude Code chạy
     * @param {number} intervalMs - Chu kỳ fsync (mặc định 3s)
     */
    constructor(cwd, intervalMs = 3000) {
        this.cwd = cwd;
        this.intervalMs = intervalMs;
        this.projectSlug = ConversationAutoSave._getProjectSlug(cwd);
        this.projectDir = path.join(os.homedir(), '.claude', 'projects', this.projectSlug);
        this.interval = null;
        this._isRunning = false;
        this._lastFlush = {}; // filePath -> lastSize
        this._lastCleanup = Date.now();
    }

    /**
     * Convert đường dẫn Windows thành slug cho .claude/projects/
     * VD: E:\Job\DayroiDayroi → E--Job-DayroiDayroi
     */
    static _getProjectSlug(cwd) {
        return cwd.replace(/:/g, '-').replace(/[\\/]/g, '-');
    }

    /**
     * Khởi động auto-save
     */
    start() {
        if (this._isRunning) return;
        this._isRunning = true;

        console.log(`💾 [ConversationAutoSave] Theo dõi ${this.projectDir} (mỗi ${this.intervalMs}ms)`);

        this.interval = setInterval(() => {
            this._flushJsonlFiles().catch(() => {});
        }, this.intervalMs);

        // Flush ngay lập tức lần đầu
        setTimeout(() => this._flushJsonlFiles().catch(() => {}), 500);
    }

    /**
     * Dừng auto-save và đóng mọi file descriptors
     */
    stop() {
        this._isRunning = false;
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        // Final flush — đảm bảo mọi thứ được sync trước khi dừng
        this._flushJsonlFiles().catch(() => {});
        console.log('💾 [ConversationAutoSave] Stopped');
    }

    /**
     * Flush toàn bộ file .jsonl trong project folder xuống đĩa
     * Dùng PowerShell FlushFileBuffers trên Windows
     */
    async _flushJsonlFiles() {
        try {
            if (!fs.existsSync(this.projectDir)) return;

            const files = fs.readdirSync(this.projectDir);
            const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

            for (const file of jsonlFiles) {
                const filePath = path.join(this.projectDir, file);
                try {
                    const stat = fs.statSync(filePath);
                    if (!stat.isFile() || stat.size === 0) continue;

                    const prevSize = this._lastFlush[filePath] || 0;
                    if (stat.size === prevSize) continue; // không thay đổi → skip

                    this._lastFlush[filePath] = stat.size;

                    // === Flush file xuống đĩa — dùng PowerShell (Windows) ===
                    try {
                        // PowerShell: mở file với write sharing, gọi Flush($true)
                        // Dùng base64 encode để tránh issues với ký tự đặc biệt trong path
                        const pathB64 = Buffer.from(filePath, 'utf8').toString('base64');
                        const psScript = `
                            $path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathB64}'))
                            $f = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)
                            $f.Flush($true)
                            $f.Close()
                        `.trim().replace(/\n/g, '; ').replace(/\s+/g, ' ').trim();
                        await new Promise((resolve, reject) => {
                            exec(`powershell -NoProfile -NonInteractive -Command "${psScript}"`,
                                { timeout: 10000, windowsHide: true },
                                (err) => err ? reject(err) : resolve()
                            );
                        });
                    } catch (e) {
                        // PowerShell thất bại — thử Node.js fsync fallback
                        this._fallbackFsync(filePath);
                    }

                    // === Backup copy (phòng file gốc hỏng) ===
                    this._backupJsonl(filePath);

                } catch (_) {
                    // File không truy cập được
                }
            }

        } catch (_) {
            // Thư mục chưa tồn tại
        }
    }

    /**
     * Fallback: dùng Node.js fsync (kém hiệu quả trên Windows hơn PowerShell)
     */
    _fallbackFsync(filePath) {
        try {
            const fd = fs.openSync(filePath, 'r');
            try { fs.fsyncSync(fd); } catch (_) { }
            fs.closeSync(fd);
        } catch (_) { }
    }

    /**
     * Backup .jsonl → .jsonl.bak (chỉ khi file có thay đổi kích thước)
     * Giới hạn 10MB để tránh copy file quá lớn mỗi 3s
     */
    _backupJsonl(filePath) {
        try {
            const stat = fs.statSync(filePath);
            if (stat.size > 10 * 1024 * 1024) return; // >10MB thì skip backup

            const bakPath = filePath + '.bak';
            fs.copyFileSync(filePath, bakPath);
        } catch (_) { }
    }

    /**
     * Lấy thông tin trạng thái
     */
    getInfo() {
        return {
            projectDir: this.projectDir,
            isRunning: this._isRunning,
            flushedFiles: Object.keys(this._lastFlush).map(p => path.basename(p)),
            intervalMs: this.intervalMs
        };
    }
}

module.exports = ConversationAutoSave;
