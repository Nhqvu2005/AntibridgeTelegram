# AntiBridge - Antigravity Remote

**[Tiếng Việt]**  
Một cầu nối mạnh mẽ giữa **Antigravity IDE** và **Telegram**, cho phép bạn điều khiển, chat và giám sát AI từ xa.

**[English]**  
A powerful bridge between **Antigravity IDE** and **Telegram**, allowing you to control, chat, and monitor your AI remotely.

---

## 🌟 Tính Năng Nổi Bật / Key Features

- **✅ Chat 2 chiều / 2-way Chat**: Gửi tin nhắn từ Telegram vào Antigravity và nhận câu trả lời AI.
- **✅ Smart Polling**: Tự động điều chỉnh thời gian chờ (ngắn/dài) để bắt trọn vẹn câu trả lời mà không lo timeout.
- **✅ Single Message UI**: Cập nhật câu trả lời AI liên tục trên **một tin nhắn duy nhất**, không spam tin nhắn mới.
- **✅ CDP Direct Injection**: Gửi lệnh trực tiếp qua Chrome DevTools Protocol (CDP) — **không chiếm chuột, không minimize cửa sổ**.
- **✅ Quota Monitor**: Xem dung lượng sử dụng các model AI ngay trên Telegram với lệnh `/quota`.
- **✅ Multi-Model Supports**: Hỗ trợ chuyển đổi model AI dễ dàng.

---

## Credits

Dự án này được phát triển dựa trên core của [AntiBridge-Antigravity-remote](https://github.com/linhbq82/AntiBridge-Antigravity-remote).
Xin chân thành cảm ơn tác giả **linhbq82** đã đặt nền móng cho công cụ tuyệt vời này.

This project is built upon the core of [AntiBridge-Antigravity-remote](https://github.com/linhbq82/AntiBridge-Antigravity-remote).
Special thanks to **linhbq82** for laying the foundation for this amazing tool.

---

## 📦 Cài Đặt / Installation

### Yêu cầu / Requirements
- Node.js (v18+)
- Antigravity IDE (đang chạy với cổng debug mở sẵn)

### Các bước / Steps

1. **Clone repo & Install dependencies**:
   ```bash
   git clone https://github.com/htcba/AntibridgeTelegram.git
   cd AntibridgeTelegram
   npm install
   ```

2. **Cấu hình / Configuration**:
   - Copy file `.env.example` thành `.env`:
     ```bash
     cp .env.example .env
     ```
   - Điền thông tin vào `.env`:
     ```ini
     TELEGRAM_BOT_TOKEN=your_bot_token_here
     TELEGRAM_CHAT_ID=your_chat_id_here
     CDP_PORT=9000  # Default Antigravity debug port
     ```

3. **Khởi chạy / Run**:
   - Chạy file `START_TELEGRAM.bat` (Windows)
   - Hoặc chạy lệnh:
     ```bash
     npm start
     ```

---

## 🎮 Sử dụng / Usage

Sau khi khởi chạy, bot Telegram của bạn sẽ online. Bạn có thể sử dụng các lệnh sau:

| Lệnh / Command | Mô tả / Description |
|----------------|---------------------|
| `/start`       | Khởi động và kiểm tra kết nối |
| `/status`      | Kiểm tra trạng thái kết nối tới Antigravity |
| `/quota`       | 📊 Xem dung lượng sử dụng các model AI |
| `/stop`        | Dừng AI đang trả lời (Stop generation) |
| `/clear`       | Xóa lịch sử chat (New context) |
| `/screenshot`  | Chụp ảnh màn hình Antigravity gửi về Tele |
| `/reconnect`   | Kết nối lại tới CDP nếu bị mất kết nối |

---

## 🛠️ Troubleshoot

- **Lỗi "CDP Chat context not found"**: Đảm bảo Antigravity đang mở và bạn đã login.
- **Không nhận được tin nhắn**: Kiểm tra `TELEGRAM_CHAT_ID` có đúng không.

---

**Disclaimer**: This is an unofficial tool and is not affiliated with Antigravity. Use at your own risk.
