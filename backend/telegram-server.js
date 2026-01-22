/**
 * AntiBridge Telegram Server
 * Server đơn giản - chỉ dùng Telegram Bot thay cho web frontend
 * Vẫn giữ WebSocket server nội bộ cho bridge scripts
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// Import services
const EventBus = require('./services/EventBus');
const AntigravityBridge = require('./services/AntigravityBridge');
const AcceptDetector = require('./services/accept-detector');
const messageLogger = require('./services/MessageLogger');
const TelegramBotService = require('./services/TelegramBot');

// ==========================================
// CONFIGURATION
// ==========================================

const WS_PORT = parseInt(process.env.WS_PORT) || 8000;
const CDP_PORT = parseInt(process.env.CDP_PORT) || 9000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Validate config
if (!BOT_TOKEN || BOT_TOKEN === 'your_bot_token_here') {
    console.error('❌ TELEGRAM_BOT_TOKEN chưa được cấu hình!');
    console.error('   Mở file .env và điền Bot Token từ @BotFather');
    process.exit(1);
}

if (!CHAT_ID || CHAT_ID === 'your_chat_id_here') {
    console.error('❌ TELEGRAM_CHAT_ID chưa được cấu hình!');
    console.error('   Mở file .env và điền Chat ID từ @userinfobot');
    process.exit(1);
}

// ==========================================
// INITIALIZE SERVICES
// ==========================================

console.log(`
╔════════════════════════════════════════════════════════════╗
║          AntiBridge - Telegram Mode                       ║
╠════════════════════════════════════════════════════════════╣
║  🤖 Bot Token: ${BOT_TOKEN.substring(0, 10)}...                            ║
║  💬 Chat ID:   ${CHAT_ID}                                   ║
║  🔌 CDP Port:  ${CDP_PORT}                                        ║
║  📡 WS Port:   ${WS_PORT}                                        ║
╚════════════════════════════════════════════════════════════╝
`);

// Create minimal HTTP + WebSocket server (for bridge scripts)
const server = http.createServer((req, res) => {
    // Health check
    if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: 'telegram', timestamp: new Date().toISOString() }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('AntiBridge Telegram Mode - Use Telegram Bot to interact');
});

const wss = new WebSocket.Server({ server });

// Initialize services
const eventBus = new EventBus(wss);
const antigravityBridge = new AntigravityBridge(eventBus);
const acceptDetector = new AcceptDetector(eventBus);

// Override CDP URL if custom port
if (CDP_PORT !== 9000) {
    antigravityBridge.debugUrl = `http://127.0.0.1:${CDP_PORT}`;
}

// Initialize Telegram Bot
const telegramBot = new TelegramBotService({
    botToken: BOT_TOKEN,
    chatId: CHAT_ID,
    antigravityBridge,
    acceptDetector,
    messageLogger,
    eventBus
});

// ==========================================
// WEBSOCKET HANDLERS (bridge scripts communication)
// ==========================================

// Track bridge WebSocket reference
let bridgeWs = null;

wss.on('connection', (ws, req) => {
    const urlPath = req.url || '';

    // ===== BRIDGE CONNECTION (chat_bridge_ws.js) =====
    if (urlPath === '/ws/bridge') {
        console.log('🌉 Bridge connected (chat_bridge_ws.js)');
        ws.isBridge = true;

        // Store bridge WS reference for inject_message
        bridgeWs = ws;

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                console.log(`🌉 Bridge msg: [${message.type}]`);

                if (message.type === 'bridge_register') {
                    console.log('✅ Bridge registered');
                    ws.send(JSON.stringify({ type: 'bridge_registered', status: 'ok' }));
                    return;
                }

                if (message.type === 'inject_result') {
                    console.log(`📝 Bridge inject result: success=${message.success}`);
                    return;
                }

                if (message.type === 'ai_messages' && message.messages) {
                    const streamingMsgs = message.messages.filter(m => m.isStreaming);
                    const completeMsgs = message.messages.filter(m => m.isComplete);

                    console.log(`📨 Bridge: streaming=${streamingMsgs.length}, complete=${completeMsgs.length}`);

                    // Forward streaming to Telegram Bot
                    if (streamingMsgs.length > 0) {
                        telegramBot.handleStreamingMessage(streamingMsgs);
                        messageLogger.logStreaming(streamingMsgs);
                    }

                    // Forward complete messages to Telegram Bot
                    completeMsgs.forEach(m => {
                        console.log(`🤖 AI complete msg: "${(m.text || '').substring(0, 80)}..."`);
                        telegramBot.handleCompleteMessage({
                            text: m.text,
                            html: m.html,
                            role: m.role || 'assistant'
                        });
                        messageLogger.logComplete(m);
                    });
                }
            } catch (err) {
                console.error('❌ Bridge message error:', err.message);
            }
        });

        ws.on('close', () => {
            console.log('👋 Bridge disconnected');
            if (bridgeWs === ws) bridgeWs = null;
        });
        return;
    }

    // ===== ACTION BRIDGE (detect_actions.js) =====
    if (urlPath === '/ws/action-bridge') {
        console.log('🎯 Action Bridge connected (detect_actions.js)');
        ws.isActionBridge = true;

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());

                if (message.type === 'action_detector_register') {
                    ws.send(JSON.stringify({ type: 'action_detector_registered', status: 'ok' }));
                    acceptDetector.setBridgeWs(ws);
                    console.log('✅ Action Bridge registered');
                    return;
                }

                // Forward to AcceptDetector
                acceptDetector.handleBridgeMessage(message);

                // Notify Telegram about pending actions
                if (message.type === 'actions_update' && message.actions?.length > 0) {
                    message.actions.forEach(action => {
                        telegramBot.handlePendingAction(action);
                    });
                }
            } catch (err) {
                console.error('❌ Action Bridge error:', err.message);
            }
        });

        ws.on('close', () => {
            console.log('👋 Action Bridge disconnected');
            acceptDetector.clearBridgeWs();
        });
        return;
    }

    // Ignore other connections
    console.log(`⚠️ Unknown WS connection: ${urlPath}`);
    ws.close(4000, 'Unknown endpoint');
});

// ==========================================
// STARTUP SEQUENCE
// ==========================================

async function startup() {
    console.log('\n[1/3] Đang kết nối CDP...');

    try {
        const connected = await antigravityBridge.connect();
        if (connected) {
            console.log('✅ CDP connected!');
        } else {
            console.log('⚠️ CDP chưa kết nối. Antigravity có đang chạy không?');
            console.log('   Chạy: Antigravity.exe --remote-debugging-port=9000');
        }
    } catch (e) {
        console.log(`⚠️ CDP connection error: ${e.message}`);
    }

    console.log('[2/3] Injecting scripts...');

    try {
        if (antigravityBridge.isConnected) {
            await antigravityBridge.injectChatBridge();
            console.log('✅ chat_bridge_ws.js injected');
        }
    } catch (e) {
        console.log(`⚠️ Injection error: ${e.message}`);
    }

    console.log('[3/3] Starting AcceptDetector...');

    try {
        const wsUrl = `ws://localhost:${WS_PORT}/ws/action-bridge`;
        await acceptDetector.start(wsUrl);
        console.log('✅ AcceptDetector started');
    } catch (e) {
        console.log(`⚠️ AcceptDetector error: ${e.message}`);
    }

    // Send startup notification to Telegram
    await telegramBot.sendMessage(
        `🟢 AntiBridge Online!\n\n` +
        `🔌 CDP: ${antigravityBridge.isConnected ? '✅ Connected' : '❌ Disconnected'}\n` +
        `📡 WS: Port ${WS_PORT}\n` +
        `🤖 Bot: ✅ Ready\n\n` +
        `Gửi tin nhắn bất kỳ để bắt đầu!`
    );

    console.log(`
╔════════════════════════════════════════════════════════════╗
║  ✅ AntiBridge Telegram Mode - READY!                      ║
╠════════════════════════════════════════════════════════════╣
║  🤖 Telegram Bot:  Online                                  ║
║  🔌 CDP:           ${antigravityBridge.isConnected ? 'Connected    ' : 'Disconnected '}                             ║
║  📡 WS Server:     localhost:${WS_PORT}                        ║
╚════════════════════════════════════════════════════════════╝

Gửi tin nhắn cho bot trên Telegram để điều khiển Antigravity!
Press Ctrl+C to stop...
`);
}

// ==========================================
// START SERVER
// ==========================================

server.listen(WS_PORT, '127.0.0.1', () => {
    console.log(`📡 WebSocket server listening on localhost:${WS_PORT}`);
    startup();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    telegramBot.stop();
    await acceptDetector.stop();
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

module.exports = { server, wss, telegramBot };
