# 🌉 AntiBridge - Antigravity Telegram Remote

> Điều khiển Antigravity IDE từ xa qua Telegram — Chat AI, giám sát quota, và nhiều hơn thế.

[English Version](README_EN.md)

---

## ✨ Tính Năng

| Tính năng | Mô tả |
|-----------|-------|
| 💬 **Chat 2 chiều** | Gửi tin nhắn từ Telegram → Antigravity, nhận câu trả lời AI ngay trên Telegram |
| 📝 **Single Message** | Mọi update (thinking, streaming, final) trên **1 tin nhắn duy nhất** — không spam |
| 🔧 **CDP Injection** | Gửi lệnh qua Chrome DevTools Protocol — không chiếm chuột, không minimize cửa sổ |
| 📊 **Quota Monitor** | Xem % sử dụng các model AI (Claude, Gemini, GPT) qua API nội bộ |
| 🔄 **Auto Monitor** | Tự động check quota mỗi 5 phút, **chỉ ghi log khi có thay đổi** |
| 📜 **Quota History** | Xem lịch sử cộng/trừ quota với `/history_quota` — theo dõi delta |
| ⏱️ **Smart Polling** | Tự động điều chỉnh tốc độ polling (nhanh 3s → chậm 10s, tối đa 15 phút) |
| 🤖 **Đổi Model** | Chuyển đổi model AI ngay trên Telegram với `/model` |
| 📸 **Screenshot** | Chụp ảnh Antigravity IDE gửi về Telegram |
| 🗂️ **Conversations** | Chuyển đổi qua lại giữa các cuộc trò chuyện đang mở với `/conversations` |
| 📂 **Open Project** | Duyệt file system và mở dự án khác từ xa với `/open` |
| ⚡ **Skills** | Chạy các workflow/skill từ folder `.agent/workflows` với `/skills` |

---

## 🙏 Credits

Dự án này được phát triển dựa trên nền tảng [AntiBridge-Antigravity-remote](https://github.com/linhbq82/AntiBridge-Antigravity-remote) của **linhbq82**.

Xin chân thành cảm ơn tác giả gốc đã tạo ra công cụ tuyệt vời này. Phiên bản này là bản cập nhật và cải tiến thêm các tính năng mới.

---

## 📦 Cài Đặt

### Yêu cầu
- **Node.js** v18 trở lên
- **Antigravity IDE** đang chạy với cổng debug mở (mặc định: 9000)

### Hướng dẫn

```bash
# 1. Clone repo
git clone https://github.com/Nhqvu2005/AntibridgeTelegram.git
cd AntibridgeTelegram

# 2. Cài dependencies
npm install

# 3. Cấu hình
cp .env.example .env
# Mở file .env, điền:
#   TELEGRAM_BOT_TOKEN=<token từ @BotFather>
#   TELEGRAM_CHAT_ID=<chat ID của bạn>
#   CDP_PORT=9000
```

### Khởi chạy

**Windows** — Chạy file `START_TELEGRAM.bat`

**Hoặc chạy trực tiếp:**
```bash
npm run telegram
```

---

## 🎮 Các Lệnh Telegram

| Lệnh | Mô tả |
|-------|-------|
| `/start` | 👋 Khởi động bot, kiểm tra kết nối |
| `/status` | 📊 Trạng thái kết nối tới Antigravity |
| `/quota` | 📊 Xem quota model AI (realtime + lưu history) |
| `/history_quota` | 📜 Xem lịch sử thay đổi quota (cộng/trừ) |
| `/model` | 🎨 Đổi model AI (Claude, Gemini, GPT...) |
| `/stop` | ⏹️ Dừng AI đang trả lời |
| `/screenshot` | 📸 Chụp ảnh màn hình Antigravity |
| `/reconnect` | 🔄 Kết nối lại CDP |
| `/clear` | 🗑️ Xóa lịch sử chat |
| `/accept` | ✅ Accept action hiện tại |
| `/accept` | ✅ Accept action hiện tại |
| `/reject` | ❌ Reject action hiện tại |
| `/conversations` | 🗂️ Danh sách và chuyển đổi cuộc trò chuyện |
| `/open` | 📂 Duyệt file và mở dự án (Folder) |
| `/skills` | ⚡ Danh sách và chạy Skill (.md workflow) |

---

## 🛠️ Xử Lý Sự Cố

| Lỗi | Giải pháp |
|-----|-----------|
| `CDP Chat context NOT found` | Đảm bảo Antigravity đang mở và bạn đã login. Thử `/reconnect`. |
| `Không nhận được tin nhắn` | Kiểm tra `TELEGRAM_CHAT_ID` trong `.env` có đúng không. |
| `Bot không phản hồi` | Kiểm tra `TELEGRAM_BOT_TOKEN` và chạy lại `npm run telegram`. |

---

## 📄 License

MIT — Xem file [LICENSE](LICENSE) để biết thêm chi tiết.

**Disclaimer**: Đây là công cụ không chính thức, không liên kết với Antigravity. Sử dụng theo trách nhiệm cá nhân.
