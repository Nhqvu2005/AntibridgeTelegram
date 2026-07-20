/**
 * TerminalBridge — Quản lý nhiều terminal sessions.
 * Là session manager, delegate operations sang TerminalSession.
 */

const TerminalSession = require('./TerminalSession');
const ConversationAutoSave = require('./ConversationAutoSave');

class TerminalBridge {
    constructor(telegramBotService) {
        this.telegramBot = telegramBotService;
        this.sessions = new Map();       // name -> TerminalSession
        this.activeSessionId = null;
        this._nextId = 1;
        this._savedCwd = null;
        this._autoSaveWatchers = new Map(); // projectDir -> { count, watcher }
    }

    // ==========================================
    // Session Management
    // ==========================================

    /**
     * Tạo session mới
     */
    createSession(name, cwd) {
        // Auto-generate name nếu không có
        if (!name) {
            name = `t${this._nextId++}`;
        }

        // Nếu tên đã tồn tại, reject
        if (this.sessions.has(name)) {
            throw new Error(`Session "${name}" đã tồn tại`);
        }

        const actualCwd = cwd || this._savedCwd || this.telegramBot?.terminalProjectRoot || process.cwd();
        const session = new TerminalSession(this.telegramBot, name, actualCwd);
        session.start();
        this.sessions.set(name, session);
        this.activeSessionId = name;

        // Auto-start conversation saver cho project directory này
        this._ensureAutoSave(actualCwd);

        console.log(`✅ [TerminalBridge] Created session: ${name} (cwd: ${actualCwd})`);
        return session;
    }

    /**
     * Đảm bảo ConversationAutoSave đang chạy cho project directory
     */
    _ensureAutoSave(cwd) {
        try {
            const existing = this._autoSaveWatchers.get(cwd);
            if (existing) {
                existing.count++;
                return;
            }

            const watcher = new ConversationAutoSave(cwd);
            watcher.start();
            this._autoSaveWatchers.set(cwd, { count: 1, watcher });
            console.log(`💾 [TerminalBridge] AutoSave started for ${cwd}`);
        } catch (e) {
            console.log(`⚠️ [TerminalBridge] AutoSave error: ${e.message}`);
        }
    }

    /**
     * Giảm reference count cho auto-save watcher
     */
    _releaseAutoSave(cwd) {
        try {
            const existing = this._autoSaveWatchers.get(cwd);
            if (!existing) return;

            existing.count--;
            if (existing.count <= 0) {
                existing.watcher.stop();
                this._autoSaveWatchers.delete(cwd);
                console.log(`💾 [TerminalBridge] AutoSave stopped for ${cwd}`);
            }
        } catch (e) {
            console.log(`⚠️ [TerminalBridge] Release auto-save error: ${e.message}`);
        }
    }

    /**
     * Chuyển active session
     */
    switchSession(name) {
        if (!this.sessions.has(name)) {
            return null;
        }

        this.activeSessionId = name;
        const session = this.sessions.get(name);
        console.log(`🔄 [TerminalBridge] Switched to session: ${name}`);

        // Nếu session chưa chạy thì start
        if (!session.isRunning()) {
            session.start();
        }

        return session;
    }

    /**
     * Kill session cụ thể
     */
    async killSession(name, graceful = true) {
        const session = this.sessions.get(name);
        if (!session) return false;

        const cwd = session.cwd;

        if (graceful) {
            await session.stopGraceful(2000);
        } else {
            session.stop();
        }

        this.sessions.delete(name);

        // Release auto-save watcher cho project này
        this._releaseAutoSave(cwd);

        // Nếu là active session thì chuyển sang session khác
        if (this.activeSessionId === name) {
            this.activeSessionId = null;
            // Auto-select session khác nếu còn
            for (const [key] of this.sessions) {
                this.activeSessionId = key;
                break;
            }
        }

        console.log(`💀 [TerminalBridge] Killed session: ${name}`);
        return true;
    }

    /**
     * Kill toàn bộ sessions
     */
    async killAllSessions(graceful = true) {
        const sessions = Array.from(this.sessions.values());
        this.sessions.clear();
        this.activeSessionId = null;

        if (graceful) {
            // Graceful tất cả song song — mỗi session mất ~2s
            await Promise.all(sessions.map(s => s.stopGraceful(2000)));
        } else {
            sessions.forEach(s => s.stop());
        }

        // Dừng toàn bộ auto-save watchers
        for (const [dir, entry] of this._autoSaveWatchers) {
            entry.watcher.stop();
        }
        this._autoSaveWatchers.clear();

        console.log(`💀 [TerminalBridge] Killed all ${sessions.length} sessions`);
        return sessions.length;
    }

    /**
     * Restart active session (kill + tạo mới)
     */
    async restartActiveSession() {
        const session = this.getActiveSession();
        if (!session) return null;

        const name = session.name;
        const cwd = session.cwd;

        await this.killSession(name, true);
        return this.createSession(name, cwd);
    }

    /**
     * Lấy active session
     */
    getActiveSession() {
        if (!this.activeSessionId) return null;
        return this.sessions.get(this.activeSessionId) || null;
    }

    getActiveSessionName() {
        return this.activeSessionId;
    }

    getActiveSessionCwd() {
        const session = this.getActiveSession();
        return session ? session.cwd : (this._savedCwd || process.cwd());
    }

    /**
     * Danh sách sessions (dùng cho UI)
     */
    listSessions() {
        const result = [];
        for (const [name, session] of this.sessions) {
            const info = session.getInfo();
            info.isActive = (name === this.activeSessionId);
            result.push(info);
        }
        return result;
    }

    // ==========================================
    // Delegate to active session (backward compat)
    // ==========================================

    start(cwdPath) {
        if (cwdPath) { this._savedCwd = cwdPath; }

        // Nếu chưa có session nào, tạo session đầu tiên
        if (this.sessions.size === 0) {
            this.createSession(null, cwdPath);
        } else if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
            // Nếu đã có session và đang active, đảm bảo nó đang chạy
            const session = this.sessions.get(this.activeSessionId);
            if (!session.isRunning()) {
                session.start();
            }
        }
    }

    async stop() {
        await this.killAllSessions(true);
    }

    write(text) {
        const session = this.getActiveSession();
        if (!session) {
            this.telegramBot.sendMessage('⚠️ Không có session terminal nào đang active. Dùng `/mode terminal` hoặc `/term new` để tạo.');
            return;
        }
        session.write(text);
    }

    writeRaw(data) {
        const session = this.getActiveSession();
        if (!session) return;
        session.writeRaw(data);
    }

    sendCtrlC() {
        const session = this.getActiveSession();
        if (!session) return;
        session.sendCtrlC();
    }

    getDisplay() {
        const session = this.getActiveSession();
        if (!session) return '';
        return session.getDisplay();
    }
}

module.exports = TerminalBridge;
