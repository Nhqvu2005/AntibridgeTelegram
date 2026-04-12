/**
 * EventBus - WebSocket Event Broadcasting Service
 * Manages real-time event delivery to connected clients
 */

class EventBus {
    constructor(wss) {
        this.wss = wss;
        // Map: sessionId -> Set<WebSocket>
        this.clients = new Map();
        // Map: type -> Set<callback> for internal (non-WS) listeners
        this.broadcastListeners = new Map();
    }

    /**
     * Add a client to a session
     */
    addClient(sessionId, ws) {
        if (!this.clients.has(sessionId)) {
            this.clients.set(sessionId, new Set());
        }
        this.clients.get(sessionId).add(ws);
    }

    /**
     * Remove a client from a session
     */
    removeClient(sessionId, ws) {
        const sessionClients = this.clients.get(sessionId);
        if (sessionClients) {
            sessionClients.delete(ws);
            if (sessionClients.size === 0) {
                this.clients.delete(sessionId);
            }
        }
    }

    /**
     * Emit an event to all clients in a session
     * @param {string} sessionId - Target session
     * @param {string} type - Event type (terminal, log, plan, chat_token, diff_update, approval_request, status, error)
     * @param {object} data - Event data
     */
    emit(sessionId, type, data) {
        const event = {
            type,
            data,
            ts: new Date().toISOString()
        };

        const sessionClients = this.clients.get(sessionId);
        if (!sessionClients || sessionClients.size === 0) {
            console.log(`⚠️ EventBus: No clients for session ${sessionId}`);
            return;
        }

        const message = JSON.stringify(event);
        let sentCount = 0;

        sessionClients.forEach((ws) => {
            if (ws.readyState === 1) { // WebSocket.OPEN
                ws.send(message);
                sentCount++;
            }
        });

        console.log(`📤 EventBus: [${type}] sent to ${sentCount} client(s) in session ${sessionId}`);
    }

    /**
     * Broadcast to all sessions
     */
    broadcast(type, data) {
        // Send to WebSocket clients
        this.clients.forEach((_, sessionId) => {
            this.emit(sessionId, type, data);
        });
        // Call internal listeners (e.g. Telegram bot)
        const listeners = this.broadcastListeners.get(type);
        if (listeners) {
            listeners.forEach(cb => {
                try { cb(data); } catch (e) { console.error(`EventBus listener error [${type}]:`, e.message); }
            });
        }
    }

    /**
     * Register an internal listener for broadcast events
     * @param {string} type - Event type to listen for
     * @param {function} callback - Callback receiving (data)
     */
    onBroadcast(type, callback) {
        if (!this.broadcastListeners.has(type)) {
            this.broadcastListeners.set(type, new Set());
        }
        this.broadcastListeners.get(type).add(callback);
    }

    /**
     * Get connected client count for a session
     */
    getClientCount(sessionId) {
        return this.clients.get(sessionId)?.size || 0;
    }

    /**
     * Get all active session IDs
     */
    getActiveSessions() {
        return Array.from(this.clients.keys());
    }
}

module.exports = EventBus;
