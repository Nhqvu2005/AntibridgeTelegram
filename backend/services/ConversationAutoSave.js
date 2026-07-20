/**
 * ConversationAutoSave — Tự động fsync file .jsonl của Claude Code liên tục
 *
 * Vấn đề: Khi chạy Claude Code trong terminal session, conversation được ghi
 * vào file .jsonl nhưng OS có thể buffer chưa flush xuống đĩa. Nếu máy sập
 * bất ngờ (mất điện, blue screen) thì mất conversation.
 *
 * Giải pháp: Mở file .jsonl và gọi fsync() định kỳ để force OS flush
 * xuống ổ cứng, đảm bảo dữ liệu luôn được lưu real-time.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

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
        this._watchedFds = new Map(); // filePath -> { fd, mtime }
        this._lastCleanup = Date.now();
    }

    /**
     * Convert đường dẫn Windows thành slug cho .claude/projects/
     * VD: E:\Job\DayroiDayroi → E--Job-DayroiDayroi
     */
    static _getProjectSlug(cwd) {
        return cwd.replace(/:/g, '').replace(/[\\/]/g, '-');
    }

    /**
     * Khởi động auto-save
     */
    start() {
        if (this._isRunning) return;
        this._isRunning = true;

        console.log(`💾 [ConversationAutoSave] Theo dõi ${this.projectDir} (mỗi ${this.intervalMs}ms)`);

        this.interval = setInterval(() => {
            this._flushJsonlFiles();
        }, this.intervalMs);

        // Flush ngay lập tức lần đầu
        setTimeout(() => this._flushJsonlFiles(), 500);
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
        this._closeAllFds();
        console.log('💾 [ConversationAutoSave] Stopped');
    }

    _closeAllFds() {
        for (const [filePath, entry] of this._watchedFds) {
            try { fs.closeSync(entry.fd); } catch (_) { }
        }
        this._watchedFds.clear();
    }

    /**
     * Flush toàn bộ file .jsonl trong project folder xuống đĩa
     */
    _flushJsonlFiles() {
        try {
            if (!fs.existsSync(this.projectDir)) return;

            const files = fs.readdirSync(this.projectDir);
            const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

            for (const file of jsonlFiles) {
                const filePath = path.join(this.projectDir, file);
                try {
                    const stat = fs.statSync(filePath);
                    if (!stat.isFile()) continue;

                    const mtime = stat.mtimeMs;
                    const watched = this._watchedFds.get(filePath);

                    if (watched && watched.mtime === mtime) {
                        // File không thay đổi — skip
                        continue;
                    }

                    // File mới hoặc đã thay đổi → cần fsync
                    if (!watched) {
                        // File mới — mở fd
                        try {
                            const fd = fs.openSync(filePath, 'r+');
                            this._watchedFds.set(filePath, { fd, mtime });
                            fs.fsyncSync(fd);
                        } catch (e) {
                            // Có thể file đang bị process khác dùng exclusive lock
                            // Thử mở read-only và fsync (có thể không hiệu quả trên Windows)
                            try {
                                const fd = fs.openSync(filePath, 'r');
                                fs.fsyncSync(fd);
                                fs.closeSync(fd);
                            } catch (_) { }
                        }
                    } else {
                        // File đã thay đổi — fsync
                        try {
                            fs.fsyncSync(watched.fd);
                            watched.mtime = mtime;
                        } catch (e) {
                            // fd có thể bị invalid, xóa khỏi watch
                            try { fs.closeSync(watched.fd); } catch (_) { }
                            this._watchedFds.delete(filePath);
                        }
                    }
                } catch (e) {
                    // File có thể bị xóa hoặc không truy cập được
                    this._watchedFds.delete(filePath);
                }
            }

            // Dọn dẹp fd cho file không còn tồn tại
            this._cleanupStaleFds(jsonlFiles);

        } catch (e) {
            // Thư mục chưa tồn tại — ignore
        }
    }

    /**
     * Đóng fd của file đã bị xóa hoặc không còn trong danh sách
     */
    _cleanupStaleFds(currentFiles) {
        const currentSet = new Set(currentFiles.map(f => path.join(this.projectDir, f)));
        for (const [filePath, entry] of this._watchedFds) {
            if (!currentSet.has(filePath)) {
                try { fs.closeSync(entry.fd); } catch (_) { }
                this._watchedFds.delete(filePath);
            }
        }

        // Dọn dẹp period (tránh memory leak)
        if (Date.now() - this._lastCleanup > 60000) {
            this._lastCleanup = Date.now();
        }
    }

    /**
     * Lấy thông tin trạng thái
     */
    getInfo() {
        return {
            projectDir: this.projectDir,
            isRunning: this._isRunning,
            watchedFiles: Array.from(this._watchedFds.keys()).map(p => path.basename(p)),
            intervalMs: this.intervalMs
        };
    }
}

module.exports = ConversationAutoSave;
