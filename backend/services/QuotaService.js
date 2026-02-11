/**
 * QuotaService.js — Antigravity Quota Checker
 * Ported from check_quota.py
 * 
 * Cách hoạt động:
 * 1. Tìm process language_server_windows_x64.exe đang chạy
 * 2. Lấy extension_server_port và csrf_token từ command line
 * 3. Tìm port đang listen
 * 4. Gọi API GetUserStatus qua HTTPS để lấy quota
 */

const { execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '..', '..', 'quota_history.json');

class QuotaService {
    constructor() {
        this._cachedConnection = null; // {port, csrfToken}
    }

    // ========================================
    // PHẦN 1: Tìm process Antigravity
    // ========================================

    findAntigravityProcesses() {
        const cmd = `chcp 65001 >nul && powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'csrf_token' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json"`;

        try {
            const result = execSync(cmd, { timeout: 15000, encoding: 'utf-8' });
            let output = result.trim();
            if (!output) return [];

            // Tìm vị trí JSON bắt đầu
            for (let i = 0; i < output.length; i++) {
                if (output[i] === '[' || output[i] === '{') {
                    output = output.substring(i);
                    break;
                }
            }

            let data = JSON.parse(output);
            if (!Array.isArray(data)) data = [data];

            const processes = [];
            for (const proc of data) {
                const cmdline = proc.CommandLine || '';
                if (!cmdline) continue;
                if (!cmdline.includes('--extension_server_port')) continue;
                if (!cmdline.includes('--csrf_token')) continue;

                const portMatch = cmdline.match(/--extension_server_port[=\s]+(\d+)/);
                const tokenMatch = cmdline.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);

                if (!tokenMatch) continue;

                processes.push({
                    pid: proc.ProcessId,
                    extensionPort: portMatch ? parseInt(portMatch[1]) : 0,
                    csrfToken: tokenMatch[1],
                });
            }
            return processes;
        } catch (e) {
            console.error(`[QuotaService] Không tìm được process: ${e.message}`);
            return [];
        }
    }

    getListeningPorts(pid) {
        const cmd = `chcp 65001 >nul && powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ports = Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort; if ($ports) { $ports | Sort-Object -Unique }"`;

        try {
            const result = execSync(cmd, { timeout: 10000, encoding: 'utf-8' });
            const ports = [];
            for (const line of result.trim().split('\n')) {
                const p = parseInt(line.trim());
                if (p > 0 && p <= 65535) ports.push(p);
            }
            return [...new Set(ports)].sort((a, b) => a - b);
        } catch (e) {
            return [];
        }
    }

    // ========================================
    // PHẦN 2: Gọi API
    // ========================================

    callApi(port, apiPath, csrfToken, body = {}) {
        return new Promise((resolve) => {
            const data = JSON.stringify(body);
            const options = {
                hostname: '127.0.0.1',
                port,
                path: apiPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': csrfToken,
                    'Content-Length': Buffer.byteLength(data),
                },
                rejectUnauthorized: false, // Self-signed cert
                timeout: 10000,
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(data);
            req.end();
        });
    }

    async pingPort(port, csrfToken) {
        const result = await this.callApi(
            port,
            '/exa.language_server_pb.LanguageServerService/GetUnleashData',
            csrfToken,
            { wrapper_data: {} }
        );
        return result !== null;
    }

    async findWorkingPort(ports, csrfToken) {
        for (const port of ports) {
            if (await this.pingPort(port, csrfToken)) return port;
        }
        return null;
    }

    async getUserStatus(port, csrfToken) {
        return this.callApi(
            port,
            '/exa.language_server_pb.LanguageServerService/GetUserStatus',
            csrfToken,
            {}
        );
    }

    // ========================================
    // PHẦN 3: Kết nối & lấy quota
    // ========================================

    async connect() {
        console.log('[QuotaService] 🔍 Đang tìm Antigravity process...');
        const processes = this.findAntigravityProcesses();

        if (!processes.length) {
            console.log('[QuotaService] ❌ Không tìm thấy Antigravity process');
            return null;
        }

        console.log(`[QuotaService] ✅ Tìm thấy ${processes.length} process(es)`);
        const proc = processes[0];

        const ports = this.getListeningPorts(proc.pid);
        if (!ports.length) return null;

        const workingPort = await this.findWorkingPort(ports, proc.csrfToken);
        if (!workingPort) return null;

        console.log(`[QuotaService] ✅ Port hoạt động: ${workingPort}`);
        this._cachedConnection = { port: workingPort, csrfToken: proc.csrfToken };
        return this._cachedConnection;
    }

    async getQuotaData() {
        // Try cached connection first
        if (this._cachedConnection) {
            const data = await this.getUserStatus(this._cachedConnection.port, this._cachedConnection.csrfToken);
            if (data) return data;
            this._cachedConnection = null; // invalidate
        }

        // Reconnect
        const conn = await this.connect();
        if (!conn) return null;
        return this.getUserStatus(conn.port, conn.csrfToken);
    }

    // ========================================
    // PHẦN 4: Parse quota data
    // ========================================

    extractModels(data) {
        const userStatus = data.userStatus || data;
        const cascade = userStatus.cascadeModelConfigData || {};
        const clientConfigs = cascade.clientModelConfigs || [];

        return clientConfigs.map(cfg => {
            const quotaInfo = cfg.quotaInfo || {};
            const modelAlias = cfg.modelOrAlias || {};
            return {
                label: cfg.label || 'Unknown',
                modelId: modelAlias.model || '',
                remainingFraction: quotaInfo.remainingFraction ?? null,
                resetTime: quotaInfo.resetTime || '',
                isRecommended: cfg.isRecommended || false,
            };
        });
    }

    extractUserInfo(data) {
        const us = data.userStatus || data;
        const planStatus = us.planStatus || {};
        const planInfo = planStatus.planInfo || {};
        return {
            name: us.name || 'N/A',
            email: us.email || 'N/A',
            plan: planInfo.planName || planInfo.teamsTier || 'N/A',
            promptCredits: planStatus.availablePromptCredits ?? '?',
            flowCredits: planStatus.availableFlowCredits ?? '?',
            monthlyPrompt: planInfo.monthlyPromptCredits ?? '?',
            monthlyFlow: planInfo.monthlyFlowCredits ?? '?',
        };
    }

    formatTimeRemaining(resetTimeStr) {
        if (!resetTimeStr) return '';
        try {
            const resetTime = new Date(resetTimeStr);
            const now = new Date();
            const diffMs = resetTime - now;
            if (diffMs <= 0) return 'Đang reset...';

            const totalMin = Math.floor(diffMs / 60000);
            const hours = Math.floor(totalMin / 60);
            const minutes = totalMin % 60;

            if (hours >= 24) {
                const days = Math.floor(hours / 24);
                return `${days}d ${hours % 24}h ${minutes}m`;
            } else if (hours > 0) {
                return `${hours}h ${minutes}m`;
            }
            return `${minutes}m`;
        } catch {
            return resetTimeStr;
        }
    }

    // ========================================
    // PHẦN 5: Format cho Telegram
    // ========================================

    formatQuotaForTelegram(data) {
        if (!data) return null;

        const user = this.extractUserInfo(data);
        const models = this.extractModels(data);

        let msg = `📊 ANTIGRAVITY QUOTA\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `👤 ${user.name}\n`;
        msg += `⭐ Plan: ${user.plan}\n`;
        msg += `💳 Prompt: ${user.promptCredits} / ${user.monthlyPrompt}\n`;
        msg += `🌊 Flow: ${user.flowCredits} / ${user.monthlyFlow}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;

        if (models.length === 0) {
            msg += `⚠️ Không tìm thấy model nào.`;
            return msg;
        }

        for (const m of models) {
            const frac = m.remainingFraction;
            let icon, pctStr;
            if (frac !== null && frac !== undefined) {
                const pct = Math.round(frac * 100 * 10) / 10;
                if (pct >= 50) icon = '🟢';
                else if (pct >= 30) icon = '🟡';
                else if (pct > 0) icon = '🔴';
                else icon = '⛔';
                pctStr = `${pct}%`;
            } else {
                icon = '⚪';
                pctStr = 'N/A';
            }

            const countdown = this.formatTimeRemaining(m.resetTime);
            const rec = m.isRecommended ? ' ⭐' : '';
            msg += `${icon} ${m.label}${rec}: ${pctStr}`;
            if (countdown) msg += ` → ${countdown}`;
            msg += `\n`;
        }

        return msg.trim();
    }

    // ========================================
    // PHẦN 6: History Tracking
    // ========================================

    loadHistory() {
        try {
            return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
        } catch {
            return [];
        }
    }

    _saveHistoryFile(history) {
        // Keep max 2000 entries
        if (history.length > 2000) history = history.slice(-2000);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
    }

    saveToHistory(data) {
        const history = this.loadHistory();
        const models = this.extractModels(data);
        const user = this.extractUserInfo(data);

        const currSnapshot = {
            promptCredits: user.promptCredits,
            flowCredits: user.flowCredits,
            models: Object.fromEntries(models.map(m => [m.label, m.remainingFraction])),
        };

        // Check for changes
        if (history.length > 0) {
            const prev = history[history.length - 1];
            if (!this._hasChanges(prev, currSnapshot)) return false;
        }

        const entry = {
            timestamp: new Date().toISOString(),
            user: user.email,
            plan: user.plan,
            prompt_credits: user.promptCredits,
            flow_credits: user.flowCredits,
            models: models.map(m => ({
                label: m.label,
                remaining: m.remainingFraction,
                reset_time: m.resetTime,
            })),
        };

        // Compute deltas
        if (history.length > 0) {
            const deltas = this._computeDeltas(history[history.length - 1], currSnapshot);
            if (Object.keys(deltas).length > 0) entry.deltas = deltas;
        }

        history.push(entry);
        this._saveHistoryFile(history);
        return true;
    }

    _hasChanges(prevEntry, currSnapshot) {
        return Object.keys(this._computeDeltas(prevEntry, currSnapshot)).length > 0;
    }

    _computeDeltas(prevEntry, currSnapshot) {
        const deltas = {};

        // Credit deltas
        for (const key of ['prompt_credits', 'flow_credits']) {
            const snapshotKey = key === 'prompt_credits' ? 'promptCredits' : 'flowCredits';
            const prevVal = prevEntry[key];
            const currVal = currSnapshot[snapshotKey] ?? currSnapshot[key];
            if (typeof prevVal === 'number' && typeof currVal === 'number' && prevVal !== currVal) {
                deltas[key] = currVal - prevVal;
            }
        }

        // Model deltas
        const prevModels = {};
        for (const m of (prevEntry.models || [])) {
            prevModels[m.label] = m.remaining;
        }

        const modelDeltas = {};
        const currModels = currSnapshot.models || {};
        for (const [label, currFrac] of Object.entries(currModels)) {
            const prevFrac = prevModels[label];
            if (prevFrac !== undefined && prevFrac !== null && currFrac !== null) {
                const diff = Math.round((currFrac - prevFrac) * 1000) / 10;
                if (diff !== 0) modelDeltas[label] = diff;
            } else if (prevFrac === undefined && currFrac !== null) {
                modelDeltas[label] = 'NEW';
            }
        }

        if (Object.keys(modelDeltas).length > 0) deltas.models = modelDeltas;
        return deltas;
    }

    // ========================================
    // PHẦN 7: Format History cho Telegram
    // ========================================

    formatHistoryForTelegram(n = 10) {
        const history = this.loadHistory();
        if (!history.length) return '📭 Chưa có lịch sử quota. Gõ /quota để bắt đầu!';

        const recent = history.slice(-n);
        let msg = `📜 LỊCH SỬ QUOTA (${recent.length}/${history.length})\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;

        for (const entry of recent) {
            let ts;
            try {
                const dt = new Date(entry.timestamp);
                ts = `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
            } catch { ts = entry.timestamp?.substring(0, 16) || '?'; }

            const deltas = entry.deltas || {};

            // Credits line
            let creditLine = `💳${entry.prompt_credits}`;
            if (deltas.prompt_credits) {
                const sign = deltas.prompt_credits > 0 ? '+' : '';
                creditLine += `(${sign}${deltas.prompt_credits})`;
            }
            creditLine += ` 🌊${entry.flow_credits}`;
            if (deltas.flow_credits) {
                const sign = deltas.flow_credits > 0 ? '+' : '';
                creditLine += `(${sign}${deltas.flow_credits})`;
            }

            msg += `\n[${ts}] ${creditLine}\n`;

            // Model changes
            const modelDeltas = deltas.models || {};
            const changedModels = (entry.models || []).filter(m => {
                return m.label in modelDeltas;
            });

            if (changedModels.length > 0) {
                for (const m of changedModels) {
                    const d = modelDeltas[m.label];
                    const pct = m.remaining !== null ? Math.round(m.remaining * 100) + '%' : 'N/A';
                    if (d === 'NEW') {
                        msg += `  🆕 ${m.label}: ${pct}\n`;
                    } else {
                        const sign = d > 0 ? '+' : '';
                        const icon = d > 0 ? '📈' : '📉';
                        msg += `  ${icon} ${m.label}: ${pct} (${sign}${d}%)\n`;
                    }
                }
            }
        }

        return msg.trim();
    }
}

module.exports = QuotaService;
