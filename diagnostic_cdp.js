const puppeteer = require('puppeteer-core');
const fs = require('fs');

async function checkNode(frame, type) {
    try {
        const results = await frame.evaluate(() => {
            const arr = [];
            // Tìm editorlexical / textareas
            const editors = document.querySelectorAll('[contenteditable="true"], textarea');
            editors.forEach(el => {
                const rect = el.getBoundingClientRect();
                arr.push(`[${el.tagName}] rect=${Math.round(rect.width)}x${Math.round(rect.height)} | class="${el.className}" | id="${el.id}"`);
            });

            // Tìm nút Run
            const buttons = Array.from(document.querySelectorAll('button'));
            const runBtns = buttons.filter(b => b.textContent && b.textContent.includes('Run'));
            runBtns.forEach(el => {
                arr.push(`[▶️ RUN BUTTON] class="${el.className}" | disabled=${el.disabled}`);
            });
            return arr;
        });
        return results;
    } catch (e) {
        return [`[ERROR Evaluate] ${e.message}`];
    }
}

const getAllFrames = (frame) => {
    const childFrames = frame.childFrames();
    return [frame, ...childFrames.flatMap(getAllFrames)];
};

async function runDiagnostics() {
    console.log("🔍 Bắt đầu quét CDP (port 9000)...");
    let logOutput = [];

    try {
        const res = await fetch('http://127.0.0.1:9000/json');
        const targets = await res.json();

        console.log(`Tìm thấy ${targets.length} targets.`);
        logOutput.push(`Total Targets: ${targets.length}`);

        for (const t of targets) {
            logOutput.push(`\n=== TARGET [${t.type}]: ${t.title?.substring(0, 50)} ===`);
            logOutput.push(`URL: ${t.url?.substring(0, 80)}...`);

            if (!t.webSocketDebuggerUrl) {
                logOutput.push('  -> No WebSocket URL, skipping.');
                continue;
            }

            try {
                const browser = await puppeteer.connect({
                    browserWSEndpoint: t.webSocketDebuggerUrl,
                    defaultViewport: null
                });

                const pages = await browser.pages();
                logOutput.push(`  -> Found ${pages.length} pages within target`);

                for (let i = 0; i < pages.length; i++) {
                    const page = pages[i];
                    const pageUrl = page.url() || 'unknown';
                    logOutput.push(`    -> Page ${i}: ${pageUrl.substring(0, 80)}...`);

                    const frames = getAllFrames(page.mainFrame());
                    logOutput.push(`      -> Found ${frames.length} total frames (including nested)`);

                    for (let j = 0; j < frames.length; j++) {
                        const frame = frames[j];
                        const frameUrl = frame.url() || 'unknown';

                        // Check nodes in frame
                        const findings = await checkNode(frame, `Frame ${j}`);
                        if (findings.length > 0) {
                            logOutput.push(`        => In Frame ${j} (${frameUrl.substring(0, 60)}...):`);
                            findings.forEach(f => logOutput.push(`           ${f}`));
                        }
                    }
                }
                browser.disconnect();
            } catch (e) {
                logOutput.push(`  -> Error connecting/evaluating: ${e.message}`);
            }
        }
    } catch (e) {
        console.error("Lỗi fetch:", e);
        logOutput.push(`FETCH ERROR: ${e.message}`);
    }

    fs.writeFileSync('./diagnostic_log.txt', logOutput.join('\n'));
    console.log("✅ Đã ghi kết quả ra diagnostic_log.txt");
    process.exit(0);
}

runDiagnostics();
