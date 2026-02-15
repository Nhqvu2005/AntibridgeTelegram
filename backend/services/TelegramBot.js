/**
 * TelegramBot Service
 * Giao tiếp giữa Telegram và Antigravity AI
 * Thay thế web frontend bằng Telegram Bot
 */

const TelegramBot = require('node-telegram-bot-api');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const QuotaService = require('./QuotaService');

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

        // Manual override for project root (fallback if CDP fails)
        // Default to current working directory (where bot is running)
        this.manualProjectRoot = process.cwd();

        // Load available models from env
        this.availableModels = (process.env.AVAILABLE_MODELS || '')
            .split(',')
            .map(m => m.trim())
            .filter(m => m.length > 0);

        // Initialize bot
        this.bot = new TelegramBot(this.botToken, { polling: true });
        this.quotaService = new QuotaService();

        this._setupCommands();
        this._setupMessageHandler();
        this._setupCallbackHandler();

        // Start background quota monitor (check mỗi 5 phút)
        this.quotaService.startMonitor();

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
            { command: 'history_quota', description: '📜 Lịch sử thay đổi quota' },
            { command: 'conversations', description: '🗂️ Chuyển cuộc trò chuyện' },
            { command: 'open', description: '📂 Mở dự án khác' },
            { command: 'workflows', description: '⚡ Chạy Workflow (.agent/workflows)' },
            { command: 'skills', description: '🛠️ Chạy Skill (.agent/skills)' },
            { command: 'endtask', description: '🔴 Tắt Antigravity' },
            { command: 'restart', description: '🔄 Restart bot (load code mới)' },
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
        this.bot.onText(/\/history_quota/, (msg) => this._handleHistoryQuota(msg));
        this.bot.onText(/\/conversations/, (msg) => this._handleConversations(msg));
        this.bot.onText(/\/open(.*)/, (msg, match) => this._handleOpen(msg, match));
        this.bot.onText(/\/setproject(.*)/, (msg, match) => this._handleSetProject(msg, match));
        this.bot.onText(/\/workflows/, (msg) => this._handleWorkflows(msg));
        this.bot.onText(/\/skills/, (msg) => this._handleSkills(msg));
        this.bot.onText(/\/endtask/, (msg) => this._handleEndTask(msg));
        this.bot.onText(/\/restart/, (msg) => this._handleRestart(msg));
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
            await this.sendMessage('⏳ Đang lấy quota...');

            const data = await this.quotaService.getQuotaData();
            if (!data) {
                await this.sendMessage('❌ Không lấy được quota. Kiểm tra Antigravity đang chạy?');
                return;
            }

            // Save to history
            this.quotaService.saveToHistory(data);

            // Format and send
            const formatted = this.quotaService.formatQuotaForTelegram(data);
            await this.sendMessage(formatted || '❌ Không parse được quota');
        } catch (e) {
            await this.sendMessage(`❌ Quota error: ${e.message}`);
        }
    }

    async _handleHistoryQuota(msg) {
        if (!this._isAuthorized(msg)) return;

        try {
            const formatted = this.quotaService.formatHistoryForTelegram(15);
            await this.sendMessage(formatted);
        } catch (e) {
            await this.sendMessage(`❌ History error: ${e.message}`);
        }
    }

    // ==========================================
    // 🔴 END TASK: Kill Antigravity Process
    // ==========================================

    async _handleEndTask(msg) {
        if (!this._isAuthorized(msg)) return;

        try {
            await this.sendMessage('⏳ Đang tắt Antigravity...');

            try {
                execSync('taskkill /F /IM Antigravity.exe', { stdio: 'ignore' });
                await this.sendMessage(
                    '✅ **Đã tắt Antigravity!**\n\n' +
                    '🔌 CDP sẽ mất kết nối.\n' +
                    '👉 Dùng `/open` để mở lại khi cần.'
                );
            } catch (killErr) {
                // taskkill returns error if process not found
                await this.sendMessage('⚠️ Không tìm thấy Antigravity.exe đang chạy.');
            }
        } catch (e) {
            await this.sendMessage(`❌ EndTask error: ${e.message}`);
        }
    }

    async _handleRestart(msg) {
        if (!this._isAuthorized(msg)) return;

        await this.sendMessage(
            '🔄 **Restarting bot...**\n\n' +
            '⏳ Bot sẽ tự khởi động lại trong vài giây.\n' +
            '✅ Code mới nhất trên disk sẽ được load.'
        );

        // Give time for message to send
        await new Promise(r => setTimeout(r, 1000));

        // Exit process — START_TELEGRAM.bat loop will restart it
        console.log('🔄 Restart requested via Telegram. Exiting...');
        process.exit(0);
    }

    // ==========================================
    // 🗂️ NEW FEATURES: Conversations, Open, Skills
    // ==========================================

    async _handleConversations(msg, page = 0, isEdit = false) {
        if (!this._isAuthorized(msg)) return;

        try {
            if (!isEdit) await this.sendMessage('🔄 Đang tải danh sách...');

            const result = await this.antigravityBridge.getConversations();
            if (!result?.success || !result.data) {
                await this.sendMessage(`❌ Lỗi: ${result?.error || 'Không lấy được danh sách'}`);
                return;
            }

            const convs = result.data;
            if (convs.length === 0) {
                await this.sendMessage('📭 Không có cuộc trò chuyện nào.');
                return;
            }

            // Pagination: 5 items per page
            const ITEMS_PER_PAGE = 5;
            const totalPages = Math.ceil(convs.length / ITEMS_PER_PAGE);
            if (page < 0) page = 0;
            if (page >= totalPages) page = totalPages - 1;

            const startIdx = page * ITEMS_PER_PAGE;
            const endIdx = Math.min(startIdx + ITEMS_PER_PAGE, convs.length);
            const pageItems = convs.slice(startIdx, endIdx);

            const keyboard = [];

            // Build list items
            for (const item of pageItems) {
                const marker = item.isCurrent ? '✅ ' : '';
                const btnText = `${marker}${item.title} ${item.time ? `(${item.time})` : ''}`.trim();
                // Use title for matching (truncate to fit Telegram's 64-byte callback_data limit)
                const cbTitle = item.title.substring(0, 58);
                keyboard.push([{ text: btnText, callback_data: `conv_${cbTitle}` }]);
            }

            // Navigation buttons
            const navRow = [];
            if (page > 0) navRow.push({ text: '⬅️ Trước', callback_data: `conv_page_${page - 1}` });
            if (page < totalPages - 1) navRow.push({ text: 'Sau ➡️', callback_data: `conv_page_${page + 1}` });
            if (navRow.length > 0) keyboard.push(navRow);

            const text = `🗂️ **Danh sách hội thoại** (Trang ${page + 1}/${totalPages})`;

            if (isEdit) {
                await this.bot.editMessageText(text, {
                    chat_id: this.chatId,
                    message_id: msg.message.message_id, // For callback queries, message is inside msg
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            } else {
                await this.sendMessage(text, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            }

        } catch (e) {
            await this.sendMessage(`❌ Conversations error: ${e.message}`);
        }
    }

    async _handleOpen(msg, match = null, directPath = null, isEdit = false, page = 0) {
        if (!this._isAuthorized(msg)) return;

        try {
            // Determine path to browse
            let browsePath = directPath;
            if (!browsePath) {
                if (match && match[1] && match[1].trim()) {
                    browsePath = match[1].trim();
                } else {
                    browsePath = this.currentBrowsePath || process.cwd();
                }
            }

            // Normalize
            browsePath = path.resolve(browsePath);
            this.currentBrowsePath = browsePath; // save state

            // Read directory
            let entries = [];
            try {
                entries = fs.readdirSync(browsePath, { withFileTypes: true });
            } catch (e) {
                await this.sendMessage(`❌ Không đọc được folder: ${browsePath}\n${e.message}`);
                return;
            }

            // Filter folders only
            const folders = entries.filter(e => e.isDirectory()).map(e => e.name);

            // Sort: .agent first, then others
            folders.sort((a, b) => {
                const aDot = a.startsWith('.');
                const bDot = b.startsWith('.');
                if (aDot && !bDot) return -1;
                if (!aDot && bDot) return 1;
                return a.localeCompare(b);
            });

            // Pagination Logic
            const ITEMS_PER_PAGE = 10;
            const totalPages = Math.ceil(folders.length / ITEMS_PER_PAGE);
            // Ensure page is within bounds
            if (page < 0) page = 0;
            if (page >= totalPages && totalPages > 0) page = totalPages - 1;

            const startIdx = page * ITEMS_PER_PAGE;
            const endIdx = startIdx + ITEMS_PER_PAGE;
            const currentFolders = folders.slice(startIdx, endIdx);

            // Build UI
            const keyboard = [];

            // 1. Open Current Button
            keyboard.push([{ text: `✅ Mở Project này: ${path.basename(browsePath)}`, callback_data: `open_current` }]);

            // 2. Parent Directory
            const parent = path.dirname(browsePath);
            if (parent !== browsePath) {
                keyboard.push([{ text: '⬅️ .. (Lên 1 cấp)', callback_data: 'parent_dir' }]);
            }

            // 3. Subfolders
            for (const folder of currentFolders) {
                keyboard.push([{ text: `📂 ${folder}`, callback_data: `dir_${folder}` }]);
            }

            // 4. Pagination Controls
            if (totalPages > 1) {
                const navRow = [];
                if (page > 0) {
                    navRow.push({ text: '<< Trước', callback_data: `dirpage_${page - 1}` });
                }
                navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'ignore' });
                if (page < totalPages - 1) {
                    navRow.push({ text: 'Sau >>', callback_data: `dirpage_${page + 1}` });
                }
                keyboard.push(navRow);
            }

            const text = `📂 **Duyệt File System**\n📍 Path: \`${browsePath}\`\n📄 Trang ${page + 1}/${totalPages || 1}`;

            const options = {
                chat_id: this.chatId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            };

            if (isEdit) {
                // If isEdit, we must have msg.message OR query.message
                // Usually msg IS the message object when called from callback
                // But _handleOpen signature expects msg to be the message object?
                // Wait, normal calls: _handleOpen(msg) -> msg is incoming message
                // Callback calls: _handleOpen(query.message, ...) -> msg is the message to edit

                // We need message_id
                const msgId = msg.message_id || msg.message?.message_id;
                if (msgId) {
                    options.message_id = msgId;
                    try {
                        await this.bot.editMessageText(text, options);
                    } catch (editErr) {
                        // Ignore "message is not modified"
                        if (editErr.message?.includes('not modified')) return;

                        // If other error (e.g. markdown), try sending new message
                        console.error('⚠️ Edit failed, sending new message:', editErr.message);
                        await this.sendMessage(text, { reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown' });
                    }
                } else {
                    await this.sendMessage(text, { reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown' });
                }
            } else {
                await this.sendMessage(text, { reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown' });
            }

        } catch (e) {
            await this.sendMessage(`❌ Open error: ${e.message}`);
        }
    }

    async _handleWorkflows(msg) {
        if (!this._isAuthorized(msg)) return;

        try {
            await this.sendMessage('⚡ Đang quét workflows...');

            // 1. Get current project root
            const rootPath = await this._getProjectRoot();
            if (!rootPath) {
                await this.sendMessage('❌ Không xác định được Project Root.\n(Hãy dùng `/open` hoặc `/setproject <path>` để set thủ công)');
                return;
            }

            // 2. Check .agent/workflows
            const workflowsPath = path.join(rootPath, '.agent', 'workflows');
            if (!fs.existsSync(workflowsPath)) {
                await this.sendMessage(`⚠️ Không tìm thấy folder workflows: \`${workflowsPath}\``, { parse_mode: 'Markdown' });
                return;
            }

            // 3. List .md files
            const entries = fs.readdirSync(workflowsPath, { withFileTypes: true });
            const files = entries.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name);

            if (files.length === 0) {
                await this.sendMessage('📭 Không có file workflow (.md) nào.');
                return;
            }

            // 4. Build keyboard
            const keyboard = [];
            for (const file of files) {
                keyboard.push([{ text: `⚡ ${file}`, callback_data: `workflow_${file}` }]);
            }

            await this.sendMessage(`⚡ **Danh sách Workflow**\n📍 \`${workflowsPath}\``, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });

        } catch (e) {
            await this.sendMessage(`❌ Workflow error: ${e.message}`);
        }
    }

    async _executeWorkflow(filename, queryId) {
        try {
            const rootPath = await this._getProjectRoot();
            if (!rootPath) throw new Error('Root path not found');

            const filePath = path.join(rootPath, '.agent', 'workflows', filename);
            if (!fs.existsSync(filePath)) throw new Error('Skill file not found');

            const content = fs.readFileSync(filePath, 'utf-8');

            await this.bot.answerCallbackQuery(queryId, { text: `🚀 Đang chạy skill: ${filename}` });
            await this.sendMessage(`🚀 **Executing Skill: ${filename}**...`);

            // Inject to chat
            const result = await this.antigravityBridge.injectTextToChat(content);
            if (result?.success) {
                await this.sendMessage('✅ Đã gửi skill vào chat! Đang đợi AI xử lý...');
                await this._pollForResponse(''); // Start polling
            } else {
                await this.sendMessage('❌ Gửi skill thất bại.');
            }

        } catch (e) {
            await this.sendMessage(`❌ Workflow error: ${e.message}`);
        }
    }

    async _handleSkills(msg) {
        if (!this._isAuthorized(msg)) return;

        try {
            await this.sendMessage('🛠️ Đang quét skills...');

            const rootPath = await this._getProjectRoot();
            if (!rootPath) {
                await this.sendMessage('❌ Không xác định được Project Root.\n(Hãy dùng `/open` hoặc `/setproject <path>` để set thủ công)');
                return;
            }

            const skillsPath = path.join(rootPath, '.agent', 'skills');
            if (!fs.existsSync(skillsPath)) {
                await this.sendMessage(`⚠️ Không tìm thấy folder skills: \`${skillsPath}\``, { parse_mode: 'Markdown' });
                return;
            }

            // List Directories
            const entries = fs.readdirSync(skillsPath, { withFileTypes: true });
            const folders = entries.filter(e => e.isDirectory()).map(e => e.name);

            if (folders.length === 0) {
                await this.sendMessage('📭 Không có skill folder nào.');
                return;
            }

            // Build Folder Keyboard
            const keyboard = [];
            for (const folder of folders) {
                keyboard.push([{ text: `📂 ${folder}`, callback_data: `skill_folder_${folder}` }]);
            }

            await this.sendMessage(`🛠️ **Danh sách Skill Folder**\n📍 \`${skillsPath}\``, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });

        } catch (e) {
            await this.sendMessage(`❌ Skill scanner error: ${e.message}`);
        }
    }

    async _handleSkillFolder(msg, folderName, isEdit = false) {
        try {
            const rootPath = await this._getProjectRoot();
            const folderPath = path.join(rootPath, '.agent', 'skills', folderName);

            // List .md files in skill folder
            const entries = fs.readdirSync(folderPath, { withFileTypes: true });
            const files = entries.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name);

            if (files.length === 0) {
                await this.sendMessage(`📭 Folder \`${folderName}\` không có file .md nào.`);
                return;
            }

            // Build File Keyboard
            const keyboard = [];
            for (const file of files) {
                keyboard.push([{ text: `📜 ${file}`, callback_data: `skill_file_${folderName}|${file}` }]);
            }

            const text = `🛠️ **Skill: ${folderName}**\nChọn file để chạy:`;

            if (isEdit && msg.message) {
                await this.bot.editMessageText(text, {
                    chat_id: this.chatId,
                    message_id: msg.message.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            } else {
                await this.sendMessage(text, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            }

        } catch (e) {
            await this.sendMessage(`❌ Skill folder error: ${e.message}`);
        }
    }

    async _executeSkillFile(folder, filename, queryId) {
        try {
            const rootPath = await this.antigravityBridge.getCurrentProjectRoot();
            const filePath = path.join(rootPath, '.agent', 'skills', folder, filename);

            if (!fs.existsSync(filePath)) throw new Error('Skill file not found');

            const content = fs.readFileSync(filePath, 'utf-8');

            await this.bot.answerCallbackQuery(queryId, { text: `🚀 Chạy ${folder}/${filename}...` });
            await this.sendMessage(`🚀 **Executing Skill: ${folder}/${filename}**...`);

            const result = await this.antigravityBridge.injectTextToChat(content);
            if (result?.success) {
                await this.sendMessage('✅ Đã gửi skill vào chat!');
                await this._pollForResponse('');
            } else {
                await this.sendMessage('❌ Gửi thất bại.');
            }
        } catch (e) {
            await this.sendMessage(`❌ Execute skill error: ${e.message}`);
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
        const myGeneration = this._pollGeneration || 0; // snapshot current generation

        console.log('🔄 Starting CDP response polling (fast 2min → slow 15min)...');

        const doPoll = async () => {
            if (responseSentViaPolling) return;

            // Cancel if a new user message reset the generation
            if ((this._pollGeneration || 0) !== myGeneration) {
                console.log('🛑 Poll cancelled (new user message started)');
                return;
            }

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
                        const formatted = this._formatTablesForTelegram(currentText);
                        await this._sendOrEditResponse(`🤖 AI:\n\n${formatted}`);
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
                }
                // --- Conversation Callbacks ---
                else if (action.startsWith('conv_')) {
                    const target = action.replace('conv_', ''); // could be index or title? better index
                    // If page navigation
                    if (target.startsWith('page_')) {
                        const page = parseInt(target.replace('page_', ''));
                        await this._handleConversations(query.message, page, true); // edit mode
                        await this.bot.answerCallbackQuery(query.id);
                    } else {
                        // Switch conversation by title
                        await this.bot.answerCallbackQuery(query.id, { text: '🔄 Đang chuyển...' });
                        const result = await this.antigravityBridge.switchConversation(target);
                        if (result?.success) {
                            await this.bot.sendMessage(`✅ Đã chuyển đổi cuộc trò chuyện!`);
                        } else {
                            await this.bot.sendMessage(`❌ Không thể chuyển: ${result?.error}`);
                        }
                    }
                }
                // --- Open Project Callbacks ---
                else if (action.startsWith('dir_') || action.startsWith('open_') || action === 'parent_dir' || action.startsWith('dirpage_')) {
                    if (action.startsWith('dirpage_')) {
                        const page = parseInt(action.replace('dirpage_', ''));
                        // Use currentBrowsePath implicitly by passing null
                        await this._handleOpen(query.message, null, null, true, page);
                    } else if (action === 'parent_dir') {
                        const parent = path.dirname(this.currentBrowsePath || 'C:\\');
                        await this._handleOpen(query.message, null, parent, true);
                    } else if (action.startsWith('dir_')) {
                        const dirName = action.replace('dir_', '');
                        const newPath = path.join(this.currentBrowsePath || 'C:\\', dirName);
                        await this._handleOpen(query.message, null, newPath, true);
                    } else if (action.startsWith('open_')) {
                        const targetPath = action.replace('open_', '');
                        // open_current means use currentBrowsePath
                        const finalPath = targetPath === 'current' ? (this.currentBrowsePath || 'C:\\') : path.join(this.currentBrowsePath || 'C:\\', targetPath);

                        console.log(`📂 User requested open: ${finalPath}`);
                        await this.bot.answerCallbackQuery(query.id, { text: '📂 Đang mở dự án...' });

                        try {
                            // Direct Native Launch (bypassing CDP as requested)
                            this.manualProjectRoot = finalPath;

                            const exePath = await this._findAntigravityExecutable();
                            let launched = false;

                            if (exePath && fs.existsSync(exePath)) {
                                try {
                                    // Spawn detached process
                                    // Use -r to reuse window if possible
                                    const cdpPort = process.env.CDP_PORT || '9000';
                                    const subprocess = spawn(exePath, ['-r', finalPath, `--remote-debugging-port=${cdpPort}`], {
                                        detached: true,
                                        stdio: 'ignore',
                                        windowsHide: false
                                    });
                                    subprocess.unref();
                                    launched = true;
                                } catch (e) {
                                    console.error('❌ Native launch failed:', e);
                                }
                            }

                            if (launched) {
                                await this.bot.sendMessage(this.chatId,
                                    `🚀 **Đang mở dự án...**\n` +
                                    `📂 Path: \`${finalPath}\``
                                );
                            } else {
                                await this.bot.sendMessage(this.chatId,
                                    `⚠️ **Không thể mở dự án**\n` +
                                    `- Native launch thất bại: Không tìm thấy Antigravity.exe\n\n` +
                                    `👉 Tuy nhiên, Bot **đã chuyển context** sang:\n\`${finalPath}\``
                                );
                            }
                        } catch (openErr) {
                            console.error('❌ Open Project Error:', openErr);
                            await this.bot.sendMessage(this.chatId, `❌ Lỗi ngoại lệ: ${openErr.message}`);
                        }
                    }

                    await this.bot.answerCallbackQuery(query.id);
                }
                // --- Workflow Callbacks ---
                else if (action.startsWith('workflow_')) {
                    const filename = action.replace('workflow_', '');
                    await this._executeWorkflow(filename, query.id);
                }
                // --- Skill Callbacks ---
                else if (action.startsWith('skill_folder_')) {
                    const folderName = action.replace('skill_folder_', '');
                    await this._handleSkillFolder(query.message, folderName, true); // list files
                    await this.bot.answerCallbackQuery(query.id);
                }
                else if (action.startsWith('skill_file_')) {
                    // format: skill_file_FOLDER|FILENAME
                    const [folder, filename] = action.replace('skill_file_', '').split('|');
                    if (folder && filename) {
                        await this._executeSkillFile(folder, filename, query.id);
                    }
                }
                else {
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
     * Increments _pollGeneration to auto-cancel any in-progress polling
     */
    _resetActiveResponse() {
        this._activeResponseMsgId = null;
        this._lastEditedText = null;
        this._lastEditTime = null;
        this._sendLock = Promise.resolve(); // reset lock chain
        this.lastSentText = null;
        this._pollGeneration = (this._pollGeneration || 0) + 1; // cancel old polls
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

        // Always prefer HTML-based conversion when available
        // (text path strips <pre> elements, losing code blocks entirely)
        let formattedText;
        if (message.html && message.html.length > 10) {
            formattedText = this._htmlToFormattedText(message.html);
            console.log('📊 Used HTML-to-text conversion');
        } else {
            formattedText = this._formatTablesForTelegram(text);
        }

        // Final edit — clean format without ⏳
        await this._sendOrEditResponse(`🤖 AI:\n\n${formattedText}`);
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
     * Clean up text for Telegram display (no parse_mode)
     * Strips CSS noise, language labels, and raw markdown artifacts
     */
    _formatTablesForTelegram(text) {
        if (!text) return text;

        // Strip leaked CSS patterns
        text = text.replace(/@keyframes[\s\S]*?\}\s*\}/g, '');
        text = text.replace(/\.code-block[\s\S]*?\}/g, '');
        text = text.replace(/\*::selection\s*\{[\s\S]*?\}/g, '');

        // Clean up code block language labels that innerText picks up
        const langLabels = ['javascript', 'typescript', 'python', 'java', 'go', 'rust', 'bash', 'shell', 'css', 'html', 'json', 'yaml', 'sql', 'c', 'cpp', 'csharp', 'ruby', 'php', 'swift', 'kotlin', 'jsx', 'tsx'];
        for (const lang of langLabels) {
            text = text.replace(new RegExp(`^${lang}\\s*$`, 'gim'), '');
            text = text.replace(new RegExp(`^${lang}(\\s*(?://|/\\*|#|<!--|\\n))`, 'gim'), '$1');
        }

        // Strip raw markdown artifacts (since no parse_mode is used)
        text = text.replace(/```\w*\n?/g, '');  // triple backticks
        text = text.replace(/\*\*([^*]+)\*\*/g, '$1');  // **bold**
        text = text.replace(/__([^_]+)__/g, '$1');  // __bold__
        text = text.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1');  // _italic_
        // Don't strip single backticks from code — they look fine without parse_mode

        // Clean up excessive newlines
        text = text.replace(/\n{3,}/g, '\n\n').trim();

        return text;
    }

    /**
     * Convert HTML to formatted text, handling tables as blocks
     * Strips style/script content, converts tables to block format
     * @param {string} html - Raw HTML string
     * @returns {string} - Formatted text with tables as blocks
     */
    _htmlToFormattedText(html) {
        if (!html) return '';

        try {
            let text = html;

            // ===== FIRST: Strip style and script content entirely =====
            text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
            text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

            // ===== Convert HTML tables to block format =====
            // Each row becomes a block with labeled lines
            const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
            text = text.replace(tableRegex, (match, tableContent) => {
                const rows = [];

                // Extract all rows
                const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
                let trMatch;
                while ((trMatch = trRegex.exec(tableContent)) !== null) {
                    const cells = [];
                    const cellRegex = /<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
                    let cellMatch;
                    while ((cellMatch = cellRegex.exec(trMatch[1])) !== null) {
                        const cellText = cellMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
                        cells.push(cellText);
                    }
                    if (cells.length > 0) rows.push(cells);
                }

                if (rows.length === 0) return '';

                // First row = headers
                const headers = rows[0];
                const dataRows = rows.slice(1);

                if (dataRows.length === 0) {
                    // Only header row, just show as list
                    return '\n' + headers.join(' | ') + '\n';
                }

                // Build block format: each data row = block with header labels
                const blocks = [];
                for (const row of dataRows) {
                    const lines = [];
                    for (let i = 0; i < row.length; i++) {
                        const label = headers[i] || `Col${i + 1}`;
                        const value = row[i] || '';
                        if (value) {
                            lines.push(`  ${label}: ${value}`);
                        }
                    }
                    if (lines.length > 0) {
                        blocks.push('📌 ' + (row[0] || '') + '\n' + lines.slice(1).join('\n'));
                    }
                }
                return '\n' + blocks.join('\n\n') + '\n';
            });

            // ===== Convert Antigravity code blocks =====
            // Structure: <pre> > div > div.code-block > div.code-line > div.line-content > spans
            text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (match, preContent) => {
                // Check if Antigravity code block (has line-content divs)
                if (!preContent.includes('line-content')) {
                    // Traditional <pre> — just strip tags
                    let code = preContent.replace(/<[^>]+>/g, '').trim();
                    code = code.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                    if (!code) return '';
                    return '\n━━━━━━━━━━━━━━━━\n' + code + '\n━━━━━━━━━━━━━━━━\n';
                }

                // Extract text from each line-content div
                const lines = [];
                const lineContentRegex = /<div[^>]*class="[^"]*line-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
                let lcMatch;
                while ((lcMatch = lineContentRegex.exec(preContent)) !== null) {
                    let lineText = lcMatch[1].replace(/<[^>]+>/g, '');
                    lineText = lineText.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
                    lines.push(lineText);
                }

                if (lines.length === 0) return '';

                const code = lines.join('\n').trim();
                return '\n━━━ Code ━━━\n' + code + '\n━━━━━━━━━━━━\n';
            });

            // ===== Convert other HTML elements (NO parse_mode, so no markdown syntax) =====
            // Inline code — just show text without backticks
            text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (m, content) => {
                return content.replace(/<[^>]+>/g, '').trim();
            });
            // Bold — just show text (no ** since Telegram won't parse it)
            text = text.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '$1');
            // Italic — just show text
            text = text.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '$1');
            // Line breaks and paragraphs
            text = text.replace(/<br\s*\/?>/gi, '\n');
            text = text.replace(/<\/p>/gi, '\n');
            text = text.replace(/<\/li>/gi, '\n');
            text = text.replace(/<li[^>]*>/gi, '• ');
            // Headings — use emoji marker instead of markdown
            text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n📍 $1\n');
            // Strip remaining HTML tags
            text = text.replace(/<[^>]+>/g, '');
            // Decode HTML entities
            text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
            // Clean up excessive newlines
            text = text.replace(/\n{3,}/g, '\n\n').trim();

            return text;
        } catch (e) {
            console.log(`⚠️ HTML to text conversion error: ${e.message}`);
            return html.replace(/<[^>]+>/g, '').trim();
        }
    }

    /**
     * 🧠 Helper: Lấy Project Root (CDP -> Fallback Manual)
     */
    async _getProjectRoot() {
        // 1. Try CDP
        const cdpRoot = await this.antigravityBridge.getCurrentProjectRoot();
        if (cdpRoot && !cdpRoot.startsWith('ERROR_') && cdpRoot !== 'NO_WORKSPACE') {
            // Update manual root to sync
            this.manualProjectRoot = cdpRoot;
            return cdpRoot;
        }

        // 2. Fallback to manual
        if (this.manualProjectRoot) {
            console.log(`⚠️ Using manual project root: ${this.manualProjectRoot}`);
            return this.manualProjectRoot;
        }

        return null;
    }

    /**
     * 📁 Handler: /setproject <path>
     */
    async _handleSetProject(msg, match) {
        if (!this._isAuthorized(msg)) return;
        const pathStr = match[1] ? match[1].trim() : '';

        if (!pathStr) {
            await this.sendMessage('⚠️ Vui lòng nhập đường dẫn. Ví dụ: `/setproject G:\\Job\\MyProject`');
            return;
        }

        if (fs.existsSync(pathStr)) {
            this.manualProjectRoot = pathStr;
            await this.sendMessage(`✅ Đã set Project Root thủ công: \`${pathStr}\`\n(Bạn có thể dùng /skills now!)`);
        } else {
            await this.sendMessage(`❌ Đường dẫn không tồn tại: \`${pathStr}\``);
        }
    }
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
    /**
     * Finds the Antigravity executable path dynamically.
     * Tries:
     * 1. process.env.ANTIGRAVITY_PATH
     * 2. wmic process (running instance)
     * 3. Default path (null/none)
     */
    async _findAntigravityExecutable() {
        if (process.env.ANTIGRAVITY_PATH && fs.existsSync(process.env.ANTIGRAVITY_PATH)) {
            return process.env.ANTIGRAVITY_PATH;
        }

        return new Promise((resolve) => {
            exec('wmic process where "name like \'%Antigravity%\'" get executablepath', (err, stdout) => {
                if (!err && stdout) {
                    const lines = stdout.split('\n').map(l => l.trim()).filter(l => l && l.toLowerCase().includes('antigravity.exe'));
                    if (lines.length > 0) {
                        // lines[0] is usually ExecutablePath header, lines[1] is the path
                        const path = lines.find(l => l.toLowerCase().endsWith('.exe'));
                        if (path) {
                            console.log(`🔍 Found Antigravity path via wmic: ${path}`);
                            resolve(path);
                            return;
                        }
                    }
                }
                // Fallback: Return null if not found
                console.log('⚠️ Could not find Antigravity path via wmic.');
                resolve(null);
            });
        });
    }
}

module.exports = TelegramBotService;
