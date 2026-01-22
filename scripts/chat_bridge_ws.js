/**
 * 🚀 Antigravity Chat Bridge v4.2 (Auto Reconnect + Debug)
 * 
 * Chiến lược: Scan toàn document với filter mạnh
 * - Không cần transcript root
 * - Dùng MutationObserver trên document.body
 * - Filter dựa trên text patterns và DOM structure
 */

(function () {
    // Dynamic WS URL - supports localhost and remote
    const WS_PORT = 8000;
    const WS_URL = `ws://localhost:${WS_PORT}/ws/bridge`;
    const FINALIZE_DELAY = 10000;  // 10s - wait for text stability
    const MAX_GENERATION_TIME = 120000;  // 120s max - safety timeout
    const POLL_INTERVAL = 500;  // Fallback polling

    console.log('🚀 Antigravity Chat Bridge v4.2 - Installing...');
    console.log(`📡 WebSocket URL: ${WS_URL}`);

    // =========================================
    // STATE
    // =========================================
    let ws = null;
    let isConnected = false;
    let lastText = '';
    let lastHtml = '';  // Track HTML content too
    let finalizeTimer = null;
    let reconnectTimer = null;
    let pollTimer = null;
    let observer = null;
    const transcriptRoots = new Map();

    // =========================================
    // BLOCKLIST PATTERNS (UI spam)
    // =========================================
    const BLOCKLIST_STARTS = [
        'Files With Changes', 'Reject All', 'Accept All', 'Add Context', 'Mentions', 'Images',
        'Conversation Mode', 'Model', 'Planning', 'Verification', 'Execution',
        'Claude', 'Gemini', 'GPT', 'Submit', 'Cancel', 'Undo', 'Redo',
        'Copy', 'Paste', 'Save', 'Delete', 'New', 'Open', 'Close',
        'Settings', 'Preferences', 'Help', 'About', 'Version',
        'Update', 'Upgrade', 'Download', 'Upload', 'Export', 'Import'
    ];

    const BLOCKLIST_CONTAINS = [
        'files with changes', 'reject all', 'accept all', 'add context',
        'execute tasks directly', 'simple tasks that can be completed',
        'agent can plan', 'deep research', 'complex tasks', 'conversation mode',
        'use for simple tasks', 'use for deep', 'use for complex',
        '+0 -0', 'Auto', 'Toggle', 'Expand', 'Collapse', 'Show more', 'Show less',
        'Load more', 'Loading...', 'Thinking...', 'Generating...', 'Processing...'
    ];

    // =========================================
    // HELPER: Visibility Check
    // =========================================
    function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    }

    // =========================================
    // HELPER: Check if AI is still generating
    // =========================================
    function isAIGenerating() {
        const iframes = document.querySelectorAll('iframe');

        for (const iframe of iframes) {
            try {
                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                if (!doc || !doc.body) continue;

                // 1. Check for Stop button (visible = generating)
                const stopSelectors = [
                    '[aria-label*="Stop"]', '[aria-label*="stop"]',
                    '[title*="Stop"]', '[title*="stop"]',
                    'button:has(svg[data-icon="stop"])',
                    'button:has([d*="M6 4h4"])',  // Stop icon shape
                    '[data-testid*="stop"]'
                ];

                for (const sel of stopSelectors) {
                    try {
                        const btn = doc.querySelector(sel);
                        if (btn && isVisible(btn)) {
                            console.log('⏸️ AI still generating (Stop button visible)');
                            return true;
                        }
                    } catch (e) { }
                }

                // 2. Check for disabled Submit button (disabled = generating)
                const submitSelectors = [
                    'button[type="submit"]',
                    '[aria-label*="Send"]', '[aria-label*="send"]',
                    '[aria-label*="Submit"]', '[aria-label*="submit"]'
                ];

                for (const sel of submitSelectors) {
                    try {
                        const btn = doc.querySelector(sel);
                        if (btn && isVisible(btn) && (btn.disabled || btn.getAttribute('aria-disabled') === 'true')) {
                            console.log('⏸️ AI still generating (Submit disabled)');
                            return true;
                        }
                    } catch (e) { }
                }

                // 3. Check for loading/thinking indicators
                const loadingSelectors = [
                    '[aria-busy="true"]',
                    '.loading', '.spinner',
                    '[class*="thinking"]', '[class*="generating"]',
                    '[class*="Thinking"]', '[class*="Generating"]'
                ];

                for (const sel of loadingSelectors) {
                    try {
                        const el = doc.querySelector(sel);
                        if (el && isVisible(el)) {
                            console.log('⏸️ AI still generating (Loading indicator)');
                            return true;
                        }
                    } catch (e) { }
                }

            } catch (e) {
                // Cross-origin - skip
            }
        }

        return false;  // No generation indicators found
    }

    // =========================================
    // FILTER: Check if text is UI spam
    // =========================================
    function isBlockedText(text) {
        // ===== FILTERS DISABLED FOR DEBUGGING =====
        // Testing to see if blocklist is removing valid content
        if (!text || text.length < 5) return true;  // Only block very short
        if (text.length > 100000) return true;      // Only block extremely long
        return false;  // Allow everything else

        /* ORIGINAL FILTERS (commented out for testing):
        if (!text || text.length < 10) return true;
        if (text.length > 50000) return true;

        const trimmed = text.trim();

        // Check starts with blocklist
        for (const pattern of BLOCKLIST_STARTS) {
            if (trimmed.startsWith(pattern)) return true;
        }

        // Check contains blocklist (case insensitive)
        const lower = trimmed.toLowerCase();
        for (const pattern of BLOCKLIST_CONTAINS) {
            if (lower.includes(pattern.toLowerCase())) return true;
        }

        // Check if mostly numbers/symbols
        const alphaRatio = (trimmed.match(/[a-zA-Z]/g) || []).length / trimmed.length;
        if (alphaRatio < 0.3 && trimmed.length < 100) return true;

        return false;
        */
    }

    // =========================================
    // EXTRACT: Find assistant messages (SCAN IFRAMES!)
    // =========================================
    function findAssistantMessages() {
        const results = [];
        const iframes = document.querySelectorAll('iframe');

        function getClassName(el) {
            if (!el.className) return '';
            if (typeof el.className === 'string') return el.className;
            if (el.className.baseVal !== undefined) return el.className.baseVal;
            return '';
        }

        function getCleanText(el) {
            const clone = el.cloneNode(true);
            clone.querySelectorAll('script, style, noscript').forEach(n => n.remove());
            return (clone.innerText || '').trim();
        }

        function getHtmlContent(el) {
            // Try to find notify-user-container parent (Antigravity's message wrapper)
            const notifyContainer = el.closest('.notify-user-container') ||
                el.querySelector('.notify-user-container');

            if (notifyContainer) {
                // Return full Antigravity HTML with all Tailwind classes
                const html = notifyContainer.outerHTML;

                // DEBUG: Log extraction stats
                console.log(`📦 HTML Extraction: ${html.length} chars`);
                console.log(`📦 Container class: .notify-user-container (found!)`);
                console.log(`📦 First 300 chars:`, html.substring(0, 300));

                return html;
            }

            // Fallback: return element's innerHTML
            const clone = el.cloneNode(true);
            clone.querySelectorAll('script, style, noscript').forEach(n => n.remove());
            const fallbackHtml = (clone.innerHTML || '').trim();

            // DEBUG: Log fallback usage
            console.log(`⚠️ Fallback extraction: ${fallbackHtml.length} chars (no .notify-user-container)`);

            return fallbackHtml;
        }

        function isScrollable(el) {
            if (!el) return false;
            const style = getComputedStyle(el);
            const overflowY = style.overflowY || '';
            return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
        }

        function findTranscriptRoot(doc) {
            const composerSelectors = [
                '[data-lexical-editor="true"][role="textbox"]',
                '[role="textbox"][contenteditable="true"]',
                '[contenteditable="true"]',
                'textarea'
            ];

            let composer = null;
            for (const sel of composerSelectors) {
                const candidate = doc.querySelector(sel);
                if (candidate && isVisible(candidate)) {
                    composer = candidate;
                    break;
                }
            }

            if (!composer) return null;

            // Prefer a scrollable transcript near the composer
            let current = composer.parentElement;
            while (current && current !== doc.body) {
                // Check for .notify-user-container OR chat message patterns
                const hasChat = current.querySelector('.notify-user-container') ||
                    current.querySelector('div[class*="group"][class*="pb-2"]') ||
                    current.querySelector('div[class*="gap-y-3"]') ||
                    current.querySelector('div[class*="select-text"]');
                if (hasChat && isScrollable(current)) {
                    return current;
                }
                current = current.parentElement;
            }

            // Fallback: nearest scrollable ancestor above composer
            current = composer.parentElement;
            while (current && current !== doc.body) {
                if (isScrollable(current)) {
                    return current;
                }
                current = current.parentElement;
            }

            return null;
        }

        iframes.forEach((iframe, idx) => {
            try {
                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                if (!doc || !doc.body) return;

                const cachedRoot = transcriptRoots.get(iframe);
                const transcriptRoot = cachedRoot || findTranscriptRoot(doc);
                if (transcriptRoot) {
                    transcriptRoots.set(iframe, transcriptRoot);
                }

                const searchRoot = transcriptRoot || doc;
                const messageSelectors = [
                    '.notify-user-container',
                    'div[class~="prose"][class*="prose-sm"]'
                ];

                const seenTexts = new Set();

                for (const selector of messageSelectors) {
                    try {
                        searchRoot.querySelectorAll(selector).forEach(container => {
                            const className = getClassName(container);
                            const classLower = className.toLowerCase();

                            if (classLower.includes('cm-') || classLower.includes('monaco')) return;
                            if (classLower.includes('hljs') || classLower.includes('prism')) return;
                            if (classLower.includes('input') || classLower.includes('textarea')) return;
                            if (classLower.includes('dropdown') || classLower.includes('menu')) return;
                            if (classLower.includes('modal') || classLower.includes('tooltip')) return;
                            if (classLower.includes('sidebar') || classLower.includes('toolbar')) return;

                            const text = getCleanText(container);
                            if (!text || text.length < 15) return;

                            // REMOVED: Model keywords filter was blocking legitimate AI comparison messages
                            // Previously blocked messages with >= 3 model names (Claude, Gemini, GPT...)

                            const textKey = text.substring(0, 100) + text.length;
                            if (seenTexts.has(textKey)) return;
                            seenTexts.add(textKey);

                            if (isBlockedText(text)) return;

                            let role = 'unknown';
                            if (classLower.includes('user') || classLower.includes('human')) {
                                role = 'user';
                            } else if (classLower.includes('assistant') || classLower.includes('ai') ||
                                classLower.includes('response') || classLower.includes('bot')) {
                                role = 'assistant';
                            }

                            const rect = container.getBoundingClientRect();
                            results.push({
                                el: container,
                                text: text,
                                html: getHtmlContent(container),
                                rect: rect,
                                role: role,
                                iframeIdx: idx
                            });
                        });
                    } catch (e) { /* selector error */ }
                }
            } catch (e) { /* cross-origin skip */ }
        });

        // ========== FALLBACK: Transcript container tracking ==========
        // When CSS selectors fail (regular AI responses have no specific class),
        // find the transcript container and extract the LAST child's text
        if (results.length === 0) {
            iframes.forEach((iframe, idx) => {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (!doc || !doc.body) return;

                    // Find transcript container by Tailwind classes from diagnostic
                    const transcripts = doc.querySelectorAll('div[class*="gap-y-3"][class*="px-4"]');
                    for (const transcript of transcripts) {
                        const children = transcript.children;
                        if (children.length === 0) continue;

                        // Get the LAST child (newest message turn)
                        const lastChild = children[children.length - 1];
                        const text = getCleanText(lastChild);
                        if (!text || text.length < 10) continue;
                        if (isBlockedText(text)) continue;

                        const rect = lastChild.getBoundingClientRect();
                        results.push({
                            el: lastChild,
                            text: text,
                            html: getHtmlContent(lastChild),
                            rect: rect,
                            role: 'assistant', // Assume last message in transcript is AI
                            iframeIdx: idx
                        });
                        console.log(`📋 Transcript tracking: found last child (${text.length}ch, ${children.length} turns)`);
                    }
                } catch (e) { /* cross-origin skip */ }
            });
        }

        if (results.length === 0) {
            // console.log(`⚠️ findAssistantMessages: Found ${iframes.length} iframes, 0 messages`);
        } else {
            console.log(`📋 Before sort: ${results.length} messages, tops: [${results.map(r => r.rect?.top || 0).join(', ')}]`);
        }

        results.sort((a, b) => (b.rect?.top || 0) - (a.rect?.top || 0));

        if (results.length > 0) {
            console.log(`📋 After sort: tops: [${results.map(r => r.rect?.top || 0).join(', ')}]`);
        }

        return results;
    }

    // =========================================
    // MAIN EXTRACT FUNCTION
    // =========================================
    function extractLastAssistantText() {
        const messages = findAssistantMessages();
        if (messages.length === 0) return null;

        // DEBUG: Log all messages found
        console.log(`🔍 Found ${messages.length} total messages`);
        messages.forEach((msg, i) => {
            console.log(`  [${i}] top: ${msg.rect?.top || 0}px, text preview: "${msg.text.substring(0, 50)}..."`);
        });

        const latest = messages[0];
        console.log(`✅ Selected message [0] (highest top position = most recent)`);

        return {
            text: latest.text,
            html: latest.html,
            role: 'assistant'
        };
    }

    // =========================================
    // INJECT MESSAGE TO CHAT (SEND FROM PHONE)
    // =========================================
    function injectMessageToChat(text) {
        console.log('📝 Injecting message to chat:', text.substring(0, 50) + '...');

        const iframes = document.querySelectorAll('iframe');
        let injected = false;

        iframes.forEach((iframe) => {
            if (injected) return;

            try {
                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                if (!doc || !doc.body) return;

                // ========== SKIP TERMINAL IFRAMES ==========
                // Kiểm tra xem iframe có phải là terminal không
                const hasTerminal = doc.querySelector('.xterm, .xterm-viewport, .xterm-screen, [class*="terminal"], [class*="Terminal"]');
                if (hasTerminal) {
                    console.log('⏭️ Skipping terminal iframe');
                    return;
                }

                // ========== ƯU TIÊN CHAT-SPECIFIC SELECTORS ==========
                // Tìm input có placeholder/aria-label liên quan đến chat
                const chatSelectors = [
                    'textarea[placeholder*="type"]',
                    'textarea[placeholder*="message"]',
                    'textarea[placeholder*="chat"]',
                    'textarea[placeholder*="Ask"]',
                    'textarea[placeholder*="nhập"]',
                    'textarea[placeholder*="lệnh"]',
                    'textarea[placeholder*="prompt"]',
                    'textarea[aria-label*="chat"]',
                    'textarea[aria-label*="prompt"]',
                    '[role="textbox"][aria-label*="chat"]',
                    '[role="textbox"][aria-label*="prompt"]',
                    '[contenteditable="true"][aria-label*="chat"]'
                ];

                let inputEl = null;

                // Thử chat-specific selectors trước
                for (const sel of chatSelectors) {
                    const el = doc.querySelector(sel);
                    if (el) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            inputEl = el;
                            console.log(`✅ Found CHAT input: ${sel}`);
                            break;
                        }
                    }
                }

                // Fallback: generic selectors nhưng KHÔNG PHẢI terminal
                if (!inputEl) {
                    const genericSelectors = [
                        'textarea:not(.xterm-helper-textarea)',
                        '[contenteditable="true"]:not([class*="xterm"])',
                        '[role="textbox"]:not([class*="xterm"])',
                        'input[type="text"]:not([class*="xterm"])'
                    ];
                    for (const sel of genericSelectors) {
                        const el = doc.querySelector(sel);
                        if (el) {
                            // Skip nếu element nằm trong terminal container
                            const inTerminal = el.closest('.xterm, [class*="terminal"], [class*="Terminal"]');
                            if (inTerminal) continue;
                            // Skip nếu class chứa xterm
                            const className = el.className?.toLowerCase?.() || '';
                            if (className.includes('xterm') || className.includes('terminal')) continue;

                            const rect = el.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) {
                                inputEl = el;
                                console.log(`⚠️ Using fallback input: ${sel}`);
                                break;
                            }
                        }
                    }
                }

                if (!inputEl) return;

                // Focus & Inject
                inputEl.focus();

                // ========== V19 LOGIC (RESTORED) ==========
                // Dùng execCommand trước để trigger React events
                // Fallback set value nếu thất bại

                // Try execCommand first (triggers React synthetic events)
                const succeeded = doc.execCommand('insertText', false, text);

                // Fallback direct value if execCommand failed
                if (!succeeded) {
                    if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
                        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
                        if (nativeInputValueSetter) {
                            nativeInputValueSetter.call(inputEl, text);
                        } else {
                            inputEl.value = text;
                        }
                    } else {
                        inputEl.textContent = text;
                    }
                }

                // Dispatch Events
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                inputEl.dispatchEvent(new Event('change', { bubbles: true }));

                injected = true;

                // WAIT & CLICK SEND
                setTimeout(() => {
                    // NEW: Improved Button Finding Logic
                    // 1. Tìm nút Submit hoặc Send
                    const submitBtns = Array.from(doc.querySelectorAll('button, [role="button"], div[role="button"]'));
                    let submitBtn = null;

                    // Ưu tiên tìm nút có icon send hoặc text send
                    for (const btn of submitBtns) {
                        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                        const txt = (btn.innerText || '').toLowerCase();
                        const title = (btn.title || '').toLowerCase();
                        const dataTestId = (btn.getAttribute('data-testid') || '').toLowerCase();

                        // Check if contains SVG
                        const hasSvg = !!btn.querySelector('svg, img');

                        // Check patterns
                        const isSend =
                            aria.includes('send') || aria.includes('gửi') || aria.includes('submit') ||
                            txt.includes('send') || txt.includes('gửi') ||
                            title.includes('send') || dataTestId.includes('send') ||
                            (hasSvg && (aria.includes('send') || title.includes('send') || aria.includes('prompt')));

                        if (isSend) {
                            // Check visibility
                            const style = window.getComputedStyle(btn);
                            if (style.display !== 'none' && style.visibility !== 'hidden' && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
                                submitBtn = btn;
                                console.log('✅ Found Send Button:', btn);
                                break;
                            }
                        }
                    }

                    // Heuristic Fallback: Tìm nút cuối cùng trong form/container
                    if (!submitBtn && inputEl) {
                        const form = inputEl.closest('form');
                        if (form) {
                            submitBtn = form.querySelector('button[type="submit"]');
                            if (!submitBtn) {
                                // Nút cuối cùng trong form
                                const btns = form.querySelectorAll('button');
                                if (btns.length > 0) submitBtn = btns[btns.length - 1];
                            }
                            if (submitBtn) console.log('⚠️ Found Submit Button via Form:', submitBtn);
                        }
                    }

                    if (submitBtn) {
                        console.log('✅ Clicking Submit Button...');
                        submitBtn.click();
                        setTimeout(() => submitBtn.click(), 100); // Double click safety
                    } else {
                        console.log('⚠️ No submit button found, simulating ENTER...');
                        const keyOpts = {
                            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                            bubbles: true, cancelable: true, view: iframe.contentWindow
                        };
                        inputEl.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
                        inputEl.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
                        inputEl.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
                    }

                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'inject_result',
                            success: true,
                            text: text.substring(0, 50)
                        }));
                    }

                }, 400); // Increased delay to 400ms for safety

            } catch (e) {
                console.log('⚠️ Cross-origin iframe logic error:', e.message);
            }
        });

        if (!injected && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'inject_result', success: false, error: 'No input found' }));
        }
    }

    // =========================================
    // WEBSOCKET CONNECTION
    // =========================================
    function connect() {
        if (ws && ws.readyState === WebSocket.OPEN) return;

        console.log('🔌 Connecting to WebSocket...');

        try {
            ws = new WebSocket(WS_URL);

            ws.onopen = () => {
                console.log('✅ WebSocket connected!');
                isConnected = true;
                ws.send(JSON.stringify({ type: 'bridge_register', source: 'antigravity_console_v4' }));
                startPolling();
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    // console.log('📩 Received:', data.type);
                    if (data.type === 'inject_message' && data.text) {
                        injectMessageToChat(data.text);
                    }
                } catch (e) {
                    console.error('Error parsing message:', e);
                }
            };

            ws.onclose = () => {
                console.log('🔌 WebSocket disconnected');
                isConnected = false;
                stopPolling();
                scheduleReconnect();
            };

            ws.onerror = () => {
                console.error('❌ WebSocket error');
                isConnected = false;
            };
        } catch (err) {
            console.error('❌ Failed to create WebSocket:', err.message);
            scheduleReconnect();
        }
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, 5000);
    }

    function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(tick, POLL_INTERVAL);
        console.log('🔄 Polling started');
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function emitUpdate(text, html) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
            type: 'ai_messages',
            messages: [{
                text: text, html: html,
                timestamp: new Date().toISOString(),
                role: 'assistant', isStreaming: true
            }]
        }));
    }

    function emitComplete(text, html) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
            type: 'ai_messages',
            messages: [{
                text: text, html: html,
                timestamp: new Date().toISOString(),
                role: 'assistant', isComplete: true
            }]
        }));
    }

    function tick() {
        const msg = extractLastAssistantText();
        if (!msg) return;

        const generating = isAIGenerating();

        if (msg.text !== lastText) {
            lastText = msg.text;
            lastHtml = msg.html || '';
            emitUpdate(lastText, lastHtml);

            // Clear previous timers
            clearTimeout(finalizeTimer);

            // NEW LOGIC: Only finalize if AI is done generating
            finalizeTimer = setTimeout(() => {
                // Double-check: AI might still be generating
                if (!isAIGenerating()) {
                    console.log('✅ AI generation complete - finalizing');
                    emitComplete(lastText, lastHtml);
                } else {
                    console.log('⏸️ AI still generating after 10s - waiting...');
                    // Retry check in another 10s
                    setTimeout(() => {
                        if (!isAIGenerating()) {
                            console.log('✅ AI generation complete (delayed) - finalizing');
                            emitComplete(lastText, lastHtml);
                        }
                    }, 10000);
                }
            }, FINALIZE_DELAY);
        } else if (!generating && lastText && !finalizeTimer) {
            // Text hasn't changed AND AI is not generating
            // This handles the case where AI finished but timer was cleared
            console.log('✅ AI idle with stable text - finalizing now');
            emitComplete(lastText, lastHtml);
        }
    }

    function start() {
        connect();
        if (!observer && document.body) {
            observer = new MutationObserver(() => tick());

            // Observe iframe documents directly when possible
            const iframes = document.querySelectorAll('iframe');
            let observed = false;
            iframes.forEach((iframe) => {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (!doc || !doc.body) return;
                    observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
                    observed = true;
                } catch (e) { }
            });

            if (!observed) {
                observer.observe(document.body, { childList: true, subtree: true, characterData: true });
            }
        }
        tick();
    }

    function stop() {
        if (observer) { observer.disconnect(); observer = null; }
        if (ws) { ws.close(); ws = null; }
        stopPolling();
        clearTimeout(finalizeTimer);
        clearTimeout(reconnectTimer);
    }

    window.chatBridge = {
        start: start, stop: stop,
        status: () => ({ isConnected, lastTextLen: lastText.length, polling: !!pollTimer }),
        testExtract: () => extractLastAssistantText(),
        listMessages: () => findAssistantMessages().length
    };

    start();
    console.log('✅ Antigravity Chat Bridge v4.1 - READY! (Auto-Inject Force Click)');
})();

