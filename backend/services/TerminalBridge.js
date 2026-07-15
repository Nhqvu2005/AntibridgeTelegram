/**
 * TerminalBridge — Quản lý nhiều terminal sessions.
 * Là session manager, delegate operations sang TerminalSession.
 */

const TerminalSession = require('./TerminalSession');

class TerminalBridge {
    constructor(telegramBotService) {
        this.telegramBot = telegramBotService;
        this.sessions = new Map();       // name -> TerminalSession
        this.activeSessionId = null;
        this._nextId = 1;
        this._savedCwd = null;
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

        console.log(`✅ [TerminalBridge] Created session: ${name} (cwd: ${actualCwd})`);
        return session;
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
    killSession(name) {
        const session = this.sessions.get(name);
        if (!session) return false;

        session.stop();
        this.sessions.delete(name);

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
    killAllSessions() {
        const count = this.sessions.size;
        for (const [name] of this.sessions) {
            this.killSession(name);
        }
        console.log(`💀 [TerminalBridge] Killed all ${count} sessions`);
        return count;
    }

    /**
     * Restart active session (kill + tạo mới)
     */
    restartActiveSession() {
        const session = this.getActiveSession();
        if (!session) return null;

        const name = session.name;
        const cwd = session.cwd;

        this.killSession(name);
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

    stop() {
        this.killAllSessions();
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
