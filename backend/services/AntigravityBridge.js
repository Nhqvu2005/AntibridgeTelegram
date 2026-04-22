/**
 * AntigravityBridge - Kết nối CDP với Antigravity
 * Inject messages và lắng nghe responses
 */

const puppeteer = require('puppeteer-core');
const { exec } = require('child_process');
const path = require('path');
const ChatLogger = require('./ChatLogger');
const messageLogger = require('./MessageLogger');

class AntigravityBridge {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.browser = null;
        this.page = null;
        this.isConnected = false;
        this.debugUrl = 'http://127.0.0.1:9000';

        // Selectors cho Antigravity UI (cần điều chỉnh theo thực tế)
        this.selectors = {
            chatInput: 'textarea[placeholder*="message"], textarea[data-testid="chat-input"], .chat-input textarea',
            sendButton: 'button[type="submit"], button[aria-label*="send"], .send-button',
            messageContainer: '.messages-container, .chat-messages, [data-testid="messages"]',
            lastMessage: '.message:last-child, .chat-message:last-child'
        };

        // Chat extraction state
        this.lastMessages = [];
        this.lastMessageHashes = new Set();
        this.chatPollInterval = null;

        // Chat logger
        this.chatLogger = new ChatLogger();

        // Streaming detection - STABLE THRESHOLD (chờ content ổn định trước khi emit complete)
        this.streamBuffer = '';           // Buffer for streaming AI text
        this.isStreaming = false;          // Flag: AI is currently streaming
        this.lastTotalContent = 0;         // Total content length from last poll
        this.stableCount = 0;             // Số poll cycles mà content không đổi
        this.STREAM_STABLE_THRESHOLD = 1; // Emit complete ngay khi ổn định 1 cycle

        // Bridge re-injection interval (keep bridge alive)
        this.bridgeInjectInterval = null;

        // Context caching for Option 1 (Shit-Chat style injection)
        this.cachedChatFrame = null;


        // ========== NOISE PATTERNS: Loại bỏ tên model và UI elements ==========
        this.NOISE_PATTERNS = [
            // Model names (GPT-OSS có 2 chữ S!)
            /^GPT-?OS{1,2}\s+\d+\w*\s*\([^)]+\)\s*$/i,     // GPT-OS / GPT-OSS 120B (Medium)
            /^Claude\s+\d+(\.\d+)?\s*\w*\s*(\([^)]+\))?\s*$/i,  // Claude 3.5 Sonnet (Thinking)
            /^Gemini\s+\d+(\.\d+)?\s*\w*\s*(\([^)]+\))?\s*$/i,  // Gemini 2.0 Flash (High)
            /^Llama\s+\d+(\.\d+)?\s*\w*\s*$/i,            // Llama 3.1 70B
            /^GPT-?4[ov]?\s*(-turbo|-mini)?\s*$/i,        // GPT-4, GPT-4o, GPT-4-turbo
            /^o[123]-?(mini|preview)?\s*$/i,              // o1-mini, o3-preview
            /^Anthropic\s+/i,
            /^Mistral\s+/i,
            /^DeepSeek\s+/i,
            /Claude Opus/i,     // Claude Opus 4.5 (Thinking)
            /Claude Sonnet/i,   // Claude Sonnet 4.5
            /Gemini \d+ Pro/i,  // Gemini 3 Pro (High/Low)

            // UI Labels từ Antigravity (từ log file)
            /^AI may make mistakes/i,
            /^Double-check all generated code/i,
            /^Agent will execute tasks directly/i,
            /^Agent can plan before executing/i,
            /^Use for (simple|deep|complex)/i,
            /^Conversation mode$/i,
            /^Ask anything/i,
            /^Ctrl\+[A-Z]/i,           // Keyboard shortcuts
            /^@ to mention/i,
            /^\/ for workflows$/i,

            // ========== NEW: Model selector dropdown ==========
            /Add\s*context/i,
            /^Images$/i,
            /^Mentions$/i,
            /^Workflows$/i,
            /^Planning$/i,
            /^Fast$/i,
            /^Model$/i,
            /^New$/i,
            /^Claude.*\(Thinking\)\s*$/i,     // EXACT: "Claude Opus 4.5 (Thinking)"
            /^Claude Sonnet[\s\d.]*$/i,        // EXACT: "Claude Sonnet 4.5" (chỉ tên model đứng một mình)
            /^Claude Opus[\s\d.]*$/i,          // EXACT: "Claude Opus 4.5"
            /^Gemini\s*\d+[\s\w()]*$/i,        // EXACT: "Gemini 3 Pro (High)"
            /^GPT-OSS[\s\d\w()]*$/i,           // EXACT: "GPT-OSS 120B (Medium)"
            /^\s*\(High\)\s*$|^\s*\(Low\)\s*$|^\s*\(Medium\)\s*$/i,   // EXACT: quality labels alone
            /Nhập lệnh cho AI agent/i,         // Vietnamese placeholder

            // Conversation titles (từ sidebar)
            /^Synchronize Server/i,
            /^Implementing Chat/i,
            /^Debug Antigravity/i,
            /^Fixing (Chat|Noise|Mobile)/i,
            /^Testing (Mobile|Remote|Server)/i,

            // File paths (Windows & Unix)
            /^[a-zA-Z]:\\[^<>:"|?*]+$/,                   // d:\01_BUILD_APP\...
            /^\/[^<>:"|?*]+$/,                            // /home/user/...

            // Folder/path segments (từ screenshot user)
            /^\.agent\\?$/i,                              // .agent or .agent\
            /^\\+$/,                                      // \ or \\ alone
            /^workflows?$/i,                              // workflows or workflow
            /^scripts?$/i,                                // scripts or script
            /^backend$/i,                                 // backend
            /^frontend$/i,                                // frontend
            /^node_modules$/i,                            // node_modules
            /^[a-zA-Z0-9_-]+\\$/,                         // any\folder\ending\with\backslash

            // UI elements (short texts)
            /^(Accept|Reject|Cancel|Submit|Send|Gửi|Hủy|Copy|Edit|Delete)$/i,
            /^(Yes|No|OK|Done|Close|Đóng|Xác nhận)$/i,
            /^\d+\s*(tokens?|words?|chars?)\s*$/i,       // "123 tokens"
            /^Model:?\s*$/i,
            /^Response:?\s*$/i,
            /^Thinking\.{0,3}$/i,       // "Thinking..."
            /^Loading\.{0,3}$/i,        // "Loading..."
            /^Generating\.{0,3}$/i,     // "Generating..."
            /^Thinking for \d+s$/i,     // "Thinking for 11s"
            /^Progress Updates$/i,
            /^Show items analyzed$/i,
            /^\d+ Files With Changes$/i,
            /^Error while editing$/i,
            /^Auto-proceeded by/i,
        ];

        // Minimum content length for valid AI response (giảm xuống 20 để không bỏ lỡ messages)
        this.MIN_RESPONSE_LENGTH = 20;

    }

    /**
     * Gửi phím Enter thông qua CDP Input (Mạnh mẽ hơn JS event)
     */
    async simulateEnterKey() {
        if (!this.page) return false;
        try {
            console.log('⌨️ CDP: Sending Enter Key...');
            await this.page.keyboard.press('Enter');
            return true;
        } catch (e) {
            console.error('❌ CDP Enter Key Error:', e.message);
            return false;
        }
    }

    /**
     * Gửi Toggle Shortcut (Ctrl+Alt+Shift+T) qua CDP
     * Dùng để toggle Auto/Manual mode trong Extension
     */
    async sendToggleShortcut() {
        if (!this.page) return { success: false, error: 'Not connected to Antigravity' };

        try {
            console.log('⌨️ CDP: Sending Toggle Shortcut (Ctrl+Alt+Shift+T)...');

            // Nhấn tổ hợp phím: Ctrl + Alt + Shift + T
            await this.page.keyboard.down('Control');
            await this.page.keyboard.down('Alt');
            await this.page.keyboard.down('Shift');
            await this.page.keyboard.press('T');
            await this.page.keyboard.up('Shift');
            await this.page.keyboard.up('Alt');
            await this.page.keyboard.up('Control');

            console.log('✅ CDP: Toggle Shortcut Sent!');
            return { success: true };
        } catch (e) {
            console.error('❌ CDP Toggle Shortcut Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * Gửi Accept Shortcut (Ctrl+Alt+Shift+A) qua CDP
     * Dùng để Accept action trong Extension
     */
    async sendAcceptShortcut() {
        if (!this.page) return { success: false, error: 'Not connected to Antigravity' };

        try {
            console.log('⌨️ CDP: Sending Accept Shortcut (Ctrl+Alt+Shift+A)...');

            await this.page.keyboard.down('Control');
            await this.page.keyboard.down('Alt');
            await this.page.keyboard.down('Shift');
            await this.page.keyboard.press('A');
            await this.page.keyboard.up('Shift');
            await this.page.keyboard.up('Alt');
            await this.page.keyboard.up('Control');

            console.log('✅ CDP: Accept Shortcut Sent!');
            return { success: true };
        } catch (e) {
            console.error('❌ CDP Accept Shortcut Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * Gửi Reject Shortcut (Ctrl+Alt+Shift+R) qua CDP
     * Dùng để Reject action trong Extension
     */
    async sendRejectShortcut() {
        if (!this.page) return { success: false, error: 'Not connected to Antigravity' };

        try {
            console.log('⌨️ CDP: Sending Reject Shortcut (Ctrl+Alt+Shift+R)...');

            await this.page.keyboard.down('Control');
            await this.page.keyboard.down('Alt');
            await this.page.keyboard.down('Shift');
            await this.page.keyboard.press('R');
            await this.page.keyboard.up('Shift');
            await this.page.keyboard.up('Alt');
            await this.page.keyboard.up('Control');

            console.log('✅ CDP: Reject Shortcut Sent!');
            return { success: true };
        } catch (e) {
            console.error('❌ CDP Reject Shortcut Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * Gửi Run/Accept Shortcut (Alt+Enter) qua CDP
     */
    async sendRunAcceptShortcut() {
        if (!this.page) return { success: false, error: 'Not connected to Antigravity' };

        try {
            console.log('⌨️ CDP: Sending Run/Accept Shortcut (Alt+Enter)...');

            await this.page.keyboard.down('Alt');
            await this.page.keyboard.press('Enter');
            await this.page.keyboard.up('Alt');

            console.log('✅ CDP: Run/Accept Shortcut Sent!');
            return { success: true };
        } catch (e) {
            console.error('❌ CDP Run/Accept Shortcut Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    // ============================================================
    // 🚀 CDP CLICK FUNCTIONS (v3.0.0 - Non-Extension)
    // Các function này KHÔNG cần Extension, click trực tiếp vào DOM
    // ============================================================

    /**
     * 🟢 Accept by CDP Click (KHÔNG cần Extension)
     * Tìm và click trực tiếp vào nút Accept trong chat panel
     */
    async acceptByClick() {
        if (!this.page) return { success: false, error: 'Not connected to Antigravity' };

        try {
            console.log('🟢 CDP: Accepting by click...');

            const frames = this.page.frames();

            for (const frame of frames) {
                const frameUrl = frame.url();
                if (!frameUrl || frameUrl === 'about:blank') continue;

                // Tìm trong các frame có thể chứa chat/agent panel
                if (!frameUrl.includes('cascade-panel') &&
                    !frameUrl.includes('agentPanel') &&
                    !frameUrl.includes('webview') &&
                    !frameUrl.includes('extension')) {
                    continue;
                }

                try {
                    // Tìm Accept button với nhiều selectors
                    const acceptSelectors = [
                        'button:has-text("Accept")',
                        '[aria-label*="Accept" i]',
                        '[title*="Accept" i]',
                        'button[class*="accept" i]',
                        '.accept-button',
                        '[data-action="accept"]'
                    ];

                    let acceptBtn = null;
                    for (const sel of acceptSelectors) {
                        try {
                            acceptBtn = await frame.$(sel);
                            if (acceptBtn) {
                                console.log(`✅ CDP: Found Accept button with: ${sel}`);
                                break;
                            }
                        } catch (e) { }
                    }

                    // Fallback: tìm bằng text content
                    if (!acceptBtn) {
                        acceptBtn = await frame.evaluateHandle(() => {
                            const buttons = document.querySelectorAll('button, [role="button"]');
                            for (const btn of buttons) {
                                const text = btn.textContent?.toLowerCase() || '';
                                if (text.includes('accept') || text.includes('chấp nhận')) {
                                    return btn;
                                }
                            }
                            return null;
                        });
                        if (acceptBtn && acceptBtn.asElement()) {
                            acceptBtn = acceptBtn.asElement();
                        } else {
                            acceptBtn = null;
                        }
                    }

                    if (acceptBtn) {
                        await acceptBtn.click();
                        console.log('✅ CDP: Accept button clicked!');
                        return { success: true, method: 'click' };
                    }
                } catch (e) { }
            }

            // Fallback: dùng keyboard shortcut
            console.log('⚠️ CDP: Accept button not found, using keyboard shortcut...');
            return await this.sendAcceptShortcut();

        } catch (e) {
            console.error('❌ CDP Accept Click Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * 🔴 Reject by CDP Click (KHÔNG cần Extension)
     * Tìm và click trực tiếp vào nút Reject trong chat panel
     */
    async rejectByClick() {
        if (!this.page) return { success: false, error: 'Not connected to Antigravity' };

        try {
            console.log('🔴 CDP: Rejecting by click...');

            const frames = this.page.frames();

            for (const frame of frames) {
                const frameUrl = frame.url();
                if (!frameUrl || frameUrl === 'about:blank') continue;

                if (!frameUrl.includes('cascade-panel') &&
                    !frameUrl.includes('agentPanel') &&
                    !frameUrl.includes('webview') &&
                    !frameUrl.includes('extension')) {
                    continue;
                }

                try {
                    // Tìm Reject button với nhiều selectors
                    const rejectSelectors = [
                        'button:has-text("Reject")',
                        '[aria-label*="Reject" i]',
                        '[title*="Reject" i]',
                        'button[class*="reject" i]',
                        '.reject-button',
                        '[data-action="reject"]'
                    ];

                    let rejectBtn = null;
                    for (const sel of rejectSelectors) {
                        try {
                            rejectBtn = await frame.$(sel);
                            if (rejectBtn) {
                                console.log(`✅ CDP: Found Reject button with: ${sel}`);
                                break;
                            }
                        } catch (e) { }
                    }

                    // Fallback: tìm bằng text content
                    if (!rejectBtn) {
                        rejectBtn = await frame.evaluateHandle(() => {
                            const buttons = document.querySelectorAll('button, [role="button"]');
                            for (const btn of buttons) {
                                const text = btn.textContent?.toLowerCase() || '';
                                if (text.includes('reject') || text.includes('từ chối')) {
                                    return btn;
                                }
                            }
                            return null;
                        });
                        if (rejectBtn && rejectBtn.asElement()) {
                            rejectBtn = rejectBtn.asElement();
                        } else {
                            rejectBtn = null;
                        }
                    }

                    if (rejectBtn) {
                        await rejectBtn.click();
                        console.log('✅ CDP: Reject button clicked!');
                        return { success: true, method: 'click' };
                    }
                } catch (e) { }
            }

            // Fallback: dùng keyboard shortcut
            console.log('⚠️ CDP: Reject button not found, using keyboard shortcut...');
            return await this.sendRejectShortcut();

        } catch (e) {
            console.error('❌ CDP Reject Click Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * ⏹️ Stop Generation by CDP Click
     * Click vào nút Stop khi AI đang generate
     */
    async stopGeneration() {
        if (!this.page) return { success: false, error: 'Not connected to Antigravity' };

        try {
            console.log('⏹️ CDP: Stopping generation...');

            const stopSelectors = [
                '[data-tooltip-id="input-send-button-cancel-tooltip"]',
                '.bg-red-500.rounded-xs',
                'div.bg-red-500',
                '[aria-label*="Stop" i]',
                '[aria-label*="Cancel" i]',
                '[title*="Stop" i]',
                'button[class*="stop" i]',
                '.stop-button',
                '[data-action="stop"]',
                '[data-action="cancel"]'
            ];

            // Try cachedChatFrame first, then scan all pages
            const framesToTry = [];
            if (this.cachedChatFrame) framesToTry.push(this.cachedChatFrame);

            // Add all frames from all browser pages
            let allPages = [];
            if (this.browser) {
                try { allPages = await this.browser.pages(); } catch (e) { if (this.page) allPages = [this.page]; }
            } else if (this.page) {
                allPages = [this.page];
            }
            for (const pg of allPages) {
                try {
                    const pgUrl = pg.url();
                    if (!pgUrl || pgUrl.includes('about:blank') || pgUrl.includes('devtools')) continue;
                    const frames = pg.frames();
                    for (const f of frames) {
                        if (!framesToTry.includes(f)) framesToTry.push(f);
                    }
                } catch (e) { }
            }

            for (const frame of framesToTry) {
                try {
                    // Try CSS selectors
                    let stopBtn = null;
                    for (const sel of stopSelectors) {
                        try {
                            stopBtn = await frame.$(sel);
                            if (stopBtn) {
                                console.log(`✅ CDP: Found Stop button with: ${sel}`);
                                break;
                            }
                        } catch (e) { }
                    }

                    // Fallback: find by text
                    if (!stopBtn) {
                        stopBtn = await frame.evaluateHandle(() => {
                            const buttons = document.querySelectorAll('button, [role="button"]');
                            for (const btn of buttons) {
                                const text = btn.textContent?.toLowerCase() || '';
                                const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
                                if (text.includes('stop') || text.includes('cancel') ||
                                    text.includes('dừng') || ariaLabel.includes('stop')) {
                                    return btn;
                                }
                            }
                            return null;
                        });
                        if (stopBtn && stopBtn.asElement()) {
                            stopBtn = stopBtn.asElement();
                        } else {
                            stopBtn = null;
                        }
                    }

                    if (stopBtn) {
                        await stopBtn.click();
                        console.log('✅ CDP: Stop button clicked!');
                        return { success: true, method: 'button-click' };
                    }
                } catch (e) { }
            }

            // Fallback 1: Send Escape to cachedChatFrame
            console.log('⚠️ CDP: Stop button not found, trying Escape...');
            const escFrame = this.cachedChatFrame || this.page;
            if (escFrame) {
                try {
                    await escFrame.click('body').catch(() => { });
                    await new Promise(r => setTimeout(r, 100));
                    await this.page.keyboard.press('Escape');
                    console.log('✅ CDP: Escape sent to chat frame');
                } catch (e) { }
            }

            // Fallback 2: Gửi Ctrl+C (interrupt signal)
            try {
                await this.page.keyboard.down('Control');
                await this.page.keyboard.press('KeyC');
                await this.page.keyboard.up('Control');
                console.log('✅ CDP: Ctrl+C sent!');
            } catch (e) { }

            // Fallback 3: Multiple Escape presses
            try {
                await this.page.keyboard.press('Escape');
                await new Promise(r => setTimeout(r, 200));
                await this.page.keyboard.press('Escape');
                console.log('✅ CDP: Double Escape sent!');
            } catch (e) { }

            return { success: true, method: 'escape-fallback', note: 'Sent escape/ctrl+c, check if generation stopped' };

        } catch (e) {
            console.error('❌ CDP Stop Generation Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * 🗂️ Get Conversation List from sidebar buttons
     * Reads the sidebar conversation list (button[title] with hover:bg-gray-500/10 class)
     */
    async getConversations() {
        if (!this.page) return { success: false, error: 'Not connected to Antigravity' };

        try {
            console.log('🗂️ CDP: Getting conversation list from sidebar...');

            const extractFromFrame = async (frame) => {
                try {
                    return await frame.evaluate(() => {
                        // Sidebar conversation buttons: button[title] with hover:bg-gray-500/10
                        const buttons = document.querySelectorAll('button[title].group');
                        const convs = [];
                        for (const btn of buttons) {
                            const title = btn.getAttribute('title');
                            if (!title || title.length < 2) continue;
                            // Skip buttons that are not conversation items (e.g., toolbar buttons)
                            if (!btn.classList.contains('grow')) continue;

                            // Get time text (e.g. "4m", "1 day ago")
                            const timeParagraph = btn.querySelector('p.text-nowrap');
                            const time = timeParagraph ? timeParagraph.textContent.trim() : '';

                            // Get conversation ID from delete button's data-tooltip-id
                            // Pattern: "{conversationId}-delete-conversation"
                            const deleteBtn = btn.querySelector('[data-tooltip-id$="-delete-conversation"]');
                            const tooltipId = deleteBtn ? deleteBtn.getAttribute('data-tooltip-id') : '';
                            const convId = tooltipId ? tooltipId.replace('-delete-conversation', '') : '';

                            // Check if this is the current conversation (active styling)
                            const isCurrent = btn.classList.contains('bg-list-active-selection-background') ||
                                btn.getAttribute('aria-selected') === 'true' ||
                                btn.style.backgroundColor !== '';

                            convs.push({ title, time, id: convId, isCurrent });
                        }
                        return convs;
                    });
                } catch (e) { return null; }
            };

            // Try cachedChatFrame first, then scan all pages/frames
            let convs = null;
            if (this.cachedChatFrame) {
                convs = await extractFromFrame(this.cachedChatFrame);
            }
            if (!convs || convs.length === 0) {
                let allPages = [];
                try { allPages = await this.browser.pages(); } catch (e) { allPages = [this.page]; }
                for (const pg of allPages) {
                    for (const frame of pg.frames()) {
                        try {
                            const result = await extractFromFrame(frame);
                            if (result && result.length > 0) { convs = result; break; }
                        } catch (e) { }
                    }
                    if (convs && convs.length > 0) break;
                }
            }

            if (!convs || convs.length === 0) {
                return { success: false, error: 'Không tìm thấy cuộc trò chuyện nào trong sidebar' };
            }

            console.log(`🗂️ CDP: Found ${convs.length} conversations`);
            return { success: true, data: convs };

        } catch (e) {
            console.error('❌ CDP getConversations Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * 🔄 Switch to a conversation by clicking its sidebar button
     */
    async switchConversation(titleSnippet) {
        if (!this.page) return { success: false, error: 'Not connected to Antigravity' };

        try {
            console.log(`🔄 CDP: Switching to conversation matching: "${titleSnippet}"`);

            const clickInFrame = async (frame) => {
                try {
                    return await frame.evaluate((snippet) => {
                        const buttons = document.querySelectorAll('button[title].group');
                        for (const btn of buttons) {
                            if (!btn.classList.contains('grow')) continue;
                            const title = btn.getAttribute('title') || '';

                            // Get ID from delete button
                            const deleteBtn = btn.querySelector('[data-tooltip-id$="-delete-conversation"]');
                            const tooltipId = deleteBtn ? deleteBtn.getAttribute('data-tooltip-id') : '';
                            const id = tooltipId ? tooltipId.replace('-delete-conversation', '') : '';

                            // Match either exactly by ID or sub-match by title
                            if (id === snippet || title.toLowerCase().includes(snippet.toLowerCase())) {
                                btn.click();
                                return { found: true, title };
                            }
                        }
                        return { found: false };
                    }, titleSnippet);
                } catch (e) { return null; }
            };

            // Try cachedChatFrame first
            let result = null;
            if (this.cachedChatFrame) {
                result = await clickInFrame(this.cachedChatFrame);
            }
            if (!result?.found) {
                let allPages = [];
                try { allPages = await this.browser.pages(); } catch (e) { allPages = [this.page]; }
                for (const pg of allPages) {
                    for (const frame of pg.frames()) {
                        try {
                            const r = await clickInFrame(frame);
                            if (r?.found) { result = r; break; }
                        } catch (e) { }
                    }
                    if (result?.found) break;
                }
            }

            if (!result?.found) {
                return { success: false, error: `Không tìm thấy conversation chứa: "${titleSnippet}"` };
            }

            console.log(`✅ CDP: Switched to conversation: "${result.title}"`);
            return { success: true, title: result.title };

        } catch (e) {
            console.error('❌ CDP switchConversation Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * 📊 Get Current State (model, pending actions, streaming status)
     * Đọc trạng thái hiện tại từ DOM
     */
    async getCurrentState() {
        if (!this.page) return { success: false, error: 'Not connected to Antigravity' };

        try {
            console.log('📊 CDP: Getting current state...');

            const frames = this.page.frames();

            for (const frame of frames) {
                const frameUrl = frame.url();
                if (!frameUrl || frameUrl === 'about:blank') continue;

                if (!frameUrl.includes('cascade-panel') &&
                    !frameUrl.includes('agentPanel') &&
                    !frameUrl.includes('webview') &&
                    !frameUrl.includes('extension')) {
                    continue;
                }

                try {
                    const state = await frame.evaluate(() => {
                        // Tìm model hiện tại
                        const modelBtn = document.querySelector('button[class*="model"], [aria-label*="model" i]');
                        const currentModel = modelBtn?.textContent?.trim() || 'Unknown';

                        // Đếm pending actions (Accept/Reject buttons visible)
                        const acceptBtns = document.querySelectorAll('button:has-text("Accept"), [aria-label*="Accept"]');
                        const pendingActions = acceptBtns.length;

                        // Kiểm tra đang streaming không
                        const stopBtn = document.querySelector('button:has-text("Stop"), [aria-label*="Stop"]');
                        const isStreaming = !!stopBtn;

                        // Đếm messages
                        const messages = document.querySelectorAll('[class*="message"], [class*="chat"]');

                        return {
                            currentModel,
                            pendingActions,
                            isStreaming,
                            messageCount: messages.length
                        };
                    });

                    if (state) {
                        console.log(`📊 CDP: State = Model: ${state.currentModel}, Pending: ${state.pendingActions}, Streaming: ${state.isStreaming}`);
                        return { success: true, ...state };
                    }
                } catch (e) { }
            }

            return { success: false, error: 'Could not get state' };

        } catch (e) {
            console.error('❌ CDP Get State Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * 📖 Get last AI response text via CDP
     * Strategy: Find the transcript container (gap-y-3) and extract the LAST message's text
     * Works for ALL message types - doesn't depend on specific CSS classes
     */
    async getLastAIResponse() {
        if (!this.browser && !this.page) return null;

        // Helper: evaluate extraction logic in a single frame
        const extractFromFrame = async (frame) => {
            return frame.evaluate(() => {
                // Convert tables to blocks
                function htmlTableToBlocks(tableEl) {
                    const rows = [];
                    for (const tr of tableEl.querySelectorAll('tr')) {
                        const cells = [];
                        for (const td of tr.querySelectorAll('th, td')) {
                            cells.push((td.innerText || '').trim());
                        }
                        rows.push(cells);
                    }
                    if (rows.length === 0) return '';
                    const headers = rows[0];
                    const dataRows = rows.slice(1);
                    if (dataRows.length === 0) return headers.join(' | ');
                    const blocks = [];
                    for (const row of dataRows) {
                        const lines = [];
                        for (let i = 0; i < row.length; i++) {
                            const label = headers[i] || 'Col' + (i + 1);
                            const value = row[i] || '';
                            if (value) lines.push('  ' + label + ': ' + value);
                        }
                        if (lines.length > 0) {
                            blocks.push('\ud83d\udccc ' + (row[0] || '') + '\n' + lines.slice(1).join('\n'));
                        }
                    }
                    return blocks.join('\n\n');
                }

                function elementToText(container) {
                    const clone = container.cloneNode(true);
                    clone.querySelectorAll('script, style, .thinking-content').forEach(n => n.remove());
                    const tables = clone.querySelectorAll('table');
                    tables.forEach(table => {
                        const textBlocks = htmlTableToBlocks(table);
                        const pre = document.createElement('pre');
                        pre.textContent = textBlocks;
                        table.replaceWith(pre);
                    });
                    return (clone.innerText || '').trim();
                }

                // Capture thinking, task progress, and response SEPARATELY
                let thinkingText = '';
                let taskProgressText = ''; // only the LAST task progress
                let responseText = '';
                let responseHtml = '';
                const allBlocks = document.querySelectorAll('.leading-relaxed.select-text');
                const blockCount = allBlocks.length;

                for (const block of allBlocks) {
                    const cls = block.className || '';

                    if (cls.includes('opacity-70')) {
                        // Thinking block
                        const clone = block.cloneNode(true);
                        clone.querySelectorAll('script, style').forEach(n => n.remove());
                        thinkingText = (clone.innerText || '').trim();
                    } else if (block.closest('.isolate')) {
                        // Inside task boundary — skip here, we capture full container below
                    } else {
                        // Main response — overwrite = LAST one only
                        responseText = elementToText(block);
                        responseHtml = block.innerHTML;
                    }
                }

                // Capture task boundary info with TARGETED extraction (avoids CSS/canvas noise)
                const isolateContainers = document.querySelectorAll('.isolate.mb-2');
                const progressParts = [];
                for (const container of isolateContainers) {
                    const parts = [];
                    // 1) Task Name
                    const taskName = container.querySelector('.font-semibold');
                    if (taskName) parts.push('📌 ' + taskName.textContent.trim());

                    // 2) Task Summary (first paragraph in the header area)
                    const headerArea = container.querySelector('.flex.flex-col');
                    if (headerArea) {
                        const summaryP = headerArea.querySelector('p');
                        if (summaryP) parts.push(summaryP.textContent.trim());
                    }

                    // 3) Progress step statuses + command outputs
                    const progressArea = container.querySelector('[class*="overflow-y-auto"]');
                    if (progressArea) {
                        // Get numbered step headers
                        const stepHeaders = progressArea.querySelectorAll('.sticky');
                        for (const header of stepHeaders) {
                            const stepNum = header.querySelector('.text-xs');
                            const stepText = header.querySelector('p');
                            if (stepNum && stepText) {
                                parts.push('  [' + stepNum.textContent.trim() + '] ' + stepText.textContent.trim());
                            }
                        }
                        // Get command outputs from pre tags (not xterm canvas)
                        const outputs = progressArea.querySelectorAll('pre > div, pre.whitespace-pre-wrap > div');
                        for (const out of outputs) {
                            const text = (out.textContent || '').trim();
                            if (text.length > 5 && text.length < 500) {
                                parts.push('  > ' + text.replace(/\n/g, '\n  > '));
                            }
                        }
                    }

                    if (parts.length > 0) {
                        progressParts.push(parts.join('\n'));
                    }
                }
                if (progressParts.length > 0) {
                    taskProgressText = progressParts.join('\n\n---\n\n');
                }

                // Return all 3 fields separately
                if (responseText.length >= 10 || taskProgressText.length >= 10 || thinkingText.length >= 10) {
                    return {
                        text: responseText,
                        rawHtml: responseHtml,
                        thinking: thinkingText,
                        taskProgress: taskProgressText,
                        strategy: responseText.length >= 10 ? 'response' : (taskProgressText.length >= 10 ? 'task-progress' : 'thinking'),
                        blockCount
                    };
                }

                // Fallback: .notify-user-container
                const notifyContainers = document.querySelectorAll('.notify-user-container');
                if (notifyContainers.length > 0) {
                    const last = notifyContainers[notifyContainers.length - 1];
                    const text = elementToText(last);
                    const rawHtml = last.innerHTML;
                    if (text.length >= 10) return { text, rawHtml, thinking: thinkingText, taskProgress: taskProgressText, strategy: 'notify', blockCount };
                }

                return { blockCount, noMatch: true };
            }).catch(e => ({ error: e.message }));
        };

        try {
            let bestText = '';
            let bestLen = 0;
            let bestThinking = '';
            let bestProgress = '';
            let bestResult = null;

            // Helper: check if a result has ANY useful content
            const resultScore = (r) => {
                if (!r) return 0;
                return (r.text || '').length + (r.taskProgress || '').length + (r.thinking || '').length;
            };

            // ===== PRIORITY 1: Use cachedChatFrame (already confirmed to contain chat) =====
            if (this.cachedChatFrame) {
                try {
                    const result = await extractFromFrame(this.cachedChatFrame);
                    const score = resultScore(result);
                    if (score >= 10) {
                        console.log(`📖 getLastAI: Found via cachedChatFrame! strategy=${result.strategy}, text=${(result.text || '').length}, progress=${(result.taskProgress || '').length}, thinking=${(result.thinking || '').length}`);
                        bestText = result.text || '';
                        bestThinking = result.thinking || '';
                        bestProgress = result.taskProgress || '';
                        bestLen = score;
                        bestResult = result;
                    } else {
                        console.log(`📖 getLastAI: cachedChatFrame returned: blocks=${result?.blockCount}, noMatch=${result?.noMatch}, error=${result?.error || 'none'}`);
                    }
                } catch (e) {
                    console.log(`📖 getLastAI: cachedChatFrame failed: ${e.message}`);
                }
            }

            // ===== PRIORITY 2: Scan all pages/frames =====
            if (bestLen < 10) {
                let allPages = [];
                if (this.browser) {
                    try { allPages = await this.browser.pages(); } catch (e) { if (this.page) allPages = [this.page]; }
                } else if (this.page) {
                    allPages = [this.page];
                }

                for (const pg of allPages) {
                    try {
                        const pgUrl = pg.url();
                        if (!pgUrl || pgUrl.includes('about:blank') || pgUrl.includes('devtools')) continue;

                        const frames = pg.frames();
                        for (const frame of frames) {
                            try {
                                const frameUrl = frame.url();
                                if (!frameUrl || frameUrl === 'about:blank') continue;

                                const result = await extractFromFrame(frame);
                                const score = resultScore(result);
                                if (score > bestLen && score >= 10) {
                                    bestLen = score;
                                    bestText = result.text || '';
                                    bestThinking = result.thinking || '';
                                    bestProgress = result.taskProgress || '';
                                    bestResult = result;
                                }
                            } catch (e) { /* skip frame */ }
                        }
                    } catch (e) { /* skip page */ }
                }

                if (bestResult) {
                    console.log(`📖 getLastAI: Found via scan! strategy=${bestResult.strategy}, text=${bestText.length}, progress=${bestProgress.length}, thinking=${bestThinking.length}`);
                }
            }

            // ===== Dump debug and return =====
            if (bestResult) {
                try {
                    const fs = require('fs');
                    const path = require('path');
                    const debugDir = path.join(__dirname, '../../Data');
                    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
                    const debugFile = path.join(debugDir, 'debug_response_html.txt');
                    const debugContent = [
                        `=== DEBUG: AI Response HTML ===`,
                        `Timestamp: ${new Date().toISOString()}`,
                        `Strategy: ${bestResult.strategy}`,
                        `Text length: ${bestText.length}`,
                        `TaskProgress length: ${bestProgress.length}`,
                        `Thinking length: ${bestThinking.length}`,
                        ``,
                        `=== THINKING ===`,
                        bestThinking || '(none)',
                        ``,
                        `=== TASK PROGRESS ===`,
                        bestProgress || '(none)',
                        ``,
                        `=== EXTRACTED TEXT ===`,
                        bestText || '(none)',
                    ].join('\n');
                    fs.writeFileSync(debugFile, debugContent, 'utf8');
                    console.log(`📄 Debug HTML dumped to: ${debugFile}`);
                } catch (dumpErr) {
                    console.log(`⚠️ Debug dump failed: ${dumpErr.message}`);
                }

                return { text: bestText, thinking: bestThinking, taskProgress: bestProgress };
            }

            return null;

        } catch (e) {
            console.error('❌ getLastAIResponse error:', e.message);
        }

        return null;
    }

    /**
     * 📋 Change Conversation Mode (Planning/Fast) via CDP DOM Click
     * Click vào mode picker và chọn mode mong muốn
     * @param {string} modeName - "Planning" hoặc "Fast"
     */
    async changeConvMode(modeName) {
        if (!this.page) return { success: false, error: 'Not connected to Antigravity' };

        try {
            console.log(`📋 CDP: Changing conversation mode to: ${modeName}...`);

            const frames = this.page.frames();

            for (const frame of frames) {
                const frameUrl = frame.url();
                if (!frameUrl || frameUrl === 'about:blank') continue;

                // Tìm trong các frame có thể chứa chat panel
                if (!frameUrl.includes('cascade-panel') &&
                    !frameUrl.includes('agentPanel') &&
                    !frameUrl.includes('webview') &&
                    !frameUrl.includes('extension')) {
                    continue;
                }

                try {
                    // Step 1: Tìm và click vào mode picker (nút hiển thị mode hiện tại)
                    // Có thể có text "Fast" hoặc "Planning"
                    const modePickerSelectors = [
                        'button:has-text("Fast")',
                        'button:has-text("Planning")',
                        '[aria-label*="mode" i]',
                        '[aria-label*="Mode" i]',
                        'button[class*="mode"]',
                        '.mode-picker',
                        '.conversation-mode'
                    ];

                    let modeBtn = null;
                    for (const sel of modePickerSelectors) {
                        try {
                            modeBtn = await frame.$(sel);
                            if (modeBtn) {
                                console.log(`✅ CDP: Found mode picker with: ${sel}`);
                                break;
                            }
                        } catch (e) { }
                    }

                    // Fallback: tìm bằng text
                    if (!modeBtn) {
                        modeBtn = await frame.evaluateHandle(() => {
                            const buttons = document.querySelectorAll('button, [role="button"]');
                            for (const btn of buttons) {
                                const text = btn.textContent?.toLowerCase() || '';
                                if (text.includes('fast') || text.includes('planning') || text.includes('mode')) {
                                    return btn;
                                }
                            }
                            return null;
                        });
                        if (modeBtn && modeBtn.asElement()) {
                            modeBtn = modeBtn.asElement();
                        } else {
                            modeBtn = null;
                        }
                    }

                    if (!modeBtn) {
                        console.log('⚠️ CDP: Mode picker not found in this frame');
                        continue;
                    }

                    // Click mode picker để mở dropdown
                    console.log('🖱️ CDP: Clicking mode picker...');
                    await modeBtn.click();
                    await new Promise(resolve => setTimeout(resolve, 500));

                    // Step 2: Tìm và click vào mode option (Planning hoặc Fast)
                    const targetMode = modeName.toLowerCase();

                    const modeElements = await frame.$$('div, span, button, li');
                    console.log(`🔍 CDP: Found ${modeElements.length} elements to search for mode`);

                    for (const el of modeElements) {
                        try {
                            const text = await el.evaluate(node => node.textContent?.trim() || '');

                            if (text.length > 2 && text.length < 100) {
                                const lowerText = text.toLowerCase();

                                if (lowerText.includes(targetMode)) {
                                    console.log(`🎯 CDP: Found mode option: "${text}"`);
                                    await el.click();
                                    console.log(`✅ CDP: Clicked on "${text}"`);
                                    return { success: true, mode: modeName };
                                }
                            }
                        } catch (e) { }
                    }

                    console.log(`⚠️ CDP: Mode "${modeName}" not found in dropdown`);

                } catch (frameError) {
                    console.log(`⚠️ CDP: Frame error: ${frameError.message}`);
                }
            }

            return { success: false, error: `Could not find mode picker or "${modeName}" option` };

        } catch (e) {
            console.error('❌ CDP Change Conv Mode Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * 🔄 Switch sang model tiếp theo (Next Model)
     * Sử dụng Antigravity command: workbench.action.chat.switchToNextModel
     */
    async switchToNextModel() {
        if (!this.page) return { success: false, error: 'Not connected to Antigravity' };

        try {
            console.log('🔄 CDP: Switching to next model...');

            // Execute Antigravity command via CDP
            await this.page.evaluate(() => {
                // @ts-ignore - Antigravity global API
                if (typeof vscode !== 'undefined') {
                    vscode.commands.executeCommand('workbench.action.chat.switchToNextModel');
                }
            });

            console.log('✅ CDP: Switched to next model!');
            return { success: true };
        } catch (e) {
            console.error('❌ CDP Switch Model Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    // ============================================================
    // 🗂️ CONVERSATION & PROJECT MANAGEMENT (v3.1.0)
    // ============================================================


    /**
     * 📂 Mở Project Folder (VS Code Command)
     * @param {string} pathStr - Absolute path to folder
     */
    async openProjectFolder(pathStr) {
        if (!this.page) return { success: false, error: 'Not connected' };

        try {
            console.log(`📂 CDP: Opening project folder: ${pathStr}`);

            // Try main page first
            let executed = await this.page.evaluate((p) => {
                // @ts-ignore
                if (typeof vscode !== 'undefined' && vscode.commands) {
                    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: false });
                    return true;
                }
                return false;
            }, pathStr);

            if (executed) {
                console.log('✅ CDP: Open folder command sent (Main Frame)');
                return { success: true };
            }

            // Method 2: Try AMD require for 'vscode' or internal modules
            try {
                executed = await this.page.evaluate(async (p) => {
                    try {
                        // @ts-ignore
                        if (typeof window.require !== 'undefined') {
                            return new Promise((resolve) => {
                                // @ts-ignore
                                window.require(['vscode'], (vscode) => {
                                    if (vscode && vscode.commands) {
                                        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: false });
                                        resolve(true);
                                    } else {
                                        resolve(false);
                                    }
                                }, (err) => resolve(false));
                            });
                        }
                    } catch (e) { return false; }
                    return false;
                }, pathStr);

                if (executed) {
                    console.log('✅ CDP: Open folder command sent (AMD require)');
                    return { success: true };
                }
            } catch (e) { /* ignore AMD error */ }

            // Try all frames
            const frames = this.page.frames();
            for (const frame of frames) {
                try {
                    executed = await frame.evaluate((p) => {
                        // @ts-ignore
                        if (typeof vscode !== 'undefined' && vscode.commands) {
                            // @ts-ignore
                            vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: false });
                            return true;
                        }
                        return false;
                    }, pathStr);

                    if (executed) {
                        console.log(`✅ CDP: Open folder command sent (Frame: ${frame.url()})`);
                        return { success: true };
                    }
                } catch (frameErr) {
                    // Check if frame destroyed (good sign of reload)
                    if (frameErr.message.includes('Execution context was destroyed') || frameErr.message.includes('Target closed')) {
                        console.log('✅ CDP: Frame destroyed (likely reloading)...');
                        return { success: true };
                    }
                }
            }

            console.log('⚠️ CDP: vscode.commands API not found in any frame');
            return { success: false, error: 'vscode.commands API not found in any frame' };
        } catch (e) {
            // Check for navigation/reload errors which indicate command worked
            if (e.message.includes('Execution context was destroyed') ||
                e.message.includes('Target closed') ||
                e.message.includes('Session closed')) {
                console.log('✅ CDP: Disconnected (Window Reloading)...');
                return { success: true };
            }

            console.error('❌ CDP Open Project Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * 📍 Lấy đường dẫn Project hiện tại
     */
    async getCurrentProjectRoot() {
        if (!this.page) return null;

        try {
            // Try main page first
            let rootPath = await this.page.evaluate(() => {
                // @ts-ignore
                try {
                    if (typeof vscode !== 'undefined') {
                        if (vscode.workspace && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                            return vscode.workspace.workspaceFolders[0].uri.fsPath;
                        }
                        // vscode exists but no workspace
                        return 'NO_WORKSPACE';
                    }
                } catch (e) { return 'ERROR_' + e.message; }
                return null;
            });

            if (rootPath === 'NO_WORKSPACE') {
                console.log('⚠️ Main Frame: vscode API exists but no workspace open.');
            } else if (rootPath && !rootPath.startsWith('ERROR_') && rootPath !== 'NO_WORKSPACE') {
                // console.log('✅ Found root in Main Frame:', rootPath);
                return rootPath;
            }

            // Try frames
            const frames = this.page.frames();
            for (const frame of frames) {
                rootPath = await frame.evaluate(() => {
                    // @ts-ignore
                    try {
                        if (typeof vscode !== 'undefined') {
                            if (vscode.workspace && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                                return vscode.workspace.workspaceFolders[0].uri.fsPath;
                            }
                            return 'NO_WORKSPACE';
                        }
                    } catch (e) { return 'ERROR_' + e.message; }
                    return null;
                });

                if (rootPath && !rootPath.startsWith('ERROR_') && rootPath !== 'NO_WORKSPACE') {
                    // console.log(`✅ Found root in Frame ${frame.url()}: ${rootPath}`);
                    return rootPath;
                }
            }

            console.error('❌ getCurrentProjectRoot: Failed to find project root in any frame (vscode API missing or no workspace).');
            return null;
        } catch (e) {
            console.error('❌ getCurrentProjectRoot exception:', e.message);
            return null;
        }
    }

    /**
     * 🎯 Fetch available models from the dropdown UI
     * Updated for new Antigravity UI: button[aria-label^="Select model"] + button dropdown items
     */
    async getModels() {
        if (!this.page) return { success: false, error: 'Not connected' };

        try {
            console.log('🎯 CDP: Fetching available models...');

            const scanDropdown = async (frame) => {
                try {
                    return await frame.evaluate(() => {
                        const logs = [];
                        logs.push("Scanning frame for model trigger");

                        let trigger = null;

                        // Strategy 1: Find button with aria-label="Select model, current: ..."
                        const selectModelBtns = document.querySelectorAll('button[aria-label^="Select model"]');
                        logs.push(`Found ${selectModelBtns.length} buttons with aria-label^="Select model"`);
                        for (const btn of selectModelBtns) {
                            const rect = btn.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) {
                                trigger = btn;
                                logs.push(`Found trigger via aria-label: "${btn.getAttribute('aria-label')}"`);
                                break;
                            }
                        }

                        // Strategy 2: Find button with chevron-up SVG + model name span
                        if (!trigger) {
                            const chevrons = document.querySelectorAll('svg.lucide-chevron-up');
                            logs.push(`Fallback: Found ${chevrons.length} chevron-up SVGs`);
                            for (const svg of chevrons) {
                                const wrapper = svg.closest('button') || svg.closest('[role="button"]');
                                if (wrapper) {
                                    const textSpan = wrapper.querySelector('span.opacity-70') || wrapper.querySelector('span');
                                    if (textSpan && textSpan.textContent.trim().length > 2) {
                                        trigger = wrapper;
                                        logs.push(`Found trigger via chevron: "${textSpan.textContent.trim()}"`);
                                        break;
                                    }
                                }
                            }
                        }

                        if (!trigger) {
                            logs.push("Could not find any suitable trigger.");
                            return { found: false, logs };
                        }

                        try {
                            trigger.click();
                            logs.push("Clicked trigger.");
                        } catch (e) {
                            logs.push("Error clicking trigger: " + e.message);
                        }

                        return { found: true, logs };
                    });
                } catch (e) {
                    return { found: false, logs: ['Evaluate error: ' + e.message] };
                }
            };

            let TargetFrame = null;
            let scanResult = null;

            if (this.cachedChatFrame) {
                scanResult = await scanDropdown(this.cachedChatFrame);
                if (scanResult && scanResult.found) TargetFrame = this.cachedChatFrame;
                else console.log('Cached frame scan logs:', scanResult?.logs || scanResult);
            }
            if (!TargetFrame) {
                const frames = this.page.frames();
                for (const frame of frames) {
                    scanResult = await scanDropdown(frame);
                    if (scanResult && scanResult.found) {
                        TargetFrame = frame;
                        break;
                    } else if (scanResult && scanResult.logs && scanResult.logs.length > 1) {
                        console.log(`Failed frame scan logs (${frame.url()}):`, scanResult.logs);
                    }
                }
            }

            if (!TargetFrame) return { success: false, error: 'Model dropdown trigger not found' };

            // Wait for dropdown to render
            await new Promise(r => setTimeout(r, 500));

            // 2. Extract models from the dropdown popup
            const models = await TargetFrame.evaluate(() => {
                const results = [];

                // New UI: dropdown items are <button> elements with <span class="text-xs font-medium"><span>Model Name</span></span>
                // The active model has data-autofocus="true" and bg-gray-500/20 class
                const items = document.querySelectorAll('button[data-autofocus] span.text-xs.font-medium > span');

                items.forEach((nameSpan, idx) => {
                    const name = nameSpan.textContent.trim();
                    if (name && name.length > 2) {
                        // Check if this is the active model
                        const parentBtn = nameSpan.closest('button[data-autofocus]');
                        const isActive = parentBtn?.getAttribute('data-autofocus') === 'true' ||
                                         parentBtn?.classList.contains('bg-gray-500/20');
                        results.push({ index: idx, name, isActive: !!isActive });
                    }
                });

                // Close dropdown: press Escape or click trigger again
                try {
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                    // Also try clicking the trigger to close
                    const trigger = document.querySelector('button[aria-label^="Select model"]');
                    if (trigger) trigger.click();
                } catch (e) { }

                return results;
            });

            if (models && models.length > 0) {
                console.log(`✅ CDP: Found ${models.length} models: ${models.map(m => m.name).join(', ')}`);
                return { success: true, models };
            }

            return { success: false, error: 'No models found in dropdown' };

        } catch (e) {
            console.error('❌ CDP Get Models Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * 🎨 Chuyển sang model cụ thể (bằng index hoặc tên)
     * Updated for new Antigravity UI: button[aria-label^="Select model"] + button[data-autofocus] items
     */
    async changeModel(target) {
        if (!this.page) return { success: false, error: 'Not connected to Antigravity' };

        try {
            console.log(`🎨 CDP: Changing model to target: ${target}`);

            const clickModel = async (frame, targetVal) => {
                try {
                    return await frame.evaluate(async (matchTarget) => {
                        const logs = [];

                        // 1. Open dropdown
                        const findTrigger = () => {
                            // Strategy 1: aria-label="Select model, current: ..."
                            const selectBtns = document.querySelectorAll('button[aria-label^="Select model"]');
                            for (const btn of selectBtns) {
                                const rect = btn.getBoundingClientRect();
                                if (rect.width > 0 && rect.height > 0) return btn;
                            }
                            // Strategy 2: chevron-up SVG fallback
                            const chevrons = document.querySelectorAll('svg.lucide-chevron-up');
                            for (const svg of chevrons) {
                                const wrapper = svg.closest('button') || svg.closest('[role="button"]');
                                if (wrapper) {
                                    const textSpan = wrapper.querySelector('span.opacity-70') || wrapper.querySelector('span');
                                    if (textSpan && textSpan.textContent.trim().length > 2) return wrapper;
                                }
                            }
                            return null;
                        };

                        const trigger = findTrigger();
                        if (!trigger) {
                            logs.push("Could not find trigger in changeModel");
                            return { found: false, reason: 'no_trigger', logs };
                        }

                        try { trigger.click(); } catch (e) { }

                        // Wait for dropdown to render
                        await new Promise(r => setTimeout(r, 400));

                        // 2. Find and click model in dropdown
                        // New UI: items are <button data-autofocus="..."> with <span class="text-xs font-medium"><span>Name</span></span>
                        const items = Array.from(document.querySelectorAll('button[data-autofocus]'));
                        let targetEl = null;

                        // Check if numeric index
                        const isIndex = typeof matchTarget === 'number' || (typeof matchTarget === 'string' && !isNaN(parseInt(matchTarget)) && matchTarget.length < 3);

                        if (isIndex) {
                            const idx = parseInt(matchTarget);
                            if (idx >= 0 && idx < items.length) targetEl = items[idx];
                        } else {
                            // Match by text (case insensitive, partial match allowed)
                            const cleanTarget = matchTarget.toLowerCase().replace(/[^a-z0-9]/g, '');

                            let bestScore = -1;
                            for (const item of items) {
                                const nameSpan = item.querySelector('span.text-xs.font-medium > span');
                                if (!nameSpan) continue;

                                const title = nameSpan.textContent.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
                                let score = 0;

                                if (title === cleanTarget) score = 100;
                                else if (title.includes(cleanTarget)) score = 50;
                                else if (cleanTarget.includes(title)) score = 30;

                                if (score > bestScore) {
                                    bestScore = score;
                                    targetEl = item;
                                }
                            }

                            if (bestScore <= 0) targetEl = null;
                        }

                        if (targetEl) {
                            const selectedName = targetEl.querySelector('span.text-xs.font-medium > span')?.textContent?.trim() || matchTarget;
                            targetEl.click();
                            return { found: true, selectedName };
                        }

                        // Close dropdown if not found
                        try {
                            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                            trigger.click();
                        } catch (e) { }
                        return { found: false, reason: 'no_match', logs };
                    }, targetVal);
                } catch (e) { return { found: false, reason: 'eval_error', logs: [e.message] }; }
            };

            let result = null;
            if (this.cachedChatFrame) {
                result = await clickModel(this.cachedChatFrame, target);
                if (!result || !result.found) console.log('changeModel cached frame logs:', result?.logs || result);
            }
            if (!result || !result.found) {
                const frames = this.page.frames();
                for (const frame of frames) {
                    result = await clickModel(frame, target);
                    if (result && result.found) break;
                    else if (result && result.logs && result.logs.length > 0) {
                        console.log(`changeModel failed frame logs (${frame.url()}):`, result.logs);
                    }
                }
            }

            if (result && result.found) {
                console.log(`✅ CDP: Switched to model: ${result.selectedName}`);
                return { success: true, model: result.selectedName };
            }

            return { success: false, error: 'Model selection failed' };
        } catch (e) {
            console.error('❌ CDP Error:', e);
            return { success: false, error: e.message };
        }
    }


    /**
     * Click vào toạ độ (x, y) thông qua CDP Input
     */
    async simulateClick(x, y) {
        if (!this.page) return false;
        try {
            console.log(`🖱️ CDP: Clicking at (${x}, ${y})...`);
            await this.page.mouse.click(x, y);
            return true;
        } catch (e) {
            console.error('❌ CDP Click Error:', e.message);
            return false;
        }
    }

    /**
     * Inject text trực tiếp vào ô chat thông qua CDP Frames API
     * Điều này bypass cross-origin restrictions mà chat_bridge_ws.js gặp phải
     * @param {string} text - Text cần inject vào ô chat
     * @param {boolean} [submit=true] - Có nhấn Enter để gửi hay chỉ inject text
     * @returns {object|false} - { injected: true, submitted: bool } hoặc false
     */
    async injectTextToChat(text, submit = true) {
        if (!this.page) return false;

        try {
            console.log(`📝 CDP: Injecting text to chat: "${text.substring(0, 50)}..."`);

            const chatSelectors = [
                '[data-lexical-editor="true"][contenteditable="true"]',
                '[contenteditable="true"][role="textbox"]',
                'textarea[placeholder*="type"]',
                'textarea[placeholder*="message"]',
                'textarea[placeholder*="chat"]',
                'textarea[placeholder*="Ask"]',
                'textarea:not(.xterm-helper-textarea)',
                '[contenteditable="true"]:not([class*="xterm"])'
            ];

            let chatInput = null;
            let frame = null;

            // PRIORITY 1: Try cachedChatFrame first
            if (this.cachedChatFrame) {
                for (const sel of chatSelectors) {
                    chatInput = await this.cachedChatFrame.$(sel);
                    if (chatInput) {
                        frame = this.cachedChatFrame;
                        console.log(`✅ CDP: Found input via cached frame: ${sel}`);
                        break;
                    }
                }
            }

            // PRIORITY 2: Scan ALL browser pages and their frames (same as getLastAIResponse)
            if (!chatInput) {
                let allPages = [];
                if (this.browser) {
                    try { allPages = await this.browser.pages(); } catch (e) { if (this.page) allPages = [this.page]; }
                } else if (this.page) {
                    allPages = [this.page];
                }

                console.log(`🔍 CDP inject: Scanning ${allPages.length} pages for chat input...`);

                for (const pg of allPages) {
                    if (chatInput) break;
                    try {
                        const pgUrl = pg.url();
                        if (!pgUrl || pgUrl.includes('about:blank') || pgUrl.includes('devtools')) continue;

                        const frames = pg.frames();
                        for (const f of frames) {
                            if (chatInput) break;
                            try {
                                const fUrl = f.url();
                                if (!fUrl || fUrl === 'about:blank') continue;

                                for (const sel of chatSelectors) {
                                    chatInput = await f.$(sel);
                                    if (chatInput) {
                                        frame = f;
                                        this.cachedChatFrame = f; // Cache for future use
                                        console.log(`✅ CDP: Found input in frame: ${fUrl.substring(0, 60)}, selector: ${sel}`);
                                        break;
                                    }
                                }
                            } catch (e) { /* skip frame */ }
                        }
                    } catch (e) { /* skip page */ }
                }
            }

            if (!chatInput || !frame) {
                console.log('⚠️ CDP: No chat input found in any page/frame');
                return false;
            }

            // 1. Click input to focus
            await chatInput.click();
            await new Promise(r => setTimeout(r, 100));

            // 2. Clear existing text
            await this.page.keyboard.down('Control');
            await this.page.keyboard.press('KeyA');
            await this.page.keyboard.up('Control');
            await this.page.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 50));

            // 3. Insert text
            await frame.evaluate((txt) => {
                const input = document.activeElement;
                if (input && (input.tagName === 'TEXTAREA' || input.isContentEditable)) {
                    if (input.isContentEditable) {
                        // Tạo sự kiện paste giả lập để bắt các trình soạn thảo xịn (như Lexical/Monaco) nhận diện xuống dòng (\n)
                        const pasteEvent = new ClipboardEvent('paste', {
                            bubbles: true,
                            cancelable: true,
                            clipboardData: new DataTransfer()
                        });
                        pasteEvent.clipboardData.setData('text/plain', txt);
                        
                        // Nếu event không bị chặn (defaultPrevented), fall back về insertText
                        if (input.dispatchEvent(pasteEvent)) {
                            document.execCommand('insertText', false, txt);
                        }
                    } else {
                        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                        nativeSetter.call(input, txt);
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
            }, text);
            console.log(`✅ CDP: Injected text (${text.length} chars)`);

            // 4. Submit
            if (submit !== false) {
                await new Promise(r => setTimeout(r, 100));
                await this.page.keyboard.press('Enter');
                console.log(`✅ CDP: Enter key sent`);
            }

            return { injected: true, submitted: submit !== false, success: true };

        } catch (e) {
            console.error('❌ CDP Inject Text Error:', e.message);
            return false;
        }
    }

    /**
     * Inject image vào ô chat thông qua CDP
     * Đọc file ảnh → tạo File blob trong browser → dispatch paste event
     * @param {string} imagePath - Đường dẫn tuyệt đối tới file ảnh
     * @param {string} [caption] - Text caption gửi kèm ảnh (optional)
     * @returns {object|false} - { injected: true } hoặc false nếu thất bại
     */
    async injectImageToChat(imagePath, caption = '') {
        if (!this.page) return false;

        try {
            const fs = require('fs');
            const pathMod = require('path');
            const { execSync } = require('child_process');

            if (!fs.existsSync(imagePath)) {
                console.error(`❌ Image file not found: ${imagePath}`);
                return false;
            }

            const fileSize = fs.statSync(imagePath).size;
            const fileName = pathMod.basename(imagePath);
            console.log(`🖼️ CDP: Injecting image ${fileName} (${(fileSize / 1024).toFixed(1)}KB) via clipboard+CDP`);

            // ========== STEP 1: Copy image to clipboard via PowerShell ==========
            const escapedPath = imagePath.replace(/\\/g, '\\\\');
            try {
                execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('${escapedPath}'); [System.Windows.Forms.Clipboard]::SetImage($img); $img.Dispose(); Write-Host 'OK'"`,
                    { encoding: 'utf-8', timeout: 10000 }
                );
                console.log(`📋 Image copied to clipboard`);
            } catch (psErr) {
                console.error('❌ PowerShell clipboard error:', psErr.message);
                return false;
            }

            // ========== STEP 2: Focus chat input via findChatContext ==========
            const chatFrame = await this.findChatContext();
            if (!chatFrame) {
                console.log('❌ CDP: Chat context not found for image paste');
                return false;
            }

            await chatFrame.evaluate(() => {
                const editor = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
                if (editor) { editor.focus(); editor.click(); }
            });
            await new Promise(r => setTimeout(r, 200));

            // ========== STEP 3: Ctrl+V via CDP keyboard (real paste!) ==========
            await this.page.keyboard.down('Control');
            await this.page.keyboard.press('v');
            await this.page.keyboard.up('Control');
            console.log(`✅ CDP: Ctrl+V pressed`);
            await new Promise(r => setTimeout(r, 1500));

            // ========== STEP 4: Caption + submit ==========
            if (caption && caption.trim()) {
                console.log(`📝 CDP: Injecting caption: "${caption.substring(0, 50)}..."`);
                await this.injectTextToChat(caption);
            } else {
                await this.page.keyboard.press('Enter');
                console.log(`✅ CDP: Enter pressed to send image`);
            }

            return { injected: true, submitted: true };

        } catch (e) {
            console.error('❌ CDP Image Inject Error:', e.message);
            return false;
        }
    }

    /**
     * 📝 Inject slash command and click the autocomplete suggestion
     * Types the command char-by-char to trigger Antigravity's autocomplete dropdown,
     * then clicks the matching suggestion item.
     * 
     * @param {string} command - Slash command like "/test"
     * @returns {Object} - {success, clicked, method}
     */
    async injectSlashCommand(command) {
        if (!this.page) return { success: false, error: 'Not connected' };

        try {
            console.log(`⚡ CDP: Injecting slash command "${command}" with autocomplete click`);

            // STEP 1: Find chat context
            const chatFrame = await this.findChatContext();
            if (!chatFrame) {
                console.log('❌ CDP: Chat context not found');
                return { success: false, error: 'Chat context not found' };
            }

            // STEP 2: Focus editor
            await chatFrame.evaluate(() => {
                const editor = document.querySelector('[contenteditable="true"]') ||
                    document.querySelector('textarea');
                if (editor) { editor.focus(); editor.click(); }
            });
            await new Promise(r => setTimeout(r, 100));

            // STEP 3: Clear existing text first
            await this.page.keyboard.down('Control');
            await this.page.keyboard.press('a');
            await this.page.keyboard.up('Control');
            await this.page.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 100));

            // STEP 4: Type command char-by-char to trigger autocomplete
            for (const char of command) {
                await this.page.keyboard.type(char, { delay: 50 });
            }
            console.log(`⌨️ CDP: Typed "${command}" char-by-char`);

            // STEP 5: Wait for autocomplete dropdown to appear
            await new Promise(r => setTimeout(r, 500));

            // STEP 6: Look for suggestion items and click the matching one
            // Try multiple selectors that Antigravity/VS Code may use for suggestion dropdowns
            const clicked = await chatFrame.evaluate((cmd) => {
                // Search for suggestion/completion items
                // Common patterns in VS Code extensions and chat UIs
                const selectors = [
                    // Generic list items near chat
                    '[class*="suggest"] [class*="item"]',
                    '[class*="suggest"] [class*="row"]',
                    '[class*="completion"] [class*="item"]',
                    '[class*="autocomplete"] [class*="item"]',
                    '[class*="dropdown"] [class*="item"]',
                    '[class*="menu"] [class*="item"]',
                    // VS Code specific
                    '.monaco-list-row',
                    '.suggest-widget .monaco-list-row',
                    // Role-based
                    '[role="option"]',
                    '[role="listbox"] [role="option"]',
                    '[role="menuitem"]',
                    // Antigravity specific (slash command suggestions)
                    '[class*="slash"] [class*="item"]',
                    '[class*="command"] [class*="item"]',
                    // Generic clickable items that might contain the command text
                    'li[class*="suggest"]',
                    'div[class*="suggest"]',
                ];

                const cmdName = cmd.replace(/^\//, '').toLowerCase();
                let allFound = [];

                for (const sel of selectors) {
                    const items = document.querySelectorAll(sel);
                    if (items.length > 0) {
                        for (const item of items) {
                            const text = (item.textContent || '').toLowerCase();
                            allFound.push({ selector: sel, text: text.substring(0, 100) });
                            if (text.includes(cmdName)) {
                                item.click();
                                return { clicked: true, selector: sel, text: text.substring(0, 100) };
                            }
                        }
                    }
                }

                // Broader search: any element containing the command name that looks clickable
                const allElements = document.querySelectorAll('div, li, span, button, a');
                for (const el of allElements) {
                    const text = (el.textContent || '').toLowerCase().trim();
                    const isSmall = text.length < 100; // Skip large containers
                    if (isSmall && text.includes(cmdName)) {
                        // Check if it looks like a dropdown/suggestion item
                        const styles = window.getComputedStyle(el);
                        const parent = el.parentElement;
                        const parentClass = (parent?.className || '').toLowerCase();
                        const elClass = (el.className || '').toLowerCase();

                        const isSuggestion =
                            parentClass.includes('suggest') || parentClass.includes('menu') ||
                            parentClass.includes('list') || parentClass.includes('dropdown') ||
                            parentClass.includes('completion') || parentClass.includes('option') ||
                            elClass.includes('suggest') || elClass.includes('menu') ||
                            elClass.includes('item') || elClass.includes('option') ||
                            el.getAttribute('role') === 'option' ||
                            el.getAttribute('role') === 'menuitem';

                        if (isSuggestion) {
                            el.click();
                            return { clicked: true, selector: 'broad-search', className: elClass.substring(0, 100), text: text.substring(0, 50) };
                        }
                    }
                }

                return { clicked: false, found: allFound.slice(0, 10) };
            }, command);

            console.log(`⚡ CDP: Autocomplete click result:`, JSON.stringify(clicked));

            if (clicked?.clicked) {
                console.log(`✅ CDP: Clicked suggestion item: ${clicked.text || clicked.selector}`);
                return { success: true, clicked: true, method: 'autocomplete-click' };
            } else {
                console.log(`⚠️ CDP: No matching suggestion found. Items found:`, JSON.stringify(clicked?.found || []));
                // Fallback: just leave the typed text in place
                return { success: true, clicked: false, method: 'typed-only', note: 'No autocomplete item found' };
            }

        } catch (e) {
            console.error('❌ CDP SlashCommand Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    async connect(retryCount = 3) {
        if (this.isConnected) return true;

        for (let attempt = 1; attempt <= retryCount; attempt++) {
            console.log(`🔌 AntigravityBridge: Đang kết nối tới ${this.debugUrl}... (lần ${attempt}/${retryCount})`);

            try {
                // Thử lấy WebSocket endpoint trước
                let wsEndpoint = null;

                try {
                    const versionRes = await fetch(`${this.debugUrl}/json/version`);
                    const versionData = await versionRes.json();
                    wsEndpoint = versionData.webSocketDebuggerUrl;
                    console.log(`📡 WebSocket endpoint: ${wsEndpoint}`);
                } catch (e) {
                    // Thử lấy từ /json
                    try {
                        const jsonRes = await fetch(`${this.debugUrl}/json`);
                        const jsonData = await jsonRes.json();
                        if (jsonData.length > 0) {
                            // Ưu tiên page có title Antigravity
                            const targetPage = jsonData.find(p => p.title.includes('Antigravity')) || jsonData[0];
                            wsEndpoint = targetPage.webSocketDebuggerUrl;
                        }
                    } catch (e2) {
                        console.log('⚠️ Không fetch được endpoint');
                    }
                }

                if (wsEndpoint) {
                    this.browser = await puppeteer.connect({
                        browserWSEndpoint: wsEndpoint,
                        defaultViewport: null // FIX: Giữ nguyên kích thước cửa sổ
                    });
                } else {
                    this.browser = await puppeteer.connect({
                        browserURL: this.debugUrl,
                        defaultViewport: null // FIX: Giữ nguyên kích thước cửa sổ
                    });
                }

                console.log('✅ AntigravityBridge: Đã kết nối Puppeteer!');

                // Tìm trang Antigravity
                const pages = await this.browser.pages();
                console.log(`📄 Tìm thấy ${pages.length} pages`);

                // Tìm page có chứa chat UI - ƯU TIÊN page workbench chính
                let candidatePages = [];
                for (const page of pages) {
                    const title = await page.title().catch(() => '');
                    const url = page.url();
                    console.log(`   - "${title}" : ${url}`);

                    // Skip blank và devtools
                    if (url.includes('about:blank') || url.includes('devtools')) continue;

                    candidatePages.push({ page, title, url });
                }

                // Ưu tiên 1: Page có title chứa "Antigravity" (main workbench)
                // Ưu tiên 2: Page có url chứa "workbench.html"
                // Ưu tiên 3: KHÔNG chọn page có title "Launchpad"
                let selectedPage = candidatePages.find(p =>
                    p.title.includes('Antigravity') && !p.title.includes('Launchpad')
                );
                if (!selectedPage) {
                    selectedPage = candidatePages.find(p => p.url.includes('workbench.html'));
                }
                if (!selectedPage) {
                    selectedPage = candidatePages.find(p => p.title !== 'Launchpad');
                }
                if (!selectedPage && candidatePages.length > 0) {
                    selectedPage = candidatePages[0];
                }

                if (selectedPage) {
                    this.page = selectedPage.page;
                    console.log(`✅ Đã chọn page: "${selectedPage.title}"`);
                } else if (pages.length > 0) {
                    this.page = pages[0];
                }

                if (this.page) {
                    this.isConnected = true;
                    console.log('✅ AntigravityBridge: Đã chọn page chính');

                    // Theo dõi DOM changes
                    await this.setupDOMObserver();

                    // 🚀 AUTO-INJECT chat_bridge_ws.js
                    await this.injectChatBridge();

                    // 🔄 Start periodic re-injection (every 30 seconds)
                    this.startBridgeReinjection();

                    return true;
                } else {
                    throw new Error('Không tìm thấy page phù hợp');
                }

            } catch (err) {
                console.error(`❌ AntigravityBridge: Lỗi kết nối (lần ${attempt}):`, err.message);
                this.isConnected = false;

                if (attempt < retryCount) {
                    console.log(`⏳ Đợi 2 giây rồi thử lại...`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }

        return false;
    }

    async setupDOMObserver() {
        if (!this.page) return;

        // ========== DISABLED: Dùng startChatPolling() thay thế ==========
        // DOM Observer gây spam logs vì quá sensitive với focus/blur events
        // Chat polling với continuous streaming đã đủ để extract messages
        console.log('ℹ️ DOM Observer disabled - using startChatPolling() instead');
        return;

        /* LEGACY CODE - Kept for reference
        try {
            // 1. Expose function để browser context gọi về Node.js
            // QUAN TRỌNG: Phải capture 'this' vì exposeFunction không giữ context
            const self = this;
            const MIN_LEN = this.MIN_RESPONSE_LENGTH;
            const PATTERNS = this.NOISE_PATTERNS;
     
            await this.page.exposeFunction('onNewMessage', (content, role = 'assistant') => {
                // ... noise filter logic ...
            });
     
            // 2. Inject script để theo dõi DOM changes
            await this.page.evaluate((selectors) => {
                // ... observer logic ...
            }, this.selectors);
     
            console.log('✅ DOM Observer đã được thiết lập');
        } catch (err) {
            console.log('⚠️ DOM Observer error:', err.message);
        }
        */
    }

    /**
     * 🚀 AUTO-INJECT chat_bridge_ws.js vào Antigravity
     * Giúp user không cần paste script thủ công mỗi lần mở app
     * V2: Inject vào cả main page VÀ các iframes
     */
    async injectChatBridge() {
        if (!this.page) return false;

        try {
            const fs = require('fs');
            const scriptPath = path.resolve(__dirname, '../../scripts/chat_bridge_ws.js');

            // Check if script file exists
            if (!fs.existsSync(scriptPath)) {
                console.log(`⚠️ Chat bridge script not found: ${scriptPath}`);
                return false;
            }

            // Read script content
            const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
            console.log(`📜 Loaded chat_bridge_ws.js (${scriptContent.length} bytes)`);

            let injectedCount = 0;

            // ========== 1. Inject vào MAIN PAGE ==========
            try {
                // Check if bridge exists AND has active WebSocket
                const bridgeStatus = await this.page.evaluate(() => {
                    if (typeof window.chatBridge === 'undefined') return 'not_injected';
                    // Use bridge's own status() to check connection
                    try {
                        const st = window.chatBridge.status();
                        if (st && st.isConnected) return 'ok';
                    } catch (e) { }
                    return 'ws_dead';
                });

                if (bridgeStatus === 'not_injected') {
                    await this.page.evaluate((code) => {
                        try {
                            eval(code);
                            console.log('✅ Chat bridge injected into main page');
                        } catch (e) {
                            console.error('❌ Chat bridge inject error (main):', e.message);
                        }
                    }, scriptContent);
                    injectedCount++;
                    console.log('✅ Injected chat bridge into MAIN PAGE');
                } else if (bridgeStatus === 'ws_dead') {
                    console.log('🔄 Bridge WS is dead, force re-injecting...');
                    // Clear old bridge and re-inject
                    await this.page.evaluate((code) => {
                        try {
                            // Properly stop old bridge (closes WS, observer)
                            if (window.chatBridge?.stop) window.chatBridge.stop();
                            delete window.chatBridge;
                            // Re-inject fresh
                            eval(code);
                            console.log('✅ Chat bridge RE-INJECTED into main page');
                        } catch (e) {
                            console.error('❌ Chat bridge re-inject error:', e.message);
                        }
                    }, scriptContent);
                    injectedCount++;
                    console.log('✅ Force RE-INJECTED chat bridge into MAIN PAGE');
                } else {
                    console.log('ℹ️ Chat bridge already in main page (WS active)');
                }
            } catch (e) {
                console.log('⚠️ Main page inject error:', e.message);
            }

            // ========== 2. Inject vào các IFRAMES (quan trọng!) ==========
            const frames = this.page.frames();
            console.log(`🔍 Found ${frames.length} frames, attempting injection...`);

            for (const frame of frames) {
                const frameUrl = frame.url();

                // Skip empty frames
                if (!frameUrl || frameUrl === 'about:blank' || frameUrl.includes('devtools')) {
                    continue;
                }

                // NOTE: Không skip chrome-extension frames vì đây là nơi chứa chat UI!
                // Antigravity dùng extension frames cho main chat interface

                try {
                    // Check if already injected
                    const alreadyInjected = await frame.evaluate(() => {
                        return typeof window.chatBridge !== 'undefined';
                    });

                    if (!alreadyInjected) {
                        await frame.evaluate((code) => {
                            try {
                                eval(code);
                                console.log('✅ Chat bridge injected into frame');
                            } catch (e) {
                                console.error('❌ Chat bridge inject error (frame):', e.message);
                            }
                        }, scriptContent);
                        injectedCount++;
                        console.log(`✅ Injected chat bridge into FRAME: ${frameUrl.substring(0, 60)}...`);
                    }
                } catch (frameErr) {
                    // Frame may be cross-origin or detached, skip
                    // console.log(`⚠️ Frame skip: ${frameErr.message}`);
                }
            }

            console.log(`✅ Chat bridge AUTO-INJECTED to ${injectedCount} context(s)!`);

            // ========== 3. Inject vào ALL BROWSER PAGES (webview targets!) ==========
            if (this.browser) {
                try {
                    const allPages = await this.browser.pages();
                    let webviewCount = 0;

                    for (const pg of allPages) {
                        try {
                            // Skip main page (already done above)
                            if (pg === this.page) continue;

                            const pgUrl = pg.url();
                            if (!pgUrl || pgUrl.includes('about:blank') || pgUrl.includes('devtools')) continue;

                            // Check if bridge already injected in this page
                            const bridgeStatus = await pg.evaluate(() => {
                                if (typeof window.chatBridge === 'undefined') return 'not_injected';
                                try {
                                    const st = window.chatBridge.status();
                                    if (st && st.isConnected) return 'ok';
                                } catch (e) { }
                                return 'ws_dead';
                            }).catch(() => 'error');

                            if (bridgeStatus === 'not_injected' || bridgeStatus === 'ws_dead') {
                                await pg.evaluate((code) => {
                                    try {
                                        if (window.chatBridge?.stop) window.chatBridge.stop();
                                        delete window.chatBridge;
                                        eval(code);
                                    } catch (e) {
                                        console.error('Bridge inject error:', e.message);
                                    }
                                }, scriptContent);
                                webviewCount++;
                                console.log(`✅ Bridge injected into WEBVIEW: ${pgUrl.substring(0, 60)}`);
                            }

                            // Also try frames within this page
                            const pgFrames = pg.frames();
                            for (const frame of pgFrames) {
                                try {
                                    const fUrl = frame.url();
                                    if (!fUrl || fUrl === 'about:blank' || fUrl === pgUrl) continue;

                                    const fStatus = await frame.evaluate(() => {
                                        return typeof window.chatBridge === 'undefined' ? 'no' : 'yes';
                                    }).catch(() => 'error');

                                    if (fStatus === 'no') {
                                        await frame.evaluate((code) => {
                                            try { eval(code); } catch (e) { }
                                        }, scriptContent);
                                        webviewCount++;
                                        console.log(`✅ Bridge injected into WEBVIEW FRAME: ${fUrl.substring(0, 60)}`);
                                    }
                                } catch (e) { /* skip */ }
                            }
                        } catch (e) { /* skip closed pages */ }
                    }

                    if (webviewCount > 0) {
                        injectedCount += webviewCount;
                        console.log(`🌐 Bridge injected into ${webviewCount} webview target(s)!`);
                    }
                } catch (e) {
                    console.log(`⚠️ Webview injection error: ${e.message}`);
                }
            }
            return injectedCount > 0;

        } catch (err) {
            console.error('❌ injectChatBridge error:', err.message);
            return false;
        }
    }

    /**
     * 🔄 Start periodic re-injection of chat_bridge_ws.js
     * Ensures bridge stays alive even if frames reload
     */
    startBridgeReinjection() {
        if (this.bridgeInjectInterval) return;

        console.log('🔄 Starting bridge re-injection (every 30 seconds)');
        this.bridgeInjectInterval = setInterval(async () => {
            if (this.isConnected && this.page) {
                try {
                    await this.injectChatBridge();
                } catch (e) {
                    console.log('⚠️ Bridge re-inject error:', e.message);
                }
            }
        }, 30000); // Every 30 seconds
    }

    stopBridgeReinjection() {
        if (this.bridgeInjectInterval) {
            clearInterval(this.bridgeInjectInterval);
            this.bridgeInjectInterval = null;
            console.log('⏹️ Bridge re-injection stopped');
        }
    }

    /**
     * Lấy toàn bộ log chat hiện tại
     */
    async getChatLog() {
        if (!this.page) return null;
        try {
            return await this.page.evaluate((selectors) => {
                const container = document.querySelector(selectors.messageContainer);
                if (!container) return 'Message container not found';
                return container.innerText;
            }, this.selectors);
        } catch (err) {
            return `Error: ${err.message}`;
        }
    }

    /**
     * Lấy response cuối cùng từ AI
     */
    async getLastResponse() {
        if (!this.isConnected) {
            const connected = await this.connect();
            if (!connected) return null;
        }

        try {
            return await this.page.evaluate((selectors) => {
                // Thử tìm message container
                const container = document.querySelector(selectors.messageContainer);
                if (!container) return null;

                // Lấy tất cả messages
                // Giả định cấu trúc chat standard: container -> children nodes
                const children = Array.from(container.children);
                if (children.length === 0) return null;

                // Lấy message cuối cùng
                const lastNode = children[children.length - 1];
                return lastNode.innerText || lastNode.textContent;
            }, this.selectors);
        } catch (err) {
            console.error('Error getting last response:', err);
            return null;
        }
    }

    /**
     * Dump HTML để debug selector
     */
    async dumpPageSource() {
        if (!this.page) return 'No page connected';
        try {
            return await this.page.content();
        } catch (err) {
            return `Error dumping source: ${err.message}`;
        }
    }

    /**
     * Extract chat content từ iframe (V3 - CDP FRAMES)
     * V3: Sử dụng Puppeteer frames() API để bypass cross-origin restrictions
     * Thay vì đọc contentDocument từ parent page, ta trực tiếp evaluate trong iframe context
     */
    async extractChatFromIframe() {
        if (!this.page) return [];

        try {
            // ========== V4: Ưu tiên frame extension (chứa chat) ==========
            const frames = this.page.frames();
            const results = [];

            for (const frame of frames) {
                const frameUrl = frame.url();

                // Skip empty, about:blank, and devtools frames
                if (!frameUrl ||
                    frameUrl === 'about:blank' ||
                    frameUrl.includes('devtools') ||
                    frameUrl.includes('chrome-extension://')) {
                    continue;
                }

                // ===== CHỈ QUAN TÂM FRAME EXTENSION (chứa chat) =====
                const frameUrlLower = frameUrl.toLowerCase();
                const isChatFrame = frameUrlLower.includes('extension') ||
                    frameUrlLower.includes('webview') ||
                    frameUrlLower.includes('cascade') ||
                    frameUrlLower.includes('agentpanel') ||
                    frameUrlLower.includes('workbench');
                if (!isChatFrame) {
                    continue;
                }

                try {
                    // Evaluate trực tiếp trong frame context
                    const frameMessages = await frame.evaluate(() => {
                        const msgs = [];

                        // Helper functions
                        function getClassName(el) {
                            if (!el.className) return '';
                            if (typeof el.className === 'string') return el.className;
                            if (el.className.baseVal !== undefined) return el.className.baseVal;
                            return '';
                        }

                        function getCleanText(el) {
                            const clone = el.cloneNode(true);
                            clone.querySelectorAll('pre, code, script, style, noscript, button, input, select, textarea').forEach(n => n.remove());
                            return clone.innerText ? clone.innerText.trim() : '';
                        }

                        // NEW: Get HTML content (preserves tables, code blocks, formatting)
                        function getHtmlContent(el) {
                            const notifyContainer = el.closest('.notify-user-container') ||
                                el.querySelector('.notify-user-container');
                            if (notifyContainer) {
                                return notifyContainer.outerHTML || '';
                            }

                            const clone = el.cloneNode(true);
                            clone.querySelectorAll('script, style, noscript').forEach(n => n.remove());
                            return clone.innerHTML ? clone.innerHTML.trim() : '';
                        }

                        // ===== STRATEGY 1: Tìm message containers (selectors) =====
                        const primarySelectors = [
                            '.notify-user-container',
                            '.leading-relaxed.select-text' // NEW: Antigravity v3 generic text block
                        ];
                        const fallbackSelectors = [
                            '[class*="message"]',
                            '[class*="Message"]',
                            '[class*="response"]',
                            '[class*="Response"]',
                            '[class*="assistant"]',
                            '[class*="user"]',
                            '[class*="chat-item"]',
                            '[class*="bubble"]',
                            '[data-role]',
                            '[data-message-role]',
                            '.leading-relaxed',
                            // Antigravity specific selectors
                            '[class*="turn-"]',
                            '[class*="conversation"]',
                            // NEW: Thêm selectors phổ biến khác
                            '[class*="content"]',
                            '[class*="text"]',
                            '[class*="paragraph"]',
                            'article',
                            '.prose'
                        ];
                        const selectors = document.querySelectorAll('.notify-user-container, .leading-relaxed.select-text').length
                            ? primarySelectors
                            : fallbackSelectors;

                        const seenTexts = new Set();

                        for (const selector of selectors) {
                            try {
                                document.querySelectorAll(selector).forEach(container => {
                                    const className = getClassName(container);
                                    const classLower = className.toLowerCase();

                                    // Skip code editor, UI elements
                                    if (classLower.includes('cm-') || classLower.includes('monaco')) return;
                                    if (classLower.includes('hljs') || classLower.includes('prism')) return;
                                    if (classLower.includes('input') || classLower.includes('textarea')) return;
                                    if (classLower.includes('dropdown') || classLower.includes('menu')) return;
                                    if (classLower.includes('modal') || classLower.includes('tooltip')) return;
                                    if (classLower.includes('sidebar') || classLower.includes('toolbar')) return;
                                    if (classLower.includes('header') || classLower.includes('footer')) return;
                                    if (classLower.includes('empty-pane')) return; // Skip empty pane messages

                                    const text = getCleanText(container);
                                    if (!text || text.length < 30) return;

                                    // Skip UI noise patterns
                                    if (/^(File|Edit|Selection|View|Go|Run|Terminal|Help)\s*$/i.test(text)) return;
                                    if (/^Drag a view here/i.test(text)) return;
                                    if (/^Press desired key/i.test(text)) return;

                                    // Skip model name noise
                                    const modelKeywords = ['Claude', 'Gemini', 'GPT', 'Opus', 'Sonnet', 'Pro', 'Flash'];
                                    let modelCount = 0;
                                    for (const kw of modelKeywords) {
                                        if (text.includes(kw)) modelCount++;
                                    }
                                    if (modelCount >= 3) return;

                                    // Detect role: thinking vs response
                                    let role = 'assistant';
                                    if (className.includes('opacity-70')) {
                                        role = 'thinking';
                                    }

                                    const htmlContent = getHtmlContent(container) || text;

                                    results.push({
                                        text: text,
                                        html: htmlContent, // NEW: Include HTML for tables
                                        class: className,
                                        role: role,
                                        method: 'cdp-selector'
                                    });
                                });
                            } catch (e) {
                                // Selector error, skip
                            }
                        }

                        // ===== STRATEGY 2: Fallback - Lấy raw text từ body nếu không tìm được =====
                        if (results.length === 0) {
                            const bodyText = doc.body?.innerText || '';
                            if (bodyText.length > 100) {
                                // Tách text thành các đoạn bằng newlines
                                const paragraphs = bodyText.split(/\\n{2,}/).filter(p => p.trim().length > 30);

                                // Chỉ lấy các đoạn có vẻ là AI response (không phải UI)
                                for (const para of paragraphs) {
                                    const trimmed = para.trim();

                                    // Skip UI patterns
                                    if (/^(File|Edit|Selection|View|Go|Run|Terminal|Help|Open|Close|Save)/i.test(trimmed)) continue;
                                    if (/^Drag a view|^Press desired|^Keyboard Shortcuts/i.test(trimmed)) continue;
                                    if (trimmed.length < 50) continue;

                                    // Skip if already seen
                                    const textKey = trimmed.substring(0, 100) + trimmed.length;
                                    if (seenTexts.has(textKey)) continue;
                                    seenTexts.add(textKey);

                                    results.push({
                                        text: trimmed,
                                        class: 'raw-body',
                                        role: 'assistant',
                                        method: 'cdp-raw'
                                    });
                                }
                            }
                        }

                        return results;
                    });

                    if (frameMessages && frameMessages.length > 0) {
                        console.log(`✅ CDP Extracted ${frameMessages.length} messages from extension frame`);
                        results.push(...frameMessages);
                    }

                } catch (frameErr) {
                    // Frame evaluation failed, likely detached or cross-origin issue
                }
            }

            // Fallback: Nếu không tìm được từ extension frame, thử main page
            if (results.length === 0) {
                return await this.extractChatFromMainPage();
            }

            return results;

        } catch (err) {
            return [];
        }
    }

    /**
     * Fallback: Extract từ main page nếu không tìm được iframe
     */
    async extractChatFromMainPage() {
        try {
            const script = `
            (function() {
                const results = [];
                const iframes = document.querySelectorAll('iframe');
                
                // Helper để xử lý SVGAnimatedString
                function getClassName(el) {
                    if (!el.className) return '';
                    if (typeof el.className === 'string') return el.className;
                    if (el.className.baseVal !== undefined) return el.className.baseVal;
                    return '';
                }
                
                // Helper: lấy full text từ element (skip code blocks)
                function getCleanText(el) {
                    // Clone element để không modify DOM gốc
                    const clone = el.cloneNode(true);
                    
                    // Remove code blocks, scripts, styles
                    clone.querySelectorAll('pre, code, script, style, noscript, button, input, select, textarea').forEach(n => n.remove());
                    
                    // Lấy innerText (giữ line breaks)
                    return clone.innerText.trim();
                }
                
                iframes.forEach((iframe, idx) => {
                    try {
                        const doc = iframe.contentDocument || iframe.contentWindow.document;
                        if (!doc || !doc.body) return;
                        
                        // ===== PHƯƠNG ÁN 1: Tìm MESSAGE CONTAINERS =====
                        // Các selector phổ biến cho chat messages
                        const primarySelectors = [
                            '.notify-user-container',
                            '.leading-relaxed.select-text' // NEW: Antigravity v3 generic text block
                        ];
                        const fallbackSelectors = [
                            '[class*="message"]',
                            '[class*="Message"]',
                            '[class*="response"]',
                            '[class*="Response"]',
                            '[class*="assistant"]',
                            '[class*="user"]',
                            '[class*="chat-item"]',
                            '[data-role]',
                            '[data-message-role]',
                            '.leading-relaxed'
                        ];
                        const selectors = doc.querySelectorAll('.notify-user-container, .leading-relaxed.select-text').length
                            ? primarySelectors
                            : fallbackSelectors;
                        
                        const seenTexts = new Set(); // Tránh duplicate
                        
                        for (const selector of selectors) {
                            try {
                                const containers = doc.querySelectorAll(selector);
                                containers.forEach(container => {
                                    const className = getClassName(container);
                                    const classLower = className.toLowerCase();
                                    
                                    // Skip containers quá nhỏ hoặc là code editor
                                    if (classLower.includes('cm-') || classLower.includes('monaco')) return;
                                    if (classLower.includes('hljs') || classLower.includes('prism')) return;
                                    if (classLower.includes('input') || classLower.includes('textarea')) return;
                                    
                                    // ========== NEW: Skip UI containers (không phải chat) ==========
                                    const uiPatterns = ['dropdown', 'picker', 'menu', 'modal', 'dialog', 
                                                       'popover', 'tooltip', 'select', 'command-palette',
                                                       'settings', 'sidebar', 'toolbar', 'navigation'];
                                    for (const ui of uiPatterns) {
                                        if (classLower.includes(ui)) return;
                                    }
                                    
                                    const text = getCleanText(container);
                                    if (text.length < 20) return; // Skip quá ngắn
                                    
                                    // ========== NEW: Skip if text contains too many model names ==========
                                    const modelKeywords = ['Claude', 'Gemini', 'GPT', 'Opus', 'Sonnet', 'Pro', 'Flash', 'Thinking'];
                                    let modelCount = 0;
                                    for (const kw of modelKeywords) {
                                        if (text.includes(kw)) modelCount++;
                                    }
                                    if (modelCount >= 3) return; // Likely UI dropdown content
                                    
                                    // ========== NEW: Skip UI text patterns ==========
                                    if (/Ask anything|@ to mention|\/ for workflows|Add context/i.test(text)) return;
                                    if (/Conversation mode|Planning|Fast|Model/i.test(text) && text.length < 200) return;
                                    
                                    // Tránh duplicate (bằng cách hash text ngắn)
                                    const textKey = text.substring(0, 100) + text.length;
                                    if (seenTexts.has(textKey)) return;
                                    seenTexts.add(textKey);
                                    
                                    // Detect role
                                    let role = 'unknown';
                                    const dataRole = container.getAttribute('data-role') || 
                                                     container.getAttribute('data-message-role') || '';
                                    
                                    if (dataRole) {
                                        role = dataRole.toLowerCase().includes('user') ? 'user' : 'assistant';
                                    } else if (classLower.includes('user') || classLower.includes('human')) {
                                        role = 'user';
                                    } else if (classLower.includes('assistant') || classLower.includes('ai') || 
                                               classLower.includes('response') || classLower.includes('bot')) {
                                        role = 'assistant';
                                    }
                                    
                                    results.push({
                                        text: text,
                                        class: className,
                                        tag: container.tagName,
                                        role: role,
                                        iframeIdx: idx,
                                        method: 'container'
                                    });
                                });
                            } catch (e) {
                                // Selector không hợp lệ, skip
                            }
                        }
                        
                        // ===== PHƯƠNG ÁN 2: Fallback về TreeWalker nếu không tìm được containers =====
                        if (results.length === 0) {
                            const walker = doc.createTreeWalker(
                                doc.body,
                                NodeFilter.SHOW_TEXT,
                                null,
                                false
                            );
                            
                            let node;
                            while (node = walker.nextNode()) {
                                const text = node.textContent.trim();
                                if (text.length > 30) {
                                    const parent = node.parentElement;
                                    if (!parent) continue;
                                    
                                    const className = getClassName(parent);
                                    const tag = parent.tagName;
                                    
                                    // Filter noise
                                    if (className.includes('cm-') || className.includes('monaco')) continue;
                                    if (tag === 'SCRIPT' || tag === 'STYLE') continue;
                                    
                                    results.push({
                                        text: text,
                                        class: className,
                                        tag: tag,
                                        role: 'unknown',
                                        iframeIdx: idx,
                                        method: 'walker'
                                    });
                                }
                            }
                        }
                        
                    } catch (e) {
                        // Cross-origin iframe, skip
                    }
                });
                
                return results;
            })();
            `;

            const result = await this.page.evaluate(script);
            return result || [];
        } catch (err) {
            // Suppress error to reduce log spam
            // console.error('❌ extractChatFromIframe error:', err.message);
            return [];
        }
    }

    /**
     * Kiểm tra text có phải noise (model name, UI elements) không
     * Kiểm tra text có phải noise (model name, UI elements) không
     */
    isNoiseText(text) {
        // ========== FILTER ENABLED ==========
        if (!text || text.length < this.MIN_RESPONSE_LENGTH) return true;

        const trimmed = text.trim();

        // Check từng pattern
        for (const pattern of this.NOISE_PATTERNS) {
            if (pattern.test(trimmed)) {
                // Suppress logging to reduce spam
                // console.log(`🚫 Filtered noise: "${trimmed.substring(0, 50)}"`);
                return true;
            }
        }

        // Thêm check: Nếu text chứa quá nhiều model names liên tiếp → noise
        const modelKeywords = ['Claude', 'Gemini', 'GPT', 'Opus', 'Sonnet', 'Pro', 'Flash'];
        let keywordCount = 0;
        for (const kw of modelKeywords) {
            if (trimmed.includes(kw)) keywordCount++;
        }
        if (keywordCount >= 3) {
            // console.log(`🚫 Filtered multi-model noise: "${trimmed.substring(0, 80)}"`);
            return true;
        }

        return false;
    }

    /**
     * Tạo hash đơn giản cho message để detect duplicates
     */
    hashMessage(msg) {
        const str = `${msg.text}_${msg.role}_${msg.iframeIdx}`;
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash.toString(16);
    }


    /**
     * Bắt đầu polling chat từ iframe và stream qua WebSocket
    /**
     * Auto-click Run/Accept buttons in the Antigravity IDE
     * Polls every 1.5s for actionable buttons and clicks them
     * WHITELIST: "Run", "Accept" only
     * BLACKLIST: "Send", "Submit", "Cancel", "Reject"
     */
    startButtonAutoClicker(intervalMs = 1000) {
        if (this._buttonClickerInterval) {
            console.log('⚠️ Button auto-clicker already running');
            return;
        }

        const WHITELIST = ['run', 'accept'];
        const BLACKLIST = ['send', 'submit', 'cancel', 'reject', 'delete', 'remove'];
        let clickCount = 0;

        this._buttonClickerInterval = setInterval(async () => {
            if (!this.isConnected) return;

            try {
                const frame = this.cachedChatFrame || this.page;
                if (!frame) return;

                const clicked = await frame.evaluate((whitelist, blacklist) => {
                    // STEP 1: Auto-scroll ONLY the main chat response area
                    // Find containers that actually contain chat content (not sidebars/dropdowns)
                    const allScrollable = document.querySelectorAll('[class*="overflow-y-auto"], [class*="overflow-auto"]');
                    for (const container of allScrollable) {
                        // ONLY scroll if container has chat content inside it
                        const hasChatContent = container.querySelector('.leading-relaxed.select-text, .isolate.mb-2');
                        if (!hasChatContent) continue;
                        if (container.scrollHeight > container.clientHeight + 50) {
                            container.scrollTop = container.scrollHeight;
                        }
                    }
                    // B) Xterm terminals — scroll ALL viewports to bottom
                    const xtermViewports = document.querySelectorAll('.xterm-viewport');
                    for (const vp of xtermViewports) {
                        // Set scrollTop to max
                        vp.scrollTop = 999999;
                        // Also scroll the inner scroll area if exists
                        const scrollArea = vp.querySelector('div');
                        if (scrollArea) {
                            vp.scrollTop = scrollArea.offsetHeight;
                        }
                        // Dispatch scroll event so xterm re-renders at new position
                        vp.dispatchEvent(new Event('scroll', { bubbles: false }));
                    }
                    // C) Also scroll xterm-scrollable-element containers
                    const xtermScrollables = document.querySelectorAll('.xterm-scrollable-element');
                    for (const xs of xtermScrollables) {
                        xs.scrollTop = 999999;
                    }
                    // D) Try Terminal API scrollToBottom on ALL xterm instances
                    const xtermElements = document.querySelectorAll('.xterm');
                    for (const el of xtermElements) {
                        const terminal = el._xterm || el.xterm;
                        if (terminal && typeof terminal.scrollToBottom === 'function') {
                            terminal.scrollToBottom();
                        }
                    }
                    // E) Click any "scroll to bottom" buttons (arrow-down, chevron-down, etc.)
                    const scrollBtns = document.querySelectorAll(
                        'button[aria-label*="scroll" i], button[aria-label*="bottom" i], ' +
                        'button[title*="scroll" i], button[title*="bottom" i], ' +
                        'button[class*="scroll-to-bottom"], button[class*="scrollToBottom"], ' +
                        '[class*="scroll-down"], [class*="jump-to-bottom"]'
                    );
                    for (const sb of scrollBtns) {
                        sb.click();
                    }
                    // F) Also try clicking any standalone down-arrow buttons near chat
                    const allBtns = document.querySelectorAll('button');
                    for (const b of allBtns) {
                        const label = (b.getAttribute('aria-label') || '').toLowerCase();
                        const title = (b.getAttribute('title') || '').toLowerCase();
                        if (label.includes('down') || label.includes('latest') ||
                            title.includes('down') || title.includes('latest') ||
                            label.includes('newest') || title.includes('newest')) {
                            // Check it has a down arrow icon (SVG with specific path or class)
                            const svg = b.querySelector('svg');
                            if (svg) {
                                b.click();
                            }
                        }
                    }

                    // STEP 2: Find and click whitelisted buttons
                    const buttons = document.querySelectorAll('button');
                    const results = [];

                    for (const btn of buttons) {
                        // Get button text (first span child or direct text)
                        const spans = btn.querySelectorAll('span');
                        let btnText = '';
                        for (const span of spans) {
                            const t = (span.textContent || '').trim().toLowerCase();
                            if (t && !t.includes('alt+') && !t.includes('⏎')) {
                                btnText = t;
                                break;
                            }
                        }
                        if (!btnText) btnText = (btn.textContent || '').trim().toLowerCase();

                        // Check whitelist
                        if (!whitelist.includes(btnText)) continue;

                        // Double-check not blacklisted
                        if (blacklist.some(b => btnText.includes(b))) continue;

                        // Make sure button is not disabled
                        if (btn.disabled) continue;

                        // Scroll button into view first, then click
                        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                        btn.click();
                        results.push(btnText);
                    }
                    return results;
                }, WHITELIST, BLACKLIST);

                if (clicked && clicked.length > 0) {
                    clickCount += clicked.length;
                    console.log(`🖱️ Auto-clicked: [${clicked.join(', ')}] (total: ${clickCount})`);
                }
            } catch (e) {
                // Suppress errors
            }
        }, intervalMs);

        console.log(`🖱️ Button auto-clicker started (${intervalMs}ms, whitelist: ${WHITELIST.join(',')})`);
    }

    stopButtonAutoClicker() {
        if (this._buttonClickerInterval) {
            clearInterval(this._buttonClickerInterval);
            this._buttonClickerInterval = null;
            console.log('🖱️ Button auto-clicker stopped');
        }
    }

    /**
     * Bắt đầu polling chat từ iframe
     */
    startChatPolling(sessionId, intervalMs = 2000) {
        if (this.chatPollInterval) {
            console.log('⚠️ Chat polling đã đang chạy');
            return;
        }

        console.log(`🔄 Bắt đầu chat polling cho session ${sessionId} (${intervalMs}ms interval, threshold=${this.STREAM_STABLE_THRESHOLD})`);

        // Reset state
        this.stableCount = 0;
        this.streamBuffer = '';
        this.isStreaming = false;

        this.chatPollInterval = setInterval(async () => {
            try {
                let messages = await this.extractChatFromIframe();

                // Diagnostic: log every 10th cycle
                this._pollCycleCount = (this._pollCycleCount || 0) + 1;
                if (this._pollCycleCount % 10 === 1) {
                    console.log(`🔄 Chat poll #${this._pollCycleCount}: extractChatFromIframe returned ${messages.length} messages, cachedChatFrame=${!!this.cachedChatFrame}`);
                }

                // FALLBACK: If extractChatFromIframe returns empty, try getLastAIResponse
                if (messages.length === 0) {
                    try {
                        const lastResp = await this.getLastAIResponse();
                        if (lastResp && lastResp.text && lastResp.text.length >= 10) {
                            // Convert to message format
                            const responseMsg = { text: lastResp.text, role: 'assistant', iframeIdx: 0 };
                            messages = [responseMsg];

                            // Also add thinking if available
                            if (lastResp.thinking && lastResp.thinking.length >= 10) {
                                messages.unshift({ text: lastResp.thinking, role: 'thinking', iframeIdx: 0 });
                            }

                            if (this._pollCycleCount % 10 === 1) {
                                console.log(`🔄 Fallback: getLastAIResponse found ${messages.length} messages (text=${lastResp.text.length}, thinking=${(lastResp.thinking || '').length})`);
                            }
                        }
                    } catch (e) { /* ignore fallback errors */ }
                }

                // ========== AUTO CLICK "RUN" BUTTON ==========
                // Tự động tìm và bấm nút Run nếu AI yêu cầu chạy lệnh
                try {
                    const getAllFramesPoly = (frame) => {
                        try {
                            const childFrames = frame.childFrames();
                            return [frame, ...childFrames.flatMap(getAllFramesPoly)];
                        } catch { return [frame]; }
                    };

                    let runClicked = false;

                    // Strategy 1: Scan ALL pages from browser (covers all webview targets)
                    if (this.browser && !runClicked) {
                        try {
                            const allPages = await this.browser.pages();
                            for (const pg of allPages) {
                                const allFrames = getAllFramesPoly(pg.mainFrame());
                                for (const f of allFrames) {
                                    try {
                                        if (!f || f.url() === 'about:blank') continue;
                                        const clicked = await f.evaluate(() => {
                                            const buttons = Array.from(document.querySelectorAll('button'));
                                            // Match "Run" or "Accept" button — NOT Send, Submit, Terminal, etc.
                                            const targetBtn = buttons.find(b => {
                                                const txt = (b.textContent || '').trim();
                                                const txtLower = txt.toLowerCase();
                                                // Exclude non-action buttons
                                                if (txtLower.includes('send') || txtLower.includes('submit') ||
                                                    txtLower.includes('terminal') || txtLower.includes('cancel') ||
                                                    txtLower.includes('copy') || txtLower.includes('close')) return false;
                                                // Must be in an action dialog (not chat input area)
                                                const inDialog = b.closest('.flex.items-center.justify-between') ||
                                                    b.closest('[role="dialog"]') ||
                                                    b.closest('.notification');
                                                if (!inDialog) return false;
                                                // Match "Run", "Run command", "Accept", "Accept All"
                                                return (txt === 'Run' || txt.startsWith('Run ') ||
                                                    txt === 'Accept' || txt.startsWith('Accept '));
                                            });
                                            if (targetBtn && !targetBtn.disabled) {
                                                targetBtn.click();
                                                return 'button-click: ' + (targetBtn.textContent || '').trim();
                                            }
                                            return false;
                                        }).catch(() => false);
                                        if (clicked) {
                                            console.log(`▶️ CDP: Auto-clicked Run button! (${clicked})`);
                                            runClicked = true;
                                            break;
                                        }
                                    } catch { continue; }
                                }
                                if (runClicked) break;
                            }
                        } catch { /* browser.pages() failed */ }
                    }

                    // Strategy 2: Use cached chat frame
                    if (!runClicked && this.cachedChatFrame) {
                        try {
                            const clicked = await this.cachedChatFrame.evaluate(() => {
                                const buttons = Array.from(document.querySelectorAll('button'));
                                const targetBtn = buttons.find(b => {
                                    const txt = (b.textContent || '').trim();
                                    const txtLower = txt.toLowerCase();
                                    if (txtLower.includes('send') || txtLower.includes('submit') ||
                                        txtLower.includes('terminal') || txtLower.includes('cancel') ||
                                        txtLower.includes('copy') || txtLower.includes('close')) return false;
                                    return (txt === 'Run' || txt.startsWith('Run ') ||
                                        txt === 'Accept' || txt.startsWith('Accept '));
                                });
                                if (targetBtn && !targetBtn.disabled) {
                                    targetBtn.click();
                                    return 'cached-frame-click: ' + (targetBtn.textContent || '').trim();
                                }
                                return false;
                            }).catch(() => false);
                            if (clicked) {
                                console.log(`▶️ CDP: Auto-clicked Run via cached frame! (${clicked})`);
                                runClicked = true;
                            }
                        } catch { /* cached frame detached */ }
                    }

                    // Strategy 3 REMOVED: Alt+Enter keyboard was hitting Send button
                } catch (e) { /* ignore error during polling */ }

                // Detect new messages bằng hash
                const newMessages = messages.filter(msg => {
                    const hash = this.hashMessage(msg);
                    if (this.lastMessageHashes.has(hash)) {
                        return false;
                    }
                    this.lastMessageHashes.add(hash);
                    return true;
                });

                // ========== FILTER NOISE ==========
                // DEBUG: Log số lượng messages trước khi filter
                if (newMessages.length > 0) {
                    console.log(`📊 DEBUG: ${newMessages.length} new messages extracted`);
                    newMessages.forEach((m, i) => {
                        console.log(`   [${i}] role=${m.role}, len=${m.text.length}, text="${m.text.substring(0, 80)}..."`);
                    });
                }

                const filteredMessages = newMessages.filter(m => !this.isNoiseText(m.text));

                // DEBUG: Log sau khi filter
                if (newMessages.length > 0 && filteredMessages.length === 0) {
                    console.log(`⚠️ DEBUG: ALL messages filtered! Check noise patterns.`);
                }

                // ========== STABLE THRESHOLD LOGIC ==========
                const currentContent = filteredMessages.map(m => m.text).join('\n');
                const totalContent = this.streamBuffer + currentContent;

                if (filteredMessages.length > 0) {
                    // Có tin mới → reset stable count, update buffer
                    this.stableCount = 0;
                    this.streamBuffer = totalContent;
                    this.isStreaming = true;

                    // Emit chat_update (partial)
                    if (this.eventBus) {
                        console.log(`📨 Update: ${filteredMessages.length} tin mới (stable: ${this.stableCount}/${this.STREAM_STABLE_THRESHOLD})`);

                        // FIX: Broadcast to ALL sessions instead of just current sessionId
                        this.eventBus.broadcast('chat_update', {
                            messages: filteredMessages,
                            partial: true,
                            timestamp: new Date().toISOString(),
                            source_session: sessionId // Optional: track origin
                        });
                    }
                } else if (this.isStreaming) {
                    // Không có tin mới nhưng đang streaming → tăng stable count
                    this.stableCount++;
                    // Suppress stable check logging
                    // console.log(`⏳ Stable check: ${this.stableCount}/${this.STREAM_STABLE_THRESHOLD}`);

                    // Đủ threshold → emit chat_complete
                    if (this.stableCount >= this.STREAM_STABLE_THRESHOLD) {
                        console.log(`✅ Content ổn định! Emit chat_complete`);

                        if (this.eventBus && this.streamBuffer.length > 0) {
                            // Get HTML from last extracted message (nếu có)
                            const lastMsg = this.lastMessages[this.lastMessages.length - 1];
                            const htmlContent = lastMsg?.html || '';

                            // FIX: Broadcast to ALL sessions
                            this.eventBus.broadcast('chat_complete', {
                                content: this.streamBuffer,
                                html: htmlContent, // NEW: Forward HTML for tables
                                timestamp: new Date().toISOString(),
                                source_session: sessionId
                            });

                            // Log final message
                            this.chatLogger.logMessage('assistant', this.streamBuffer, { type: 'complete', htmlLen: htmlContent.length });

                            // SAVE TO HISTORY for mobile app
                            messageLogger.saveHistory('assistant', this.streamBuffer, htmlContent);

                            console.log(`📤 chat_complete sent to ALL: textLen=${this.streamBuffer.length}, htmlLen=${htmlContent.length}`);
                        }

                        // Reset state
                        this.isStreaming = false;
                        this.streamBuffer = '';
                        this.stableCount = 0;
                    }
                }

                this.lastMessages = filteredMessages.length > 0 ? filteredMessages : this.lastMessages;

            } catch (err) {
                console.error('❌ Chat polling error:', err.message);

                // ========== AUTO RECONNECT CDP ==========
                // Nếu lỗi liên quan đến connection, thử reconnect
                if (err.message.includes('Session closed') ||
                    err.message.includes('Protocol error') ||
                    err.message.includes('Target closed') ||
                    err.message.includes('not connected') ||
                    err.message.includes('Execution context')) {
                    console.log('🔄 CDP connection lost, attempting reconnect...');
                    this.isConnected = false;

                    // Thử reconnect (async, không block polling)
                    this.connect().then(ok => {
                        if (ok) {
                            console.log('✅ CDP reconnected successfully!');
                            // Clear hash cache để re-detect messages
                            this.lastMessageHashes.clear();
                        } else {
                            console.log('❌ CDP reconnect failed');
                        }
                    }).catch(e => {
                        console.log('❌ CDP reconnect error:', e.message);
                    });
                }
            }
        }, intervalMs);
    }

    /**
     * Dừng chat polling
     */
    stopChatPolling() {
        if (this.chatPollInterval) {
            clearInterval(this.chatPollInterval);
            this.chatPollInterval = null;
            this.lastMessageHashes.clear();
            console.log('⏹️ Đã dừng chat polling');
        }
    }

    /**
     * Gửi message vào Antigravity chat
     * Thứ tự ưu tiên: CDP Frame (background) → DOM injection → PowerShell fallback
     */
    async sendMessage(sessionId, message) {
        // Ensure CDP connection
        if (!this.isConnected) {
            const connected = await this.connect();
            if (!connected) {
                console.log('⚠️ CDP không kết nối được, dùng PowerShell fallback...');
                return await this.sendMessageViaPowerShell(sessionId, message);
            }
        }

        console.log(`📤 Gửi message: "${message.substring(0, 50)}..."`);

        // ========== PRIORITY 1: CDP FRAME (BACKGROUND - ưu tiên cao nhất) ==========
        try {
            console.log('🎯 Thử CDP Frame injection (background)...');
            const frameSent = await this.sendMessageViaCDPFrame(sessionId, message);
            if (frameSent) {
                await this.waitForResponse(sessionId);
                return true;
            }
        } catch (frameErr) {
            console.log('⚠️ CDP Frame failed:', frameErr.message);
        }

        // ========== PRIORITY 2: DOM INJECTION ==========
        try {
            console.log('🎯 Thử DOM injection...');
            const domSent = await this.sendMessageViaDOM(sessionId, message);
            if (domSent) {
                await this.waitForResponse(sessionId);
                return true;
            }
        } catch (domErr) {
            console.log('⚠️ DOM injection failed:', domErr.message);
        }

        // ========== PRIORITY 3: POWERSHELL FALLBACK ==========
        console.log('🎯 Fallback: PowerShell clipboard...');
        return await this.sendMessageViaPowerShell(sessionId, message);
    }

    /**
     * PHƯƠNG ÁN 2: Gửi message qua DOM injection vào iframe
     * Không dùng clipboard, không ảnh hưởng app khác
     * @param {string} sessionId - Session ID
     * @param {string} message - Tin nhắn cần gửi
     * @returns {Promise<boolean>}
     */
    async sendMessageViaDOM(sessionId, message) {
        if (!this.page) {
            throw new Error('Page not connected');
        }

        console.log(`📝 Sending via DOM injection: "${message.substring(0, 50)}..."`);

        try {
            const result = await this.page.evaluate((text) => {
                const results = { success: false, method: '', error: null };

                // 1. TÌM TẤT CẢ IFRAME
                const iframes = document.querySelectorAll('iframe');

                for (const iframe of iframes) {
                    try {
                        const doc = iframe.contentDocument || iframe.contentWindow.document;
                        if (!doc || !doc.body) continue;

                        // 2. TÌM INPUT ELEMENT (ưu tiên theo thứ tự)
                        const inputSelectors = [
                            'textarea',
                            '[contenteditable="true"]',
                            '[role="textbox"]',
                            'input[type="text"]',
                            '[data-testid*="input"]',
                            '[data-testid*="chat"]',
                        ];

                        let inputEl = null;
                        for (const sel of inputSelectors) {
                            const el = doc.querySelector(sel);
                            if (el) {
                                // Kiểm tra visible
                                const rect = el.getBoundingClientRect();
                                if (rect.width > 0 && rect.height > 0) {
                                    inputEl = el;
                                    break;
                                }
                            }
                        }

                        if (!inputEl) continue;

                        // 3. INJECT TEXT VÀO INPUT (xử lý newlines đúng cách)
                        inputEl.focus();

                        if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
                            // Textarea xử lý \n tự nhiên
                            inputEl.value = text;
                            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                            inputEl.dispatchEvent(new Event('change', { bubbles: true }));
                            results.method = 'textarea.value';
                        } else if (inputEl.getAttribute('contenteditable') === 'true') {
                            // Contenteditable: KHÔNG dùng execCommand insertText vì sẽ hiểu \n như Enter
                            // Thay vào đó, set innerHTML với các paragraphs
                            const escapeHtml = (str) => str
                                .replace(/&/g, '&amp;')
                                .replace(/</g, '&lt;')
                                .replace(/>/g, '&gt;')
                                .replace(/"/g, '&quot;');

                            const lines = text.split('\n');
                            if (lines.length > 1) {
                                // Multi-line: wrap mỗi dòng trong <p>
                                inputEl.innerHTML = lines.map(line =>
                                    `<p>${escapeHtml(line) || '<br>'}</p>`
                                ).join('');
                            } else {
                                // Single line
                                inputEl.textContent = text;
                            }
                            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                            results.method = 'contenteditable';
                        } else {
                            // Fallback: set textContent
                            inputEl.textContent = text;
                            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                            results.method = 'textContent';
                        }

                        // 4. TÌM VÀ CLICK NÚT SUBMIT
                        const submitSelectors = [
                            'button[type="submit"]',
                            'button[aria-label*="send" i]',
                            'button[aria-label*="gửi" i]',
                            '[data-testid*="submit"]',
                            '[data-testid*="send"]',
                            '.send-button',
                            'button:has(svg)',  // Button có icon
                        ];

                        let submitBtn = null;
                        for (const sel of submitSelectors) {
                            try {
                                submitBtn = doc.querySelector(sel);
                                if (submitBtn) break;
                            } catch (e) {
                                // Selector không hợp lệ (như :has)
                            }
                        }

                        if (submitBtn) {
                            submitBtn.click();
                            results.success = true;
                            results.method += ' + button.click';
                        } else {
                            // Fallback: dispatch Enter key
                            inputEl.dispatchEvent(new KeyboardEvent('keydown', {
                                key: 'Enter',
                                code: 'Enter',
                                keyCode: 13,
                                which: 13,
                                bubbles: true
                            }));
                            results.success = true;
                            results.method += ' + Enter key';
                        }

                        return results;

                    } catch (e) {
                        results.error = e.message;
                        // Cross-origin iframe, tiếp tục với iframe khác
                    }
                }

                // Nếu không tìm thấy iframe phù hợp, thử trên main document
                results.error = 'No suitable iframe found, trying main document';
                return results;

            }, message);

            console.log(`✅ DOM injection result:`, result);

            if (result.success) {
                // Log message đã gửi
                this.chatLogger.logMessage('user', message);

                // Emit event
                if (this.eventBus && sessionId) {
                    this.eventBus.emit(sessionId, 'terminal', {
                        line: `📤 Đã gửi (DOM): ${message}`
                    });
                }
                return true;
            } else {
                throw new Error(result.error || 'DOM injection failed');
            }

        } catch (err) {
            console.error('❌ DOM injection error:', err.message);
            throw err;
        }
    }

    /**
     * 🚀 PHƯƠNG ÁN 3: Gửi message qua CDP Frames API
     * Bypass cross-origin bằng cách evaluate trực tiếp trong iframe context
     * HOÀN TOÀN BACKGROUND - không cần focus window!
     * @param {string} sessionId - Session ID
     * @param {string} message - Tin nhắn cần gửi
     * @returns {Promise<boolean>}
     */
    async sendMessageViaCDPFrame(sessionId, message) {
        if (!this.page) {
            throw new Error('Page not connected');
        }

        console.log(`📝 [CDP Frame] Sending: "${message.substring(0, 50)}..."`);

        try {
            const frames = this.page.frames();

            for (const frame of frames) {
                const frameUrl = frame.url();

                // Chỉ quan tâm frame extension (chứa chat)
                if (!frameUrl || !frameUrl.includes('extension')) {
                    continue;
                }

                try {
                    // Evaluate trực tiếp trong frame context
                    const result = await frame.evaluate((text) => {
                        const results = { success: false, method: '', error: null, debug: [] };

                        // 1. TÌM INPUT ELEMENT
                        const inputSelectors = [
                            'textarea',
                            '[contenteditable="true"]',
                            '[role="textbox"]',
                            'input[type="text"]',
                            '[data-testid*="input"]',
                            '[data-testid*="chat"]',
                        ];

                        let inputEl = null;
                        for (const sel of inputSelectors) {
                            try {
                                const el = document.querySelector(sel);
                                if (el) {
                                    const rect = el.getBoundingClientRect();
                                    if (rect.width > 0 && rect.height > 0) {
                                        inputEl = el;
                                        results.debug.push(`Found input: ${sel}`);
                                        break;
                                    }
                                }
                            } catch (e) { }
                        }

                        if (!inputEl) {
                            results.error = 'No input element found';
                            return results;
                        }

                        // 2. INJECT TEXT VÀO INPUT (xử lý newlines đúng cách)
                        inputEl.focus();

                        if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
                            // Textarea xử lý \n tự nhiên
                            inputEl.value = text;
                            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                            inputEl.dispatchEvent(new Event('change', { bubbles: true }));
                            results.method = 'textarea.value';
                        } else if (inputEl.getAttribute('contenteditable') === 'true') {
                            // Contenteditable: convert \n thành Shift+Enter behavior
                            // QUAN TRỌNG: Không dùng textContent (sẽ mất newlines)
                            // Thay vào đó, set innerHTML với các <p> hoặc <br> tags
                            inputEl.innerHTML = '';

                            // Escape HTML và convert newlines thành line breaks
                            const escapeHtml = (str) => str
                                .replace(/&/g, '&amp;')
                                .replace(/</g, '&lt;')
                                .replace(/>/g, '&gt;')
                                .replace(/"/g, '&quot;');

                            // Split by newlines và wrap mỗi dòng
                            const lines = text.split('\n');
                            if (lines.length > 1) {
                                // Multi-line: dùng <p> hoặc <div> cho mỗi dòng
                                inputEl.innerHTML = lines.map(line =>
                                    `<p>${escapeHtml(line) || '<br>'}</p>`
                                ).join('');
                            } else {
                                // Single line: chỉ cần text
                                inputEl.textContent = text;
                            }

                            inputEl.dispatchEvent(new InputEvent('input', {
                                bubbles: true,
                                cancelable: true,
                                inputType: 'insertText',
                                data: text
                            }));
                            results.method = 'contenteditable';
                            results.debug.push(`Text has ${lines.length} lines`);
                        } else {
                            inputEl.textContent = text;
                            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                            results.method = 'textContent';
                        }

                        results.debug.push(`Injected text via ${results.method}`);

                        // 3. TÌM VÀ CLICK NÚT SUBMIT (priority order)
                        const submitSelectors = [
                            'button[type="submit"]',
                            'button[aria-label*="send" i]',
                            'button[aria-label*="gửi" i]',
                            'button[aria-label*="Submit" i]',
                            '[data-testid*="submit"]',
                            '[data-testid*="send"]',
                            '.send-button',
                        ];

                        let submitBtn = null;
                        for (const sel of submitSelectors) {
                            try {
                                const btn = document.querySelector(sel);
                                if (btn && !btn.disabled) {
                                    submitBtn = btn;
                                    results.debug.push(`Found submit button: ${sel}`);
                                    break;
                                }
                            } catch (e) { }
                        }

                        // Fallback: tìm button có icon SVG (thường là nút gửi)
                        if (!submitBtn) {
                            const buttons = document.querySelectorAll('button');
                            for (const btn of buttons) {
                                const svg = btn.querySelector('svg');
                                const text = (btn.innerText || '').toLowerCase();
                                // Nút gửi thường có icon và không có text, hoặc text là "send"
                                if (svg && (btn.innerText.trim().length < 10 || text.includes('send'))) {
                                    const rect = btn.getBoundingClientRect();
                                    if (rect.width > 0 && rect.height > 0 && !btn.disabled) {
                                        submitBtn = btn;
                                        results.debug.push('Found submit button via SVG icon');
                                        break;
                                    }
                                }
                            }
                        }

                        if (submitBtn) {
                            submitBtn.click();
                            results.success = true;
                            results.method += ' + button.click';
                            results.debug.push('Clicked submit button');
                        } else {
                            // Fallback: Enter key với nhiều event types
                            results.debug.push('No submit button, trying Enter key...');

                            // Try keydown + keypress + keyup sequence
                            const enterEvent = {
                                key: 'Enter',
                                code: 'Enter',
                                keyCode: 13,
                                which: 13,
                                bubbles: true,
                                cancelable: true
                            };

                            inputEl.dispatchEvent(new KeyboardEvent('keydown', enterEvent));
                            inputEl.dispatchEvent(new KeyboardEvent('keypress', enterEvent));
                            inputEl.dispatchEvent(new KeyboardEvent('keyup', enterEvent));

                            // Thêm: Tìm form và submit
                            const form = inputEl.closest('form');
                            if (form) {
                                form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                                results.debug.push('Dispatched form submit event');
                            }

                            results.success = true;
                            results.method += ' + Enter key sequence';
                        }

                        return results;

                    }, message);

                    console.log(`📝 [CDP Frame] Result:`, JSON.stringify(result));

                    if (result.success) {
                        // ========== QUAN TRỌNG: Click vào input trong frame trước ==========
                        // page.keyboard.press sẽ gửi vào element đang focus
                        // Cần click vào input trong frame để focus đúng
                        console.log(`📝 [CDP Frame] Text injected, clicking input to focus...`);

                        // Tìm và click vào input trong frame này
                        const inputSelectors = ['textarea', '[contenteditable="true"]', '[role="textbox"]', 'input[type="text"]'];
                        for (const sel of inputSelectors) {
                            try {
                                const el = await frame.$(sel);
                                if (el) {
                                    await frame.click(sel);
                                    console.log(`📝 [CDP Frame] Clicked on ${sel} in frame`);
                                    break;
                                }
                            } catch (e) { }
                        }

                        // Delay nhỏ để focus update
                        await new Promise(r => setTimeout(r, 100));

                        // Gửi Enter qua Puppeteer keyboard
                        console.log(`📝 [CDP Frame] Pressing Enter via Puppeteer...`);
                        await this.page.keyboard.press('Enter');

                        console.log(`✅ [CDP Frame] Enter pressed via Puppeteer keyboard!`);

                        // Log message đã gửi
                        this.chatLogger.logMessage('user', message);

                        // Emit event
                        if (this.eventBus && sessionId) {
                            this.eventBus.emit(sessionId, 'terminal', {
                                line: `📤 Đã gửi (CDP Frame + Enter): ${message}`
                            });
                        }

                        console.log(`✅ [CDP Frame] Message sent successfully via: ${result.method} + Puppeteer Enter`);
                        return true;
                    } else {
                        console.log(`⚠️ [CDP Frame] Failed in this frame: ${result.error}`);
                    }

                } catch (frameErr) {
                    console.log(`⚠️ [CDP Frame] Frame error: ${frameErr.message}`);
                }
            }

            // Không tìm thấy frame phù hợp
            throw new Error('No suitable extension frame found for chat injection');

        } catch (err) {
            console.error('❌ [CDP Frame] Error:', err.message);
            throw err;
        }
    }

    /**
     * Gửi message qua PowerShell (fallback khi CDP không hoạt động)
     */
    async sendMessageViaPowerShell(sessionId, message) {
        return new Promise((resolve, reject) => {
            const scriptPath = path.join(__dirname, '..', 'inject_text.ps1');

            // Escape special characters for PowerShell
            const escapedMessage = message.replace(/"/g, '`"').replace(/\$/g, '`$');

            const command = `powershell -ExecutionPolicy Bypass -File "${scriptPath}" -Text "${escapedMessage}"`;

            console.log(`📤 Gửi message qua PowerShell: "${message.substring(0, 50)}..."`);

            exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
                if (error) {
                    console.error('❌ PowerShell inject error:', error.message);
                    reject(new Error(`Không thể inject text: ${error.message}`));
                    return;
                }

                const output = stdout.trim();
                console.log('PowerShell output:', output);

                if (output === 'OK') {
                    console.log('✅ Đã gửi message qua PowerShell');

                    // Emit event
                    if (this.eventBus && sessionId) {
                        this.eventBus.emit(sessionId, 'terminal', {
                            line: `📤 Đã gửi (PowerShell): ${message}`
                        });
                    }

                    resolve(true);
                } else {
                    reject(new Error(`PowerShell failed: ${output}`));
                }
            });
        });
    }

    /**
     * Chờ và stream response từ Antigravity
     */
    async waitForResponse(sessionId) {
        // Response đã được handle bởi DOM Observer (realtime)
        // Hàm này chỉ mang tính chất fallback hoặc chờ đợi explicit
        // Không cần làm gì nhiều nếu setupDOMObserver hoạt động tốt
        console.log('⏳ Đang chờ response (qua Observer)...');
    }

    /**
     * Gửi Accept hoặc Reject vào Antigravity
     * @param {string} decision - 'accept' hoặc 'reject'
     * @returns {Promise<boolean>} - true nếu thành công
     */
    async sendApproval(decision) {
        if (!this.isConnected) {
            const connected = await this.connect();
            if (!connected) {
                throw new Error('Không thể kết nối tới Antigravity. Đảm bảo Antigravity đang chạy với debug mode.');
            }
        }

        console.log(`🔘 Đang gửi ${decision} vào Antigravity...`);

        try {
            // Thử tìm và click nút Accept/Reject
            const buttonSelectors = decision === 'accept'
                ? [
                    'button:has-text("Accept")',
                    'button:has-text("Chấp nhận")',
                    'button:has-text("Yes")',
                    'button:has-text("OK")',
                    '[data-testid="accept-button"]',
                    '.accept-button',
                    '.btn-accept'
                ]
                : [
                    'button:has-text("Reject")',
                    'button:has-text("Từ chối")',
                    'button:has-text("No")',
                    'button:has-text("Cancel")',
                    '[data-testid="reject-button"]',
                    '.reject-button',
                    '.btn-reject'
                ];

            let clicked = false;

            // Thử click các button selectors
            for (const selector of buttonSelectors) {
                try {
                    const button = await this.page.$(selector);
                    if (button) {
                        await button.click();
                        clicked = true;
                        console.log(`✅ Đã click vào: ${selector}`);
                        break;
                    }
                } catch (e) {
                    // Thử selector tiếp theo
                }
            }

            // Nếu không tìm thấy button, thử dùng keyboard
            if (!clicked) {
                console.log('⚠️ Không tìm thấy button, thử dùng keyboard...');

                // Escape để đóng bất kỳ focus nào trên chat input
                await this.page.keyboard.press('Escape');
                await new Promise(r => setTimeout(r, 100));

                // Gửi phím tương ứng
                if (decision === 'accept') {
                    // Thử các phím thường dùng cho Accept
                    await this.page.keyboard.press('y');
                } else {
                    await this.page.keyboard.press('Escape');
                }

                console.log(`✅ Đã gửi keyboard shortcut cho ${decision}`);
                clicked = true;
            }

            return clicked;

        } catch (err) {
            console.error(`❌ Lỗi khi gửi ${decision}:`, err.message);
            throw err;
        }
    }

    // ========================================================================
    // 📊 QUOTA MONITOR — Read status bar quota info via CDP
    // ========================================================================

    /**
     * Read quota information from Antigravity status bar
     * The quota is in the aria-label of #jlcodes\\.antigravity-cockpit element
     * @returns {string|null} Formatted quota text
     */
    async getQuota() {
        if (!this.page) return null;

        try {
            const result = await this.page.evaluate(() => {
                // The status bar quota element
                const el = document.getElementById('jlcodes.antigravity-cockpit');
                if (!el) return null;

                const ariaLabel = el.getAttribute('aria-label') || '';
                if (!ariaLabel) return null;

                return ariaLabel;
            });

            if (!result) return null;

            // Parse the aria-label into clean text for Telegram
            // The aria-label contains markdown table format
            // Extract model names and percentages
            const lines = result.split('\n');
            let output = '';
            for (const line of lines) {
                const trimmed = line.trim();
                // Skip empty lines, separators, headers
                if (!trimmed || trimmed === '---' || trimmed.startsWith('| :') || trimmed === '| | | |') continue;
                if (trimmed.startsWith('*')) continue; // Skip footer

                // Extract model lines with percentages
                // Format: | 🟡 **Claude Opus 4.5 (Thinking)** | `■■□□□□□□□□` | 20.00% → 1h 4m (22:07) |
                const percentMatch = trimmed.match(/([🟡🟢🔴⚪]\s*\*?\*?[\w\s.()]+\*?\*?)\s*\|\s*`([^`]+)`\s*\|\s*([\d.]+%\s*→\s*[^|]+)/);
                if (percentMatch) {
                    const name = percentMatch[1].replace(/\*\*/g, '').replace(/&nbsp;/g, '').trim();
                    const bar = percentMatch[2];
                    const info = percentMatch[3].trim();
                    output += `${name}  ${bar}  ${info}\n`;
                    continue;
                }

                // Group headers: | **Claude** | | |
                const headerMatch = trimmed.match(/\|\s*\*\*([^*]+)\*\*\s*\|/);
                if (headerMatch && !trimmed.includes('%')) {
                    output += `\n📁 ${headerMatch[1]}\n`;
                }
            }

            return output.trim() || result.substring(0, 2000);
        } catch (e) {
            console.error('❌ getQuota error:', e.message);
            return null;
        }
    }

    // ========================================================================
    // 🚀 OPTION 1: CONTEXT-BASED INJECTION (Antigravity-Shit-Chat Style)
    // Production-level implementation - Simple, Fast, Reliable
    // ========================================================================

    /**
     * 🔍 Find Chat Context — search ALL CDP targets including webviews
     * VS Code webview panels are separate targets not exposed by browser.pages()
     * We fetch /json endpoint directly to get ALL targets
     * @returns {Page|Frame|null}
     */
    async findChatContext() {
        if (!this.browser) return null;

        // Return cache if still valid
        if (this.cachedChatFrame) {
            try {
                const isValid = await this.cachedChatFrame.evaluate(() => {
                    return !!(document.querySelector('[data-lexical-editor="true"][contenteditable="true"]') ||
                        document.querySelector('textarea[placeholder*="message" i]') ||
                        document.querySelector('textarea'));
                }).catch(() => false);

                if (isValid) {
                    console.log('✅ CDP: Using cached chat context');
                    return this.cachedChatFrame;
                }
            } catch (e) {
                console.log('⚠️ CDP: Cached context invalid, re-discovering...');
                this.cachedChatFrame = null;
            }
        }

        // Helper function (outside try/catch to be available to all steps)
        const getAllFrames = (frame) => {
            const childFrames = frame.childFrames();
            return [frame, ...childFrames.flatMap(getAllFrames)];
        };

        // ========== STEP 1: Try browser.pages() first (fast path) ==========
        try {
            const allPages = await this.browser.pages();
            for (const page of allPages) {
                const contexts = getAllFrames(page.mainFrame());
                for (const ctx of contexts) {
                    try {
                        const hasEditor = await ctx.evaluate(() => {
                            const el = document.querySelector('[data-lexical-editor="true"][contenteditable="true"]') ||
                                document.querySelector('textarea[placeholder*="message" i]') ||
                                document.querySelector('textarea');
                            if (!el) return false;
                            const r = el.getBoundingClientRect();
                            return r.width > 0 && r.height > 0;
                        }).catch(() => false);

                        if (hasEditor) {
                            const isTerminal = await ctx.evaluate(() =>
                                !!document.querySelector('.xterm, .xterm-viewport')
                            ).catch(() => false);
                            if (isTerminal) continue;

                            console.log(`✅ CDP: Found chat context via pages()`);
                            this.cachedChatFrame = ctx;
                            return ctx;
                        }
                    } catch (e) { continue; }
                }
            }
        } catch (e) { /* continue to step 2 */ }

        // ========== STEP 2: Fetch ALL targets from /json endpoint ==========
        console.log('🔍 CDP: Searching webview targets via /json...');
        try {
            const res = await fetch(`${this.debugUrl}/json`);
            const targets = await res.json();
            console.log(`🔍 CDP: Found ${targets.length} total targets:`);

            // Log all targets for debugging
            for (const t of targets) {
                console.log(`   [${t.type}] "${t.title?.substring(0, 50)}" : ${t.url?.substring(0, 60)}`);
            }

            // Try webview and other non-page targets that have webSocketDebuggerUrl
            for (const target of targets) {
                if (!target.webSocketDebuggerUrl) continue;

                // Skip targets we already checked via pages()
                if (target.type === 'page') continue;

                try {
                    // Connect to this specific target
                    const targetBrowser = await require('puppeteer-core').connect({
                        browserWSEndpoint: target.webSocketDebuggerUrl,
                        defaultViewport: null
                    });

                    const targetPages = await targetBrowser.pages();
                    for (const tp of targetPages) {
                        const contexts = getAllFrames(tp.mainFrame());
                        for (const ctx of contexts) {
                            try {
                                const hasEditor = await ctx.evaluate(() => {
                                    const el = document.querySelector('[data-lexical-editor="true"][contenteditable="true"]') ||
                                        document.querySelector('textarea[placeholder*="message" i]') ||
                                        document.querySelector('textarea');
                                    if (!el) return false;
                                    const r = el.getBoundingClientRect();
                                    return r.width > 0 && r.height > 0;
                                }).catch(() => false);

                                if (hasEditor) {
                                    const isTerminal = await ctx.evaluate(() =>
                                        !!document.querySelector('.xterm, .xterm-viewport')
                                    ).catch(() => false);
                                    if (isTerminal) continue;

                                    console.log(`✅ CDP: Found chat context in webview target!`);
                                    console.log(`    ↳ Type: ${target.type}, Title: ${target.title}`);
                                    this.cachedChatFrame = ctx;
                                    this._chatTargetBrowser = targetBrowser; // keep reference
                                    return ctx;
                                }
                            } catch (e) { continue; }
                        }
                    }

                    // Not found in this target, disconnect
                    targetBrowser.disconnect();
                } catch (e) {
                    // Can't connect to this target, skip
                    continue;
                }
            }
        } catch (e) {
            console.log(`⚠️ CDP: Error fetching /json: ${e.message}`);
        }

        try {
            console.log('⚠️ CDP: Chat context NOT found. Dumping DOM to Data/diagnostic_log.txt...');
            const fs = require('fs');
            const path = require('path');
            const logOut = [];

            // Re-fetch targets
            const res = await fetch(`${this.debugUrl}/json`);
            const targets = await res.json();
            logOut.push(`Total Targets: ${targets.length}`);

            for (const t of targets) {
                logOut.push(`\n=== TARGET [${t.type}] ${t.title} ===`);
                if (!t.webSocketDebuggerUrl) continue;

                try {
                    const targetBrowser = await require('puppeteer-core').connect({
                        browserWSEndpoint: t.webSocketDebuggerUrl,
                        defaultViewport: null
                    });

                    const tPages = await targetBrowser.pages();
                    for (let i = 0; i < tPages.length; i++) {
                        const frames = getAllFrames(tPages[i].mainFrame());
                        for (let j = 0; j < frames.length; j++) {
                            const frame = frames[j];
                            const findings = await frame.evaluate(() => {
                                const els = document.querySelectorAll('textarea, input, button, [contenteditable="true"]');
                                return Array.from(els).map(el => {
                                    const rect = el.getBoundingClientRect();
                                    return `[${el.tagName}] class="${el.className}" id="${el.id}" text="${(el.textContent || '').substring(0, 30).trim()}" placeholder="${el.getAttribute('placeholder') || ''}" aria-label="${el.getAttribute('aria-label') || ''}" size=${Math.round(rect.width)}x${Math.round(rect.height)} visible=${rect.width > 0 && rect.height > 0}`;
                                });
                            }).catch(() => []);
                            if (findings.length > 0) {
                                logOut.push(`  -> Frame ${j} (${frame.url()}):`);
                                findings.forEach(f => logOut.push(`     ${f}`));
                            }
                        }
                    }
                    targetBrowser.disconnect();
                } catch (e) { logOut.push(`  -> Error: ${e.message}`); }
            }

            const logPath = path.join(__dirname, '../../Data/diagnostic_log.txt');
            fs.writeFileSync(logPath, logOut.join('\n'));
            console.log(`✅ CDP: Diagnostic log saved to ${logPath}`);
        } catch (dumpErr) {
            console.log(`❌ CDP: Failed to generate diagnostic log: ${dumpErr.message}`);
        }

        console.log('❌ CDP: Chat context NOT found (no Lexical editor in any target)');
        return null;
    }

    // injectTextToChat() — MOVED to line ~1512 (single definition)

















    /**
     
     * Ngắt kết nối
     */
    // ==========================================
    // 🔴 Go Live (Live Server) — Click status bar button
    // ==========================================
    async clickGoLive() {
        if (!this.page) return { success: false, error: 'Not connected to Antigravity' };

        try {
            console.log('🔴 CDP: Looking for Go Live / Live Server button...');

            // Status bar items are in the main page DOM (not inside webview frames)
            const result = await this.page.evaluate(() => {
                // VS Code status bar items
                const statusItems = document.querySelectorAll(
                    '.statusbar-item a, .statusbar-item button, [id*="statusbar"] a, [id*="statusbar"] button, .right-items a, .left-items a'
                );

                for (const item of statusItems) {
                    const text = (item.textContent || '').trim().toLowerCase();
                    const ariaLabel = (item.getAttribute('aria-label') || '').toLowerCase();
                    const title = (item.getAttribute('title') || '').toLowerCase();
                    const id = (item.id || '').toLowerCase();

                    // Match "Go Live", "Port: XXXX", or Live Server related
                    if (text.includes('go live') || text.includes('port:') ||
                        ariaLabel.includes('go live') || ariaLabel.includes('live server') ||
                        title.includes('go live') || title.includes('live server') ||
                        id.includes('ritwickdey.liveserver') || id.includes('golive') ||
                        text.match(/port\s*:\s*\d+/i)) {

                        item.click();
                        return {
                            found: true,
                            label: item.textContent?.trim() || ariaLabel || 'Go Live',
                            wasLive: text.includes('port:') || text.match(/port\s*:\s*\d+/i) ? true : false
                        };
                    }
                }
                return { found: false };
            });

            if (result.found) {
                const action = result.wasLive ? 'Đã tắt' : 'Đã bật';
                console.log(`✅ CDP: Go Live clicked! (${result.label})`);
                return { success: true, label: result.label, wasLive: result.wasLive, action };
            }

            // Fallback: try VS Code command palette approach
            console.log('⚠️ CDP: Go Live button not found in status bar, trying command...');
            return { success: false, error: 'Không tìm thấy nút Go Live trong status bar. Kiểm tra Live Server extension đã cài chưa.' };

        } catch (e) {
            console.error('❌ CDP Go Live Error:', e.message);
            return { success: false, error: e.message };
        }
    }

    disconnect() {
        // Dừng chat polling trước
        this.stopChatPolling();

        if (this.browser) {
            this.browser.disconnect();
            this.browser = null;
            this.page = null;
            this.isConnected = false;
            console.log('👋 AntigravityBridge: Đã ngắt kết nối');
        }
    }
}

module.exports = AntigravityBridge;


