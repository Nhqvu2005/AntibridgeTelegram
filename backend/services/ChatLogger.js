/**
 * ChatLogger - Service để lưu chat log ra file
 * Mỗi ngày 1 file log: logs/chat/chat_YYYY-MM-DD.log
 */

const fs = require('fs');
const path = require('path');

class ChatLogger {
    constructor() {
        this.logDir = path.join(__dirname, '..', 'logs', 'chat');
        this.ensureLogDir();
    }

    /**
     * Đảm bảo thư mục log tồn tại
     */
    ensureLogDir() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
            console.log(`📁 Tạo thư mục log: ${this.logDir}`);
        }
    }

    /**
     * Lấy tên file log cho ngày hiện tại
     */
    getLogFilename(date = new Date()) {
        const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
        return path.join(this.logDir, `chat_${dateStr}.log`);
    }

    /**
     * Ghi message vào log
     * @param {string} role - 'user' | 'assistant' | 'system'
     * @param {string} text - Nội dung message
     * @param {object} metadata - Metadata bổ sung (optional)
     */
    logMessage(role, text, metadata = {}) {
        // Mặc định: KHÔNG ghi log mỗi message.
        // Chỉ ghi khi role === 'error' / 'warn' HOẶC env CHAT_LOG_VERBOSE=1
        const verbose = process.env.CHAT_LOG_VERBOSE === '1' || process.env.CHAT_LOG_VERBOSE === 'true';
        if (role !== 'error' && role !== 'warn' && !verbose) return;

        const timestamp = new Date().toISOString();
        const filename = this.getLogFilename();

        // Format: [timestamp] [ROLE] message
        // Escape newlines để mỗi message nằm trên 1 dòng
        const escapedText = text.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        const line = `[${timestamp}] [${role.toUpperCase()}] ${escapedText}\n`;

        try {
            fs.appendFileSync(filename, line, 'utf8');
        } catch (err) {
            console.error('❌ Log error:', err.message);
        }
    }

    /**
     * Ghi log đầy đủ với JSON (cho debugging)
     */
    logMessageFull(role, text, metadata = {}) {
        // Mặc định: KHÔNG ghi. Chỉ bật khi verbose
        const verbose = process.env.CHAT_LOG_VERBOSE === '1' || process.env.CHAT_LOG_VERBOSE === 'true';
        if (!verbose) return;

        const timestamp = new Date().toISOString();
        const filename = this.getLogFilename().replace('.log', '_full.jsonl');

        const entry = {
            ts: timestamp,
            role: role,
            text: text,
            ...metadata
        };

        try {
            fs.appendFileSync(filename, JSON.stringify(entry) + '\n', 'utf8');
        } catch (err) {
            console.error('❌ Full log error:', err.message);
        }
    }

    /**
     * Lấy log history của ngày cụ thể
     * @param {string} dateStr - Format: YYYY-MM-DD (hoặc null cho ngày hiện tại)
     * @returns {Array} - Mảng các message
     */
    getLogHistory(dateStr = null) {
        const date = dateStr ? new Date(dateStr) : new Date();
        const filename = this.getLogFilename(date);

        if (!fs.existsSync(filename)) {
            return [];
        }

        try {
            const content = fs.readFileSync(filename, 'utf8');
            const lines = content.split('\n').filter(line => line.trim());

            return lines.map(line => {
                // Parse: [timestamp] [ROLE] message
                const match = line.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)$/);
                if (match) {
                    return {
                        timestamp: match[1],
                        role: match[2].toLowerCase(),
                        text: match[3].replace(/\\n/g, '\n').replace(/\\r/g, '\r')
                    };
                }
                return { raw: line };
            });
        } catch (err) {
            console.error('❌ Read log error:', err.message);
            return [];
        }
    }

    /**
     * Lấy danh sách các file log
     */
    getLogFiles() {
        if (!fs.existsSync(this.logDir)) {
            return [];
        }

        return fs.readdirSync(this.logDir)
            .filter(f => f.endsWith('.log') && !f.includes('_full'))
            .sort()
            .reverse(); // Newest first
    }

    /**
     * Lấy log JSONL đầy đủ
     */
    getFullLogHistory(dateStr = null) {
        const date = dateStr ? new Date(dateStr) : new Date();
        const filename = this.getLogFilename(date).replace('.log', '_full.jsonl');

        if (!fs.existsSync(filename)) {
            return [];
        }

        try {
            const content = fs.readFileSync(filename, 'utf8');
            return content.split('\n')
                .filter(line => line.trim())
                .map(line => JSON.parse(line));
        } catch (err) {
            console.error('❌ Read full log error:', err.message);
            return [];
        }
    }
}

module.exports = ChatLogger;
