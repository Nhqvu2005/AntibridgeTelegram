# 🌉 AntiBridge - Antigravity Telegram Remote

> Control Antigravity IDE remotely via Telegram — Chat with AI, monitor quotas, manage projects, and more.

[Phiên bản Tiếng Việt](README_VI.md)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 💬 **2-Way Chat** | Send messages from Telegram → Antigravity, receive AI responses directly on Telegram |
| 📝 **Single Message** | All updates (thinking, streaming, final) on **one single message** — no spam |
| 🔧 **CDP Injection** | Commands via Chrome DevTools Protocol — no mouse stealing, no window minimizing |
| 📊 **Quota Monitor** | View AI model usage (Claude, Gemini, GPT) via internal API |
| 🔄 **Auto Monitor** | Auto-check quota every 5 minutes, **only logs when changes detected** |
| 📜 **Quota History** | View quota change log with `/history_quota` — track deltas |
| ⏱️ **Smart Polling** | Auto-adjusting poll speed (fast 3s → slow 10s, max 15 min timeout) |
| 🤖 **Model Switch** | Switch AI models on Telegram with `/model` |
| 📸 **Screenshot** | Capture Antigravity IDE screenshot to Telegram |
| 🗂️ **Conversations** | Switch between open conversations with `/conversations` |
| 📂 **Open Project** | Browse file system and open projects remotely with `/open` (paginated, edit-in-place) |
| ⚡ **Workflows** | Run workflow files from `.agent/workflows` with `/workflows` |
| 🛠️ **Skills** | Run skill folders from `.agent/skills` with `/skills` |
| 🔴 **End Task** | Kill Antigravity process remotely with `/endtask` |

---

## 🙏 Credits

This project is built upon [AntiBridge-Antigravity-remote](https://github.com/linhbq82/AntiBridge-Antigravity-remote) by **linhbq82**.

Special thanks to the original author for creating such an amazing tool. This version adds new features and improvements.

---

## 📦 Installation

### Requirements
- **Node.js** v18+
- **Antigravity IDE** running with debug port open (default: 9000)

### Setup

```bash
# 1. Clone repo
git clone https://github.com/Nhqvu2005/AntibridgeTelegram.git
cd AntibridgeTelegram

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
# Edit .env file:
#   TELEGRAM_BOT_TOKEN=<token from @BotFather>
#   TELEGRAM_CHAT_ID=<your chat ID>
#   CDP_PORT=9000
```

### Run

**Windows** — Run `START_TELEGRAM.bat`

**Or run directly:**
```bash
npm run telegram
```

---

## 🎮 Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | 👋 Start bot, check connection |
| `/status` | 📊 Connection status to Antigravity |
| `/quota` | 📊 View AI model quotas (realtime + saved to history) |
| `/history_quota` | 📜 View quota change log (deltas only) |
| `/model` | 🎨 Switch AI model (Claude, Gemini, GPT...) |
| `/stop` | ⏹️ Stop AI generation |
| `/screenshot` | 📸 Screenshot Antigravity IDE |
| `/reconnect` | 🔄 Reconnect to CDP |
| `/clear` | 🗑️ Clear chat history |
| `/accept` | ✅ Accept current action |
| `/reject` | ❌ Reject current action |
| `/conversations` | 🗂️ List & switch conversations |
| `/open` | 📂 Browse files & open projects (with pagination) |
| `/setproject <path>` | 📁 Manually set project root |
| `/workflows` | ⚡ Run workflows from `.agent/workflows` |
| `/skills` | 🛠️ Run skills from `.agent/skills` |
| `/endtask` | 🔴 Kill Antigravity process |

---

## 🏗️ Architecture

```
Telegram ←→ TelegramBot.js ←→ AntigravityBridge.js ←→ CDP ←→ Antigravity IDE
                ↕                       ↕
          QuotaService.js         chat_bridge_ws.js
                                  detect_actions.js
```

- **TelegramBot.js** — Handles Telegram commands, message routing, UI (pagination, inline keyboards)
- **AntigravityBridge.js** — CDP connection, DOM injection, conversation/project management
- **QuotaService.js** — Quota monitoring, history tracking, formatted reporting
- **chat_bridge_ws.js** — WebSocket bridge injected into Antigravity for real-time message capture
- **detect_actions.js** — Detects Accept/Reject action buttons in the IDE

---

## 🛠️ Troubleshooting

| Error | Solution |
|-------|----------|
| `CDP Chat context NOT found` | Ensure Antigravity is open and logged in. Try `/reconnect`. |
| `Not receiving messages` | Check `TELEGRAM_CHAT_ID` in `.env`. |
| `Bot not responding` | Verify `TELEGRAM_BOT_TOKEN` and restart with `npm run telegram`. |
| `Port 8000 in use` | Kill existing node processes: `taskkill /F /IM node.exe` |

---

## 📄 License

MIT — See [LICENSE](LICENSE) for details.

**Disclaimer**: This is an unofficial tool and is not affiliated with Antigravity. Use at your own risk.
