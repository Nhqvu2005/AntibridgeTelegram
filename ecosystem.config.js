/**
 * PM2 Ecosystem Configuration — AntiBridge Telegram Bot
 *
 * Đảm bảo bot chạy 24/7, tự khởi động lại khi crash,
 * và log được lưu lại để debug.
 *
 * Cách dùng:
 *   pm2 start ecosystem.config.js     # Khởi động
 *   pm2 stop antibridge-bot           # Dừng
 *   pm2 restart antibridge-bot        # Khởi động lại
 *   pm2 logs antibridge-bot           # Xem log
 *   pm2 status                        # Xem trạng thái
 *   pm2 save                          # Lưu danh sách process
 *   pm2 startup                       # Tự động chạy khi boot Windows
 */

module.exports = {
    apps: [{
        name: 'antibridge-bot',
        script: './backend/safe-startup.js',
        cwd: __dirname,
        exec_mode: 'fork',
        autorestart: true,
        restart_delay: 3000,
        max_restarts: 10,
        min_uptime: 10000,
        watch: false,
        kill_timeout: 5000,
        log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
        error_file: './logs/pm2-error.log',
        out_file: './logs/pm2-out.log',
        merge_logs: true,
        env: {
            NODE_ENV: 'production'
        }
    }]
};
