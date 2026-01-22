/**
 * TelegramBot Service
 * Giao tiếp giữa Telegram và Antigravity AI
 * Thay thế web frontend bằng Telegram Bot
 */

const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

class TelegramBotService {
    constructor({ botToken, chatId, antigravityBridge, acceptDetector, messageLogger, eventBus }) {
        this.botToken = botToken;
        this.chatId = String(chatId);
        this.antigravityBridge = antigravityBridge;
        this.acceptDetector = acceptDetector;
        this.messageLogger = messageLogger;
        this.eventBus = eventBus;

        // Telegram message limit
        this.MAX_MSG_LENGTH = 4096;

        // Track streaming state
        this.lastStreamingMsg = null;
        this.streamingTimeout = null;
        this.lastSentText = '';
        this.isProcessing = false;

        // Load available models from env
        this.availableModels = (process.env.AVAILABLE_MODELS || '')
            .split(',')
            .map(m => m.trim())
            .filter(m => m.length > 0);

        // Initialize bot
        this.bot = new TelegramBot(this.botToken, { polling: true });

        this._setupCommands();
        this._setupMessageHandler();
        this._setupCallbackHandler();

        console.log('🤖 Telegram Bot initialized');
    }

    // ==========================================
    // COMMANDS
    // ==========================================

    _setupCommands() {
        // Set bot commands menu
        this.bot.setMyCommands([
            { command: 'start', description: '👋 Giới thiệu bot' },
            { command: 'status', description: '📊 Kiểm tra kết nối' },
            { command: 'accept', description: '✅ Accept action hiện tại' },
            { command: 'reject', description: '❌ Reject action hiện tại' },
            { command: 'stop', description: '⏹️ Stop AI generation' },
            { command: 'model', description: '🎨 Đổi model AI' },
            { command: 'screenshot', description: '📸 Chụp màn hình' },
            { command: 'reconnect', description: '🔄 Reconnect CDP' },
            { command: 'clear', description: '🗑️ Xóa chat history' },
            { command: 'quota', description: '📊 Xem quota Antigravity' },
        ]);

        this.bot.onText(/\/start/, (msg) => this._handleStart(msg));
        this.bot.onText(/\/status/, (msg) => this._handleStatus(msg));
        this.bot.onText(/\/accept/, (msg) => this._handleAccept(msg));
        this.bot.onText(/\/reject/, (msg) => this._handleReject(msg));
        this.bot.onText(/\/stop/, (msg) => this._handleStop(msg));
        this.bot.onText(/\/model(.*)/, (msg, match) => this._handleModel(msg, match));
        this.bot.onText(/\/screenshot/, (msg) => this._handleScreenshot(msg));
        this.bot.onText(/\/reconnect/, (msg) => this._handleReconnect(msg));
        this.bot.onText(/\/clear/, (msg) => this._handleClear(msg));
        this.bot.onText(/\/quota/, (msg) => this._handleQuota(msg));
    }

    _isAuthorized(msg) {
        return String(msg.chat.id) === this.chatId;
    }

    async _handleStart(msg) {
        if (!this._isAuthorized(msg)) return;

        await this.sendMessage(
            `🌉 *AntiBridge Telegram*\n\n` +
            `Điều khiển Antigravity AI qua Telegram.\n\n` +
            `📝 Gửi tin nhắn bất kỳ → AI xử lý\n` +
            `✅ /accept - Accept action\n` +
            `❌ /reject - Reject action\n` +
            `⏹️ /stop - Stop generation\n` +
            `🎨 /model <name> - Đổi model\n` +
            `📸 /screenshot - Chụp màn hình\n` +
            `📊 /status - Kiểm tra kết nối`,
            { parse_mode: 'Markdown' }
        );
    }

    async _handleStatus(msg) {
        if (!this._isAuthorized(msg)) return;

        const cdpConnected = this.antigravityBridge?.isConnected || false;
        let stateInfo = '';

        if (cdpConnected) {
            try {
                const state = await this.antigravityBridge.getCurrentState();
                if (state?.success) {
                    stateInfo = `\n🎨 Model: ${state.model || 'N/A'}`;
                    if (state.pendingActions > 0) {
                        stateInfo += `\n🎯 Pending actions: ${state.pendingActions}`;
                    }
                    if (state.isStreaming) {
                        stateInfo += `\n⏳ AI đang trả lời...`;
                    }
                }
            } catch (e) { /* ignore */ }
        }

        const detectorStats = this.acceptDetector?.getStats?.() || {};

        await this.sendMessage(
            `📊 *Trạng thái hệ thống*\n\n` +
            `🔌 CDP: ${cdpConnected ? '✅ Connected' : '❌ Disconnected'}\n` +
            `🤖 Bot: ✅ Online${stateInfo}\n` +
            `🎯 Detector: ${detectorStats.running ? '✅ Running' : '⏹️ Stopped'}`,
            { parse_mode: 'Markdown' }
        );
    }

    async _handleAccept(msg) {
        if (!this._isAuthorized(msg)) return;

        try {
            await this.sendMessage('✅ Đang Accept...');
            const result = await this.antigravityBridge.acceptByClick();
            if (result?.success) {
                await this.sendMessage('✅ Accepted!');
            } else {
                // Fallback to shortcut
                const shortcutResult = await this.antigravityBridge.sendAcceptShortcut();
                await this.sendMessage(shortcutResult?.success ? '✅ Accepted (shortcut)!' : '❌ Accept failed');
            }
        } catch (e) {
            await this.sendMessage(`❌ Accept error: ${e.message}`);
        }
    }

    async _handleReject(msg) {
        if (!this._isAuthorized(msg)) return;

        try {
            await this.sendMessage('❌ Đang Reject...');
            const result = await this.antigravityBridge.rejectByClick();
            if (result?.success) {
                await this.sendMessage('❌ Rejected!');
            } else {
                const shortcutResult = await this.antigravityBridge.sendRejectShortcut();
                await this.sendMessage(shortcutResult?.success ? '❌ Rejected (shortcut)!' : '❌ Reject failed');
            }
        } catch (e) {
            await this.sendMessage(`❌ Reject error: ${e.message}`);
        }
    }

    async _handleStop(msg) {
        if (!this._isAuthorized(msg)) return;

        try {
            await this.sendMessage('⏹️ Đang Stop...');
            const result = await this.antigravityBridge.stopGeneration();
            await this.sendMessage(result?.success ? '⏹️ Stopped!' : '❌ Stop failed');
        } catch (e) {
            await this.sendMessage(`❌ Stop error: ${e.message}`);
        }
    }

    async _handleModel(msg, match) {
        if (!this._isAuthorized(msg)) return;

        const modelName = (match[1] || '').trim();

        // If user typed a model name directly
        if (modelName) {
            return this._switchModel(modelName);
        }

        // Show inline buttons for model selection
        if (this.availableModels.length === 0) {
            await this.sendMessage('⚠️ Chưa cấu hình AVAILABLE_MODELS trong .env');
            return;
        }

        // Build keyboard: 2 buttons per row
        const keyboard = [];
        for (let i = 0; i < this.availableModels.length; i += 2) {
            const row = [{ text: this.availableModels[i], callback_data: `model_${i}` }];
            if (i + 1 < this.availableModels.length) {
                row.push({ text: this.availableModels[i + 1], callback_data: `model_${i + 1}` });
            }
            keyboard.push(row);
        }

        await this.sendMessage('🎨 Chọn model AI:', {
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    async _switchModel(modelName) {
        try {
            await this.sendMessage(`🎨 Đang đổi sang: ${modelName}...`);
            const result = await this.antigravityBridge.changeModel(modelName);
            if (result?.success) {
                await this.sendMessage(`✅ Đã đổi model: ${result.model || modelName}`);
            } else {
                await this.sendMessage(`❌ Không tìm thấy model: ${modelName}`);
            }
        } catch (e) {
            await this.sendMessage(`❌ Lỗi đổi model: ${e.message}`);
        }
    }

    async _handleScreenshot(msg) {
        if (!this._isAuthorized(msg)) return;

        try {
            await this.sendMessage('📸 Đang chụp...');

            if (!this.antigravityBridge?.page) {
                await this.sendMessage('❌ CDP chưa kết nối');
                return;
            }

            const screenshot = await this.antigravityBridge.page.screenshot({
                type: 'png',
                fullPage: false
            });

            await this.bot.sendPhoto(this.chatId, screenshot, {
                caption: `📸 Screenshot ${new Date().toLocaleTimeString('vi-VN')}`
            });
        } catch (e) {
            await this.sendMessage(`❌ Screenshot error: ${e.message}`);
        }
    }

    async _handleReconnect(msg) {
        if (!this._isAuthorized(msg)) return;

        try {
            await this.sendMessage('🔄 Đang reconnect CDP...');

            // Force disconnect first
            this.antigravityBridge.isConnected = false;
            this.antigravityBridge.browser = null;
            this.antigravityBridge.page = null;

            const connected = await this.antigravityBridge.connect();
            if (connected) {
                await this.sendMessage('✅ CDP reconnected!');
            } else {
                await this.sendMessage('❌ CDP reconnect failed. Antigravity có đang chạy với --remote-debugging-port=9000 không?');
            }
        } catch (e) {
            await this.sendMessage(`❌ Reconnect error: ${e.message}`);
        }
    }

    async _handleClear(msg) {
        if (!this._isAuthorized(msg)) return;

        try {
            this.messageLogger?.clearHistory?.();
            this.lastSentText = '';
            await this.sendMessage('🗑️ Đã xóa chat history');
        } catch (e) {
            await this.sendMessage(`❌ Clear error: ${e.message}`);
        }
    }

    async _handleQuota(msg) {
        if (!this._isAuthorized(msg)) return;

        try {
            if (!this.antigravityBridge?.isConnected) {
                await this.sendMessage('❌ Chưa kết nối Antigravity. Dùng /reconnect');
                return;
            }

            const quota = await this.antigravityBridge.getQuota();
            if (!quota) {
                await this.sendMessage('❌ Không đọc được quota. Kiểm tra Antigravity đang chạy?');
                return;
            }

            await this.sendMessage(`📊 Antigravity Quota\n\n${quota}`);
        } catch (e) {
            await this.sendMessage(`❌ Quota error: ${e.message}`);
        }
    }

    // ==========================================
    // MESSAGE HANDLER (gửi tin nhắn đến Antigravity)
    // ==========================================

    _setupMessageHandler() {
        this.bot.on('message', async (msg) => {
            // Skip commands
            if (msg.text?.startsWith('/')) return;
            if (!this._isAuthorized(msg)) return;
            if (!msg.text) return;

            const text = msg.text.trim();
            if (!text) return;

            console.log(`📱 Telegram: "${text.substring(0, 50)}..."`);

            // Reset active response message for new turn
            this._resetActiveResponse();

            // Save to history
            this.messageLogger?.saveHistory?.('user', text, null);

            // Send status
            await this.sendMessage('🚀 Đang gửi cho Antigravity...');

            // Grab baseline text BEFORE sending (to detect new response)
            let baselineText = '';
            try {
                baselineText = await this.antigravityBridge.getLastAIResponse() || '';
            } catch (e) { /* ignore */ }

            try {
                // ===== TRY 1: CDP injection =====
                let sent = false;

                if (this.antigravityBridge.isConnected) {
                    try {
                        const result = await this.antigravityBridge.injectTextToChat(text);
                        if (result && result.success) {
                            sent = true;
                            console.log('✅ Sent via CDP');
                        }
                    } catch (e) {
                        console.log(`⚠️ CDP inject failed: ${e.message}`);
                    }
                }

                // ===== TRY 2: PowerShell clipboard (same as web default) =====
                // WARNING: This steals window focus (SetForegroundWindow)
                if (!sent) {
                    console.log('📋 Falling back to PowerShell clipboard (⚠️ will steal window focus)...');
                    try {
                        await this._sendViaClipboard(text);
                        sent = true;
                        console.log('✅ Sent via PowerShell clipboard');
                    } catch (e) {
                        console.error('❌ Clipboard fallback failed:', e.message);
                    }
                }

                if (sent) {
                    await this.sendMessage('✅ Đã gửi! Đang đợi AI trả lời...');
                    // Start CDP response polling as fallback
                    this._pollForResponse(baselineText);
                } else {
                    await this.sendMessage('❌ Không thể gửi tin nhắn. Kiểm tra Antigravity đang chạy?');
                }
            } catch (e) {
                console.error('❌ Send to Antigravity error:', e.message);
                await this.sendMessage(`❌ Lỗi: ${e.message}`);
            }
        });
    }

    /**
     * Poll CDP for AI response with smart backoff
     * Phase 1: Fast polling (3s) for first 2 min — catches quick responses
     * Phase 2: Slow polling (10s) from 2-15 min — handles long tasks
     * Total max: ~15 min wait time
     */
    async _pollForResponse(baselineText) {
        const FAST_INTERVAL = 3000;   // 3s
        const SLOW_INTERVAL = 10000;  // 10s
        const FAST_PHASE_MS = 120000; // 2 min fast polling
        const MAX_TOTAL_MS = 900000;  // 15 min total
        const STABLE_COUNT = 2;       // 2 consecutive same-text = complete

        let pollCount = 0;
        let lastPollText = '';
        let stableCount = 0;
        let responseSentViaPolling = false;
        const startTime = Date.now();

        console.log('🔄 Starting CDP response polling (fast 2min → slow 15min)...');

        const doPoll = async () => {
            if (responseSentViaPolling) return;

            const elapsed = Date.now() - startTime;
            pollCount++;

            // Stop if bridge already delivered the response
            if (this.lastSentText && this.lastSentText !== baselineText && pollCount > 3) {
                console.log('✅ Response already delivered via bridge, stopping poll');
                return;
            }

            if (elapsed > MAX_TOTAL_MS) {
                console.log('⏰ CDP polling timed out (15min)');
                return;
            }

            try {
                const currentText = await this.antigravityBridge.getLastAIResponse();
                if (!currentText) {
                    if (pollCount <= 5) console.log(`🔄 Poll ${pollCount}: no AI text found`);
                } else if (currentText === baselineText) {
                    if (pollCount <= 5) console.log(`🔄 Poll ${pollCount}: same as baseline (${currentText.length} chars)`);
                } else if (currentText === lastPollText) {
                    // Same as last poll = text is stabilizing
                    stableCount++;
                    console.log(`🔄 Poll ${pollCount}: text stable (${stableCount}/${STABLE_COUNT})`);

                    if (stableCount >= STABLE_COUNT && !responseSentViaPolling) {
                        responseSentViaPolling = true;

                        // Check if bridge already sent this
                        if (this.lastSentText === currentText) {
                            console.log('✅ Response already sent via bridge');
                            return;
                        }

                        console.log(`🤖 CDP Poll: AI response detected (${currentText.length} chars)`);
                        this.lastSentText = currentText;
                        await this._sendOrEditResponse(`🤖 AI:\n\n${currentText}`);
                        this.messageLogger?.saveHistory?.('assistant', currentText, null);
                        return;
                    }
                } else {
                    // New text detected — reset stability counter
                    stableCount = 0;
                    lastPollText = currentText;
                    if (pollCount <= 10 || pollCount % 5 === 0) {
                        console.log(`🔄 Poll ${pollCount}: new text (${currentText.length} chars): "${currentText.substring(0, 60)}..."`);
                    }
                }
            } catch (e) {
                // Ignore polling errors
            }

            // Schedule next poll with smart interval
            const nextInterval = elapsed < FAST_PHASE_MS ? FAST_INTERVAL : SLOW_INTERVAL;
            setTimeout(doPoll, nextInterval);
        };

        // Start first poll
        setTimeout(doPoll, FAST_INTERVAL);
    }

    /**
     * Gửi tin nhắn qua PowerShell clipboard
     * Copy text → focus Antigravity → Ctrl+V → Enter
     * (Giống cách web client gửi mặc định)
     */
    _sendViaClipboard(text) {
        return new Promise((resolve, reject) => {
            // Copy to clipboard
            const copyProcess = exec('clip', (err) => {
                if (err) console.error('Clipboard error:', err.message);
            });
            copyProcess.stdin.write(text);
            copyProcess.stdin.end();

            // PowerShell: focus Antigravity → paste → enter
            const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*Antigravity*' -and $_.MainWindowTitle -notlike '*Manager*' } | Select-Object -First 1

if ($proc) {
    [Win32]::ShowWindow($proc.MainWindowHandle, 9)
    [Win32]::SetForegroundWindow($proc.MainWindowHandle)
    Start-Sleep -Milliseconds 500
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Write-Host "OK"
} else {
    Write-Host "Antigravity not found"
}
`;

            const psPath = path.join(__dirname, '..', 'temp_tg_paste.ps1');
            fs.writeFileSync(psPath, psScript, 'utf8');

            exec(`powershell -ExecutionPolicy Bypass -File "${psPath}"`, { timeout: 15000 }, (err, stdout) => {
                try { fs.unlinkSync(psPath); } catch (e) { }

                if (err) {
                    reject(new Error(`PowerShell error: ${err.message}`));
                    return;
                }

                const output = (stdout || '').trim();
                if (output.includes('OK')) {
                    resolve(true);
                } else if (output.includes('not found')) {
                    reject(new Error('Antigravity window not found'));
                } else {
                    reject(new Error(`PowerShell output: ${output}`));
                }
            });
        });
    }

    // ==========================================
    // CALLBACK HANDLER (Inline buttons)
    // ==========================================

    _setupCallbackHandler() {
        this.bot.on('callback_query', async (query) => {
            const chatId = String(query.message.chat.id);
            if (chatId !== this.chatId) return;

            const action = query.data;
            console.log(`🎯 Callback: ${action}`);

            try {
                if (action === 'accept_action') {
                    const result = await this.antigravityBridge.acceptByClick();
                    if (!result?.success) {
                        await this.antigravityBridge.sendAcceptShortcut();
                    }
                    await this.bot.answerCallbackQuery(query.id, { text: '✅ Accepted!' });
                    await this.bot.editMessageReplyMarkup(
                        { inline_keyboard: [[{ text: '✅ Đã Accept', callback_data: 'done' }]] },
                        { chat_id: this.chatId, message_id: query.message.message_id }
                    );
                } else if (action === 'reject_action') {
                    const result = await this.antigravityBridge.rejectByClick();
                    if (!result?.success) {
                        await this.antigravityBridge.sendRejectShortcut();
                    }
                    await this.bot.answerCallbackQuery(query.id, { text: '❌ Rejected!' });
                    await this.bot.editMessageReplyMarkup(
                        { inline_keyboard: [[{ text: '❌ Đã Reject', callback_data: 'done' }]] },
                        { chat_id: this.chatId, message_id: query.message.message_id }
                    );
                } else if (action === 'stop_generation') {
                    await this.antigravityBridge.stopGeneration();
                    await this.bot.answerCallbackQuery(query.id, { text: '⏹️ Stopped!' });
                } else if (action.startsWith('model_')) {
                    // Model selection from inline buttons
                    const idx = parseInt(action.replace('model_', ''));
                    const modelName = this.availableModels[idx];
                    if (modelName) {
                        await this.bot.answerCallbackQuery(query.id, { text: `🎨 Đổi sang ${modelName}...` });
                        // Update button to show selected
                        await this.bot.editMessageText(`🎨 Đã chọn: ${modelName}`, {
                            chat_id: this.chatId,
                            message_id: query.message.message_id
                        });
                        await this._switchModel(modelName);
                    } else {
                        await this.bot.answerCallbackQuery(query.id, { text: '❌ Model không hợp lệ' });
                    }
                } else {
                    await this.bot.answerCallbackQuery(query.id);
                }
            } catch (e) {
                console.error('❌ Callback error:', e.message);
                await this.bot.answerCallbackQuery(query.id, { text: `❌ Error: ${e.message}` });
            }
        });
    }

    // ==========================================
    // RECEIVE AI RESPONSE (from bridge WebSocket)
    // ==========================================

    /**
     * Reset active response message — call when user sends new message
     */
    _resetActiveResponse() {
        this._activeResponseMsgId = null;
        this._lastEditedText = null;
        this._lastEditTime = null;
        this._sendLock = Promise.resolve(); // reset lock chain
        this.lastSentText = null;
        if (this.streamingTimeout) {
            clearTimeout(this.streamingTimeout);
            this.streamingTimeout = null;
        }
        this.lastStreamingMsg = null;
    }

    /**
     * Send or edit the ONE active response message (with async lock)
     * Uses a promise chain to prevent race conditions where multiple
     * concurrent calls create duplicate messages
     */
    async _sendOrEditResponse(text) {
        if (!text) return;

        // Chain onto the lock — only one call executes at a time
        this._sendLock = (this._sendLock || Promise.resolve()).then(async () => {
            // Truncate for Telegram 4096 limit
            const displayText = text.length > 4000 ? text.substring(text.length - 4000) : text;

            // Skip if identical to last edit
            if (displayText === this._lastEditedText) return;

            // Throttle edits: max 1 per 2s (only for edits, not first send)
            const now = Date.now();
            if (this._activeResponseMsgId && this._lastEditTime && now - this._lastEditTime < 2000) return;

            try {
                if (!this._activeResponseMsgId) {
                    // FIRST: send new message
                    const sent = await this.bot.sendMessage(this.chatId, displayText);
                    this._activeResponseMsgId = sent.message_id;
                    console.log(`📝 Active response msg created: ${sent.message_id}`);
                } else {
                    // SUBSEQUENT: edit existing
                    try {
                        await this.bot.editMessageText(displayText, {
                            chat_id: this.chatId,
                            message_id: this._activeResponseMsgId
                        });
                    } catch (editErr) {
                        if (!editErr.message?.includes('not modified')) {
                            console.log(`⚠️ Edit error: ${editErr.message?.substring(0, 60)}`);
                            if (editErr.message?.includes('message to edit not found') ||
                                editErr.message?.includes('MESSAGE_ID_INVALID')) {
                                const sent = await this.bot.sendMessage(this.chatId, displayText);
                                this._activeResponseMsgId = sent.message_id;
                            }
                        }
                    }
                }

                this._lastEditedText = displayText;
                this._lastEditTime = now;
            } catch (e) {
                console.log(`⚠️ Send/edit error: ${e.message?.substring(0, 60)}`);
            }
        }).catch(e => {
            console.log(`⚠️ Send lock error: ${e.message?.substring(0, 60)}`);
        });

        return this._sendLock;
    }

    /**
     * Xử lý streaming messages từ bridge
     * Mọi update đều edit cùng 1 message duy nhất
     */
    async handleStreamingMessage(messages) {
        if (!messages || messages.length === 0) return;

        const latest = messages[messages.length - 1];
        this.lastStreamingMsg = latest;

        const text = latest.text || '';
        if (!text || text.length < 5) return;

        // Send/edit the single active response message
        await this._sendOrEditResponse(`⏳ AI đang trả lời...\n\n${text}`);

        // Reset timeout — đợi thêm data
        if (this.streamingTimeout) clearTimeout(this.streamingTimeout);

        this.streamingTimeout = setTimeout(() => {
            if (this.lastStreamingMsg) {
                const finalText = this.lastStreamingMsg.text || '';
                if (finalText && finalText !== this.lastSentText) {
                    this.handleCompleteMessage({
                        text: finalText,
                        html: this.lastStreamingMsg.html,
                        role: 'assistant'
                    });
                }
                this.lastStreamingMsg = null;
            }
        }, 5000);
    }

    /**
     * Xử lý tin nhắn hoàn chỉnh từ AI
     * Edit lần cuối — bỏ prefix ⏳, thêm 🤖
     */
    async handleCompleteMessage(message) {
        if (!message) return;

        const text = message.text || '';
        if (!text || text.length < 5) return;

        // Dedupe
        if (text === this.lastSentText) return;
        this.lastSentText = text;

        // Clear streaming state
        if (this.streamingTimeout) {
            clearTimeout(this.streamingTimeout);
            this.streamingTimeout = null;
        }
        this.lastStreamingMsg = null;

        console.log(`🤖 AI Response (final): ${text.substring(0, 80)}...`);

        // Save to history
        this.messageLogger?.saveHistory?.('assistant', text, message.html || null);

        // Final edit — clean format without ⏳
        await this._sendOrEditResponse(`🤖 AI:\n\n${text}`);
    }

    /**
     * Xử lý khi có pending action (Accept/Reject)
     */
    async handlePendingAction(action) {
        const actionText = action.command || action.type || 'Unknown action';
        const actionDetail = action.detail || '';

        let msg = `🎯 *Action cần xử lý*\n\n`;
        msg += `📋 ${this._escapeMarkdown(actionText)}`;
        if (actionDetail) {
            msg += `\n\`\`\`\n${actionDetail.substring(0, 500)}\n\`\`\``;
        }

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '✅ Accept', callback_data: 'accept_action' },
                    { text: '❌ Reject', callback_data: 'reject_action' }
                ]
            ]
        };

        await this.sendMessage(msg, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    // ==========================================
    // HELPERS
    // ==========================================

    /**
     * Gửi message đến Telegram chat
     * Hỗ trợ tách tin nhắn dài > 4096 ký tự
     */
    async sendMessage(text, options = {}) {
        if (!text) return;

        try {
            const chunks = this._splitMessage(text);
            for (const chunk of chunks) {
                try {
                    await this.bot.sendMessage(this.chatId, chunk, options);
                } catch (sendErr) {
                    // Bất kỳ lỗi nào → thử gửi lại không format
                    console.log(`⚠️ Send error (${sendErr.message?.substring(0, 60)}), retrying plain text`);
                    try {
                        await this.bot.sendMessage(this.chatId, chunk);
                    } catch (plainErr) {
                        console.error('❌ Plain text send also failed:', plainErr.message);
                    }
                }
            }
        } catch (e) {
            console.error('❌ Telegram sendMessage error:', e.message);
        }
    }

    /**
     * Format AI response cho Telegram
     * Chuyển HTML → text thuần, giữ code blocks
     */
    async _sendFormattedResponse(text) {
        // Gửi plain text trước (ổn định nhất), Markdown hay lỗi với AI output
        await this.sendMessage(`🤖 AI:\n\n${text}`);
    }

    /**
     * Tách tin nhắn dài thành chunks <= 4096 ký tự
     */
    _splitMessage(text) {
        if (text.length <= this.MAX_MSG_LENGTH) {
            return [text];
        }

        const chunks = [];
        let remaining = text;

        while (remaining.length > 0) {
            if (remaining.length <= this.MAX_MSG_LENGTH) {
                chunks.push(remaining);
                break;
            }

            // Tìm điểm cắt hợp lý (newline, dấu chấm, khoảng trắng)
            let splitIdx = this.MAX_MSG_LENGTH;

            // Ưu tiên cắt ở newline
            const lastNewline = remaining.lastIndexOf('\n', this.MAX_MSG_LENGTH);
            if (lastNewline > this.MAX_MSG_LENGTH * 0.5) {
                splitIdx = lastNewline;
            } else {
                // Fallback: cắt ở dấu chấm
                const lastDot = remaining.lastIndexOf('. ', this.MAX_MSG_LENGTH);
                if (lastDot > this.MAX_MSG_LENGTH * 0.5) {
                    splitIdx = lastDot + 1;
                } else {
                    // Fallback: cắt ở khoảng trắng
                    const lastSpace = remaining.lastIndexOf(' ', this.MAX_MSG_LENGTH);
                    if (lastSpace > this.MAX_MSG_LENGTH * 0.5) {
                        splitIdx = lastSpace;
                    }
                }
            }

            chunks.push(remaining.substring(0, splitIdx));
            remaining = remaining.substring(splitIdx).trimStart();
        }

        // Đánh số nếu có nhiều phần
        if (chunks.length > 1) {
            return chunks.map((chunk, i) => `📄 [${i + 1}/${chunks.length}]\n\n${chunk}`);
        }

        return chunks;
    }

    _escapeMarkdown(text) {
        return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
    }

    /**
     * Dọn dẹp khi shutdown
     */
    stop() {
        if (this.streamingTimeout) {
            clearTimeout(this.streamingTimeout);
        }
        if (this.bot) {
            this.bot.stopPolling();
            console.log('🤖 Telegram Bot stopped');
        }
    }
}

module.exports = TelegramBotService;
