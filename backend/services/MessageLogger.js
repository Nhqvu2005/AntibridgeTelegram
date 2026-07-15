/**
 * MessageLogger - Store chat history and debug logs.
 * History is stored as JSON Lines with a configurable max (default 50).
 */

const fs = require('fs');
const path = require('path');

class MessageLogger {
    constructor() {
        const projectRoot = path.join(__dirname, '..', '..');
        this.dataDir = path.join(projectRoot, 'Data');
        this.textDir = path.join(this.dataDir, 'Text');
        this.imageDir = path.join(this.dataDir, 'image');
        this.logDir = path.join(this.textDir, 'logs');
        this.maxMessages = 50;
        this.settingsFile = path.join(this.textDir, 'settings.json');

        this.ensureDir(this.dataDir);
        this.ensureDir(this.textDir);
        this.ensureDir(this.imageDir);
        this.ensureDir(this.logDir);

        this.loadSettings();

        this.historyFile = path.join(this.textDir, 'chat_history.jsonl');
        this.nextId = this.getNextId();
    }

    ensureDir(dir) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    getLogFilePath() {
        const today = new Date().toISOString().split('T')[0];
        return path.join(this.logDir, `messages_${today}.log`);
    }

    readHistoryEntries() {
        if (!fs.existsSync(this.historyFile)) return [];

        try {
            const data = fs.readFileSync(this.historyFile, 'utf8');
            const lines = data.split('\n').filter(line => line.trim());
            return lines.map(line => {
                try {
                    return JSON.parse(line);
                } catch (e) {
                    return null;
                }
            }).filter(item => item !== null);
        } catch (err) {
            console.error('Failed to read chat history:', err.message);
            return [];
        }
    }

    writeHistoryEntries(entries) {
        const trimmed = entries.slice(-this.maxMessages);
        const content = trimmed.map(entry => JSON.stringify(entry)).join('\n');
        try {
            fs.writeFileSync(this.historyFile, content + (content ? '\n' : ''), 'utf8');
        } catch (err) {
            console.error('Failed to save chat history:', err.message);
        }
    }

    getNextId() {
        const entries = this.readHistoryEntries();
        const lastId = entries.reduce((maxId, item) => {
            if (!item || typeof item.id !== 'number') return maxId;
            return Math.max(maxId, item.id);
        }, 0);
        return lastId + 1;
    }

    /**
     * Save history entry (JSONL) with a max of maxMessages entries.
     */
    saveHistory(role, text, html = null) {
        if (!text) return;

        // Không log debug khi lưu history (tiết kiệm I/O)
        // History vẫn được ghi vào JSONL như bình thường
        const entry = {
            id: this.nextId++,
            timestamp: new Date().toISOString(),
            role: role,
            text: text,
            html: html,
            format: html ? 'html' : 'text'
        };

        const entries = this.readHistoryEntries();
        entries.push(entry);
        this.writeHistoryEntries(entries);
    }

    getRecentHistory(limit = this.maxMessages) {
        const history = this.readHistoryEntries();
        return history.slice(-limit);
    }

    getMaxMessages() {
        return this.maxMessages;
    }

    loadSettings() {
        if (!fs.existsSync(this.settingsFile)) {
            return;
        }

        try {
            const data = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
            const parsed = Number.parseInt(data.max_messages, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                this.maxMessages = Math.max(1, Math.min(parsed, 500));
            }
        } catch (err) {
            console.error('Failed to load settings:', err.message);
        }
    }

    saveSettings() {
        const payload = { max_messages: this.maxMessages };
        try {
            fs.writeFileSync(this.settingsFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
        } catch (err) {
            console.error('Failed to save settings:', err.message);
        }
    }

    setMaxMessages(limit) {
        const parsed = Number.parseInt(limit, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return null;
        }

        const clamped = Math.max(1, Math.min(parsed, 500));
        this.maxMessages = clamped;
        this.writeHistoryEntries(this.readHistoryEntries());
        this.saveSettings();
        return clamped;
    }

    clearHistory() {
        try {
            if (fs.existsSync(this.historyFile)) {
                fs.unlinkSync(this.historyFile);
            }
            this.nextId = 1;
        } catch (err) {
            console.error('Failed to clear chat history:', err.message);
        }
    }

    // === DEBUG LOGGING ===

    /**
     * Ghi log vào file `Data/Text/logs/messages_YYYY-MM-DD.log` (chỉ khi lỗi / debug verbosity)
     * Mặc định: KHÔNG ghi log mỗi message (tiết kiệm disk + I/O).
     * Bật verbose bằng cách set env `MESSAGE_LOG_VERBOSE=1`.
     */
    logMessage(type, data, source = 'unknown') {
        // Chỉ ghi log khi:
        //   1. type bắt đầu bằng 'error' (lỗi runtime)
        //   2. hoặc MESSAGE_LOG_VERBOSE=1 (debug)
        const isError = typeof type === 'string' && type.toLowerCase().startsWith('error');
        const verbose = process.env.MESSAGE_LOG_VERBOSE === '1' || process.env.MESSAGE_LOG_VERBOSE === 'true';
        if (!isError && !verbose) return;

        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] [${type}] [${source}]\n${JSON.stringify(data, null, 2)}\n${'='.repeat(60)}\n\n`;

        try {
            fs.appendFileSync(this.getLogFilePath(), logLine, 'utf8');
        } catch (err) { /* ignore */ }
    }

    logStreaming(messages) {
        // Chat update liên tục → chỉ log khi verbose
        if (process.env.MESSAGE_LOG_VERBOSE === '1' || process.env.MESSAGE_LOG_VERBOSE === 'true') {
            this.logMessage('chat_update', { count: messages.length }, 'bridge');
        }
    }

    logComplete(message) {
        // Lưu history (đã được tối ưu) + chỉ log khi verbose
        this.saveHistory(message.role, message.text, message.html);
        if (process.env.MESSAGE_LOG_VERBOSE === '1' || process.env.MESSAGE_LOG_VERBOSE === 'true') {
            this.logMessage('chat_complete', message, 'bridge');
        }
    }
}

module.exports = new MessageLogger();
