const pty = require('node-pty');
const ptyProcess = pty.spawn('powershell.exe', [], {
    name: 'xterm-256color', cols: 80, rows: 150,
    cwd: 'E:\\AntibridgeTelegram', env: process.env
});
let output = '';
ptyProcess.onData((data) => { output += data; });
setTimeout(() => {
    ptyProcess.write('$env:TERM; $env:SESSION_ID; $env:CLAUDE_CODE* 2>$null; echo "---"; $env:USERPROFILE; echo "---"; (Get-ChildItem Env:CLAUDE* | Format-Table -AutoSize | Out-String)\r');
}, 2000);
setTimeout(() => {
    console.log(output.slice(-3000));
    ptyProcess.kill();
    process.exit(0);
}, 6000);
