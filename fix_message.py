import re

with open('E:/AntibridgeTelegram/backend/services/TerminalSession.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find the lines between "Thông báo" and ".catch"
start_idx = None
end_idx = None
for i, line in enumerate(lines):
    if 'Thông báo cho user' in line:
        start_idx = i
    if start_idx and '.catch(e =>' in line:
        end_idx = i
        break

if start_idx and end_idx:
    print(f"Found message lines {start_idx+1}-{end_idx+1}")
    # Replace with new message
    new_lines = [
        '            // Thông báo cho user biết cách resume trên máy tính\n',
        '            this.telegramBot.sendMessage(\n',
        f'                `🔄 Đã khởi động Claude với session ID:\\n\\`${{this.claudeSessionId}}\\`\\n\\n` +\n',
        '                `📝 *Resume trên máy tính:*\\n` +\n',
        f'                `\\`\\`\\`\\ncd ${{this.cwd}}\\n` +\n',
        f'                `claude --session-id ${{this.claudeSessionId}}\\n\\`\\`\\`\\n\\n` +\n',
        '                `Hoặc chạy file \\`claude-sync.bat\\` trong project.`,\n',
        '                { parse_mode: \'Markdown\' }\n',
        '            ).catch(e => console.log(`⚠️ [${this.name}] Send session info error: ${e.message}`));\n'
    ]
    lines[start_idx:end_idx+1] = new_lines
    with open('E:/AntibridgeTelegram/backend/services/TerminalSession.js', 'w', encoding='utf-8') as f:
        f.writelines(lines)
    print("OK: Replaced")
else:
    print(f"Not found: start={start_idx}, end={end_idx}")
