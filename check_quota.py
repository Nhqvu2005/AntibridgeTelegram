"""
Antigravity Quota Checker
Đọc quota còn lại của Antigravity AI từ local process.
Reverse-engineered từ Antigravity Cockpit extension v2.1.20.

Cách hoạt động:
1. Tìm process language_server_windows_x64.exe đang chạy
2. Lấy extension_server_port và csrf_token từ command line
3. Tìm port đang listen
4. Gọi API GetUserStatus qua HTTPS để lấy quota
"""

import subprocess
import json
import re
import ssl
import urllib.request
import sys
from datetime import datetime, timedelta


# ============================================================
#  PHẦN 1: Tìm process Antigravity
# ============================================================

def find_antigravity_processes():
    """Tìm tất cả process language_server có csrf_token (= Antigravity)."""
    cmd = (
        'chcp 65001 >nul && powershell -NoProfile -Command "'
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.CommandLine -match 'csrf_token' } | "
        "Select-Object ProcessId,Name,CommandLine | "
        'ConvertTo-Json"'
    )
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=15
        )
        output = result.stdout.strip()
        if not output:
            return []

        # Tìm vị trí JSON bắt đầu
        for i, ch in enumerate(output):
            if ch in ('[', '{'):
                output = output[i:]
                break

        data = json.loads(output)
        if isinstance(data, dict):
            data = [data]

        processes = []
        for proc in data:
            cmdline = proc.get("CommandLine", "")
            if not cmdline:
                continue

            # Phải có cả extension_server_port và csrf_token và app_data_dir antigravity
            if "--extension_server_port" not in cmdline:
                continue
            if "--csrf_token" not in cmdline:
                continue

            pid = proc.get("ProcessId")
            port_match = re.search(r'--extension_server_port[=\s]+(\d+)', cmdline)
            token_match = re.search(r'--csrf_token[=\s]+([a-f0-9-]+)', cmdline, re.I)

            if not token_match:
                continue

            ext_port = int(port_match.group(1)) if port_match else 0
            csrf_token = token_match.group(1)

            processes.append({
                "pid": pid,
                "extension_port": ext_port,
                "csrf_token": csrf_token,
            })

        return processes
    except Exception as e:
        print(f"[ERROR] Không tìm được process: {e}")
        return []


def get_listening_ports(pid):
    """Lấy danh sách port đang listen của 1 PID."""
    cmd = (
        f'chcp 65001 >nul && powershell -NoProfile -NonInteractive -Command "'
        f'[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
        f'$ports = Get-NetTCPConnection -State Listen -OwningProcess {pid} '
        f'-ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort; '
        f'if ($ports) {{ $ports | Sort-Object -Unique }}"'
    )
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=10
        )
        ports = []
        for line in result.stdout.strip().split('\n'):
            line = line.strip()
            if line.isdigit():
                p = int(line)
                if 0 < p <= 65535:
                    ports.append(p)
        return sorted(set(ports))
    except Exception as e:
        print(f"[WARN] Không lấy được port cho PID {pid}: {e}")
        return []


# ============================================================
#  PHẦN 2: Gọi API GetUserStatus
# ============================================================

def call_api(port, path, csrf_token, body=None):
    """Gọi HTTPS POST đến localhost Antigravity server."""
    if body is None:
        body = {}

    url = f"https://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode("utf-8")

    # Bỏ qua SSL verify vì là localhost self-signed
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "X-Codeium-Csrf-Token": csrf_token,
        },
    )

    try:
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return None


def ping_port(port, csrf_token):
    """Kiểm tra port có phải Antigravity server không."""
    result = call_api(
        port,
        "/exa.language_server_pb.LanguageServerService/GetUnleashData",
        csrf_token,
        {"wrapper_data": {}},
    )
    return result is not None


def find_working_port(ports, csrf_token):
    """Tìm port đang hoạt động từ danh sách ports."""
    for port in ports:
        if ping_port(port, csrf_token):
            return port
    return None


def get_user_status(port, csrf_token):
    """Lấy thông tin quota từ GetUserStatus API."""
    return call_api(
        port,
        "/exa.language_server_pb.LanguageServerService/GetUserStatus",
        csrf_token,
        {},
    )


# ============================================================
#  PHẦN 3: Parse và hiển thị quota
# ============================================================

def format_time_remaining(reset_time_str):
    """Tính thời gian còn lại đến khi reset."""
    try:
        # Thử parse nhiều format
        for fmt in ["%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S"]:
            try:
                reset_time = datetime.strptime(reset_time_str, fmt)
                break
            except ValueError:
                continue
        else:
            return reset_time_str

        now = datetime.utcnow()
        diff = reset_time - now
        if diff.total_seconds() <= 0:
            return "Đang reset..."

        hours = int(diff.total_seconds() // 3600)
        minutes = int((diff.total_seconds() % 3600) // 60)
        if hours >= 24:
            days = hours // 24
            hours = hours % 24
            return f"{days}d {hours}h {minutes}m"
        elif hours > 0:
            return f"{hours}h {minutes}m"
        else:
            return f"{minutes}m"
    except:
        return reset_time_str


def extract_models(data):
    """Trích xuất danh sách model + quota từ API response."""
    user_status = data.get("userStatus", data)
    
    # Path: userStatus.cascadeModelConfigData.clientModelConfigs[]
    cascade = user_status.get("cascadeModelConfigData", {})
    client_configs = cascade.get("clientModelConfigs", [])
    
    models = []
    for cfg in client_configs:
        quota_info = cfg.get("quotaInfo", {})
        model_alias = cfg.get("modelOrAlias", {})
        
        label = cfg.get("label", "Unknown")
        model_id = model_alias.get("model", "")
        remaining_fraction = quota_info.get("remainingFraction")
        reset_time = quota_info.get("resetTime", "")
        is_recommended = cfg.get("isRecommended", False)
        supports_images = cfg.get("supportsImages", False)
        
        models.append({
            "label": label,
            "model_id": model_id,
            "remaining_fraction": remaining_fraction,
            "reset_time": reset_time,
            "is_recommended": is_recommended,
            "supports_images": supports_images,
        })
    
    return models


def extract_user_info(data):
    """Trích xuất thông tin user và credits."""
    us = data.get("userStatus", data)
    plan_status = us.get("planStatus", {})
    plan_info = plan_status.get("planInfo", {})
    
    return {
        "name": us.get("name", "N/A"),
        "email": us.get("email", "N/A"),
        "plan": plan_info.get("planName", plan_info.get("teamsTier", "N/A")),
        "prompt_credits": plan_status.get("availablePromptCredits", "?"),
        "flow_credits": plan_status.get("availableFlowCredits", "?"),
        "monthly_prompt": plan_info.get("monthlyPromptCredits", "?"),
        "monthly_flow": plan_info.get("monthlyFlowCredits", "?"),
    }


def display_quota(data):
    """Hiển thị quota đẹp từ dữ liệu API."""
    if not data:
        print("[ERROR] Không nhận được dữ liệu quota!")
        return

    # Lưu raw data
    timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    raw_file = f"quota_raw_{timestamp}.json"
    with open(raw_file, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"\n📁 Dữ liệu thô: {raw_file}")

    print("\n" + "=" * 70)
    print("🚀 ANTIGRAVITY QUOTA STATUS")
    print(f"📅 Thời gian: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 70)

    # User info
    user = extract_user_info(data)
    print(f"\n👤 User: {user['name']} ({user['email']})")
    print(f"⭐ Plan: {user['plan']}")
    print(f"💳 Prompt Credits: {user['prompt_credits']} / {user['monthly_prompt']}")
    print(f"🌊 Flow Credits:   {user['flow_credits']} / {user['monthly_flow']}")

    # Models
    models = extract_models(data)
    if models:
        print(f"\n{'─' * 70}")
        print(f"  {'Model':<35} {'Còn lại':>10} {'Reset (UTC)':>14} {'Countdown':>10}")
        print(f"{'─' * 70}")

        for m in models:
            label = m["label"]
            frac = m["remaining_fraction"]
            reset_raw = m["reset_time"]
            
            # Phần trăm
            if frac is not None:
                pct = round(frac * 100, 1)
                if pct >= 50:
                    icon = "🟢"
                elif pct >= 30:
                    icon = "🟡"
                elif pct > 0:
                    icon = "🔴"
                else:
                    icon = "⛔"
                pct_str = f"{icon} {pct}%"
            else:
                pct_str = "  N/A"

            # Reset time
            countdown = format_time_remaining(reset_raw) if reset_raw else ""
            reset_display = ""
            if reset_raw:
                try:
                    for fmt in ["%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"]:
                        try:
                            dt = datetime.strptime(reset_raw, fmt)
                            reset_display = dt.strftime("%H:%M")
                            break
                        except ValueError:
                            continue
                except:
                    reset_display = str(reset_raw)[:16]

            # Recommended marker
            rec = " ⭐" if m["is_recommended"] else ""
            print(f"  {label + rec:<35} {pct_str:>10} {reset_display:>14} {countdown:>10}")
    else:
        print("\n⚠️  Không tìm thấy model nào.")
        print("    Response keys:", list(data.keys()))

    print(f"\n{'=' * 70}")


# ============================================================
#  PHẦN 4: Quota History với Delta Tracking
# ============================================================

HISTORY_FILE = "quota_history.json"


def load_history():
    """Load lịch sử quota từ file."""
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _build_snapshot(data):
    """Tạo snapshot từ API data để so sánh."""
    models = extract_models(data)
    user = extract_user_info(data)
    return {
        "prompt_credits": user["prompt_credits"],
        "flow_credits": user["flow_credits"],
        "models": {
            m["label"]: m["remaining_fraction"]
            for m in models
        },
    }


def _compute_deltas(prev_entry, curr_snapshot):
    """So sánh snapshot hiện tại với entry trước, trả về dict deltas."""
    deltas = {}

    # Credits delta
    for key in ("prompt_credits", "flow_credits"):
        prev_val = prev_entry.get(key)
        curr_val = curr_snapshot.get(key)
        if isinstance(prev_val, (int, float)) and isinstance(curr_val, (int, float)):
            diff = curr_val - prev_val
            if diff != 0:
                deltas[key] = diff

    # Model deltas
    prev_models = {}
    for m in prev_entry.get("models", []):
        prev_models[m["label"]] = m.get("remaining")

    model_deltas = {}
    for label, curr_frac in curr_snapshot["models"].items():
        prev_frac = prev_models.get(label)
        if prev_frac is not None and curr_frac is not None:
            diff = round((curr_frac - prev_frac) * 100, 1)
            if diff != 0:
                model_deltas[label] = diff
        elif prev_frac is None and curr_frac is not None:
            model_deltas[label] = "NEW"

    if model_deltas:
        deltas["models"] = model_deltas

    return deltas


def _has_changes(prev_entry, curr_snapshot):
    """Kiểm tra xem quota có thay đổi so với lần trước không."""
    return len(_compute_deltas(prev_entry, curr_snapshot)) > 0


def save_to_history(data, force=False):
    """Lưu snapshot quota — chỉ lưu khi có thay đổi (hoặc force=True)."""
    history = load_history()

    models = extract_models(data)
    user = extract_user_info(data)
    curr_snapshot = _build_snapshot(data)

    # So sánh với entry trước
    deltas = {}
    if history and not force:
        prev = history[-1]
        if not _has_changes(prev, curr_snapshot):
            print("  ⏸️  Quota không thay đổi, bỏ qua.")
            return False
        deltas = _compute_deltas(prev, curr_snapshot)

    entry = {
        "timestamp": datetime.now().isoformat(),
        "user": user["email"],
        "plan": user["plan"],
        "prompt_credits": user["prompt_credits"],
        "flow_credits": user["flow_credits"],
        "models": [
            {
                "label": m["label"],
                "remaining": m["remaining_fraction"],
                "reset_time": m["reset_time"],
            }
            for m in models
        ],
    }

    if deltas:
        entry["deltas"] = deltas

    history.append(entry)

    # Giữ tối đa 2000 entries
    max_entries = 2000
    if len(history) > max_entries:
        history = history[-max_entries:]

    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=2, ensure_ascii=False)

    # Hiển thị delta ngay
    if deltas:
        print(f"\n  � THAY ĐỔI SO VỚI LẦN TRƯỚC:")
        if "prompt_credits" in deltas:
            d = deltas["prompt_credits"]
            sign = "+" if d > 0 else ""
            print(f"     💳 Prompt Credits: {sign}{d}")
        if "flow_credits" in deltas:
            d = deltas["flow_credits"]
            sign = "+" if d > 0 else ""
            print(f"     🌊 Flow Credits:   {sign}{d}")
        if "models" in deltas:
            for label, d in deltas["models"].items():
                if d == "NEW":
                    print(f"     🆕 {label}: mới xuất hiện")
                else:
                    sign = "+" if d > 0 else ""
                    print(f"     {'📈' if d > 0 else '📉'} {label}: {sign}{d}%")
    else:
        print("  📝 Lần đầu ghi nhận (chưa có dữ liệu trước để so sánh)")

    print(f"  📊 History: {len(history)} entries")
    return True


def _format_delta(val):
    """Format delta value với dấu +/-."""
    if isinstance(val, str):
        return val
    sign = "+" if val > 0 else ""
    return f"{sign}{val}"


def show_history(n=20):
    """Hiển thị n entries gần nhất với delta."""
    history = load_history()
    if not history:
        print("\n📭 Chưa có lịch sử quota. Hãy chạy check trước!")
        return

    recent = history[-n:]
    print(f"\n{'=' * 80}")
    print(f"📊 QUOTA HISTORY (gần nhất {len(recent)}/{len(history)} entries)")
    print(f"{'=' * 80}")

    for i, entry in enumerate(recent):
        ts = entry.get("timestamp", "?")
        try:
            dt = datetime.fromisoformat(ts)
            ts_display = dt.strftime("%m/%d %H:%M:%S")
        except:
            ts_display = ts[:19]

        prompt_c = entry.get("prompt_credits", "?")
        flow_c = entry.get("flow_credits", "?")
        deltas = entry.get("deltas", {})

        # Credits với delta
        pc_delta = ""
        if "prompt_credits" in deltas:
            pc_delta = f" ({_format_delta(deltas['prompt_credits'])})"
        fc_delta = ""
        if "flow_credits" in deltas:
            fc_delta = f" ({_format_delta(deltas['flow_credits'])})"

        print(f"\n  [{ts_display}] 💳 Prompt:{prompt_c}{pc_delta}  🌊 Flow:{flow_c}{fc_delta}")

        # Model deltas
        model_deltas = deltas.get("models", {})
        models = entry.get("models", [])

        parts = []
        for m in models:
            label = m.get("label", "?")
            frac = m.get("remaining")
            if frac is not None:
                pct = round(frac * 100)
                short = label[:15]
                d_str = ""
                if label in model_deltas:
                    d = model_deltas[label]
                    if d != "NEW":
                        d_str = f"({'+' if d > 0 else ''}{d}%)"
                    else:
                        d_str = "(NEW)"
                parts.append(f"{short}:{pct}%{d_str}")

        if parts:
            # Hiện 3 model mỗi dòng
            for j in range(0, len(parts), 3):
                chunk = " | ".join(parts[j:j+3])
                print(f"    {chunk}")

    print(f"\n{'=' * 80}")

# ============================================================
#  PHẦN 5: Change Log — Lịch sử thay đổi từng model
# ============================================================

def show_change_log(n=50):
    """Hiển thị lịch sử thay đổi theo từng model + credits, có thời gian."""
    history = load_history()
    if len(history) < 2:
        print("\n📭 Cần ít nhất 2 lần check để có lịch sử thay đổi.")
        return

    # Thu thập tất cả changes
    credit_changes = []   # [{ts, type, before, after, delta}]
    model_changes = {}     # {label: [{ts, before, after, delta}]}

    for i in range(1, len(history)):
        prev = history[i - 1]
        curr = history[i]
        ts = curr.get("timestamp", "?")
        try:
            dt = datetime.fromisoformat(ts)
            ts_display = dt.strftime("%m/%d %H:%M:%S")
        except:
            ts_display = ts[:19]

        # Credits changes
        for key, emoji, label in [
            ("prompt_credits", "💳", "Prompt Credits"),
            ("flow_credits", "🌊", "Flow Credits"),
        ]:
            prev_val = prev.get(key)
            curr_val = curr.get(key)
            if isinstance(prev_val, (int, float)) and isinstance(curr_val, (int, float)):
                diff = curr_val - prev_val
                if diff != 0:
                    credit_changes.append({
                        "ts": ts_display,
                        "type": label,
                        "emoji": emoji,
                        "before": prev_val,
                        "after": curr_val,
                        "delta": diff,
                    })

        # Model changes
        prev_models = {}
        for m in prev.get("models", []):
            prev_models[m["label"]] = m.get("remaining")

        for m in curr.get("models", []):
            label = m.get("label", "?")
            curr_frac = m.get("remaining")
            prev_frac = prev_models.get(label)

            if prev_frac is not None and curr_frac is not None:
                diff = round((curr_frac - prev_frac) * 100, 1)
                if diff != 0:
                    if label not in model_changes:
                        model_changes[label] = []
                    model_changes[label].append({
                        "ts": ts_display,
                        "before": round(prev_frac * 100, 1),
                        "after": round(curr_frac * 100, 1),
                        "delta": diff,
                    })

    # Hiển thị
    print(f"\n{'=' * 75}")
    print(f"📜 LỊCH SỬ THAY ĐỔI (từ {len(history)} lần check)")
    print(f"{'=' * 75}")

    # Credits
    if credit_changes:
        print(f"\n  {'─' * 70}")
        print(f"  💰 CREDITS:")
        print(f"  {'─' * 70}")
        for c in credit_changes[-n:]:
            sign = "+" if c["delta"] > 0 else ""
            icon = "📈" if c["delta"] > 0 else "📉"
            print(f"  {icon} [{c['ts']}] {c['emoji']} {c['type']}: "
                  f"{c['before']} → {c['after']} ({sign}{c['delta']})")
    else:
        print(f"\n  💰 Credits: Chưa có thay đổi")

    # Models
    if model_changes:
        print(f"\n  {'─' * 70}")
        print(f"  🤖 MODELS:")
        print(f"  {'─' * 70}")
        for label in sorted(model_changes.keys()):
            changes = model_changes[label][-n:]
            total_delta = sum(c["delta"] for c in changes)
            sign_total = "+" if total_delta > 0 else ""
            current = changes[-1]["after"]
            print(f"\n  ▸ {label}  (hiện tại: {current}%, tổng thay đổi: {sign_total}{total_delta}%)")
            for c in changes:
                sign = "+" if c["delta"] > 0 else ""
                icon = "📈" if c["delta"] > 0 else "📉"
                print(f"    {icon} [{c['ts']}] {c['before']}% → {c['after']}% ({sign}{c['delta']}%)")
    else:
        print(f"\n  🤖 Models: Chưa có thay đổi")

    print(f"\n{'=' * 75}")


# ============================================================
#  PHẦN 6: Kết nối đến Antigravity process
# ============================================================

def connect_to_antigravity(quiet=False):
    """Tìm và kết nối đến Antigravity process. Trả về (port, csrf_token) hoặc None."""
    if not quiet:
        print("🔍 Đang tìm Antigravity process...")
    processes = find_antigravity_processes()

    if not processes:
        if not quiet:
            print("\n❌ Không tìm thấy Antigravity! Hãy đảm bảo:")
            print("   1. Antigravity IDE đang mở")
            print("   2. Process language_server đang chạy")
        return None

    if not quiet:
        print(f"✅ Tìm thấy {len(processes)} Antigravity process(es)")

    proc = processes[0]
    if not quiet:
        print(f"  Process: PID={proc['pid']}, ExtPort={proc['extension_port']}")

    ports = get_listening_ports(proc["pid"])
    if not ports:
        if not quiet:
            print("  ⚠️  Không tìm thấy port nào")
        return None

    working_port = find_working_port(ports, proc["csrf_token"])
    if not working_port:
        if not quiet:
            print("  ⚠️  Không tìm thấy port phản hồi")
        return None

    if not quiet:
        print(f"  ✅ Port hoạt động: {working_port}")

    return working_port, proc["csrf_token"]


# ============================================================
#  PHẦN 7: MAIN + Monitor Mode
# ============================================================

def main():
    conn = connect_to_antigravity()
    if not conn:
        sys.exit(1)

    port, token = conn
    print("  📊 Đang lấy quota...")
    data = get_user_status(port, token)

    if data:
        display_quota(data)
        save_to_history(data)
        # Luôn hiện change log
        show_change_log()
    else:
        print("  ❌ Không lấy được dữ liệu quota")


def monitor(interval=60):
    """Chế độ giám sát liên tục — poll mỗi N giây, chỉ ghi khi có thay đổi."""
    import time

    print(f"🔄 MONITOR MODE — Check mỗi {interval} giây (Ctrl+C để dừng)")
    print(f"   Chỉ ghi lịch sử khi quota THAY ĐỔI\n")

    conn = connect_to_antigravity()
    if not conn:
        sys.exit(1)
    port, token = conn

    # Lần đầu luôn check + display
    data = get_user_status(port, token)
    if data:
        display_quota(data)
        save_to_history(data, force=True)

    check_count = 1
    change_count = 0

    try:
        while True:
            time.sleep(interval)
            check_count += 1
            now = datetime.now().strftime("%H:%M:%S")

            # Thử lấy data (quiet mode)
            data = get_user_status(port, token)
            if not data:
                # Có thể process restart, thử reconnect
                print(f"  [{now}] ⚠️  Mất kết nối, đang thử lại...")
                conn = connect_to_antigravity(quiet=True)
                if conn:
                    port, token = conn
                    data = get_user_status(port, token)

            if not data:
                print(f"  [{now}] ❌ Không lấy được data (check #{check_count})")
                continue

            changed = save_to_history(data)
            if changed:
                change_count += 1
                # Hiện bảng quota + change log khi có thay đổi
                display_quota(data)
                show_change_log(20)
            else:
                print(f"  [{now}] ✅ Không đổi (check #{check_count}, {change_count} changes)")

    except KeyboardInterrupt:
        print(f"\n\n🛑 Dừng monitor. Tổng: {check_count} checks, {change_count} thay đổi")
        show_change_log()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        main()
    elif sys.argv[1] in ("history", "--history"):
        show_history(int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 20)
    elif sys.argv[1] in ("log", "--log", "-l"):
        show_change_log(int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 50)
    elif sys.argv[1] in ("monitor", "--monitor", "-m"):
        interval = 30
        if len(sys.argv) > 2 and sys.argv[2].isdigit():
            interval = max(10, int(sys.argv[2]))
        monitor(interval)
    else:
        print("Usage:")
        print("  python check_quota.py              # Check 1 lần + hiện change log")
        print("  python check_quota.py log [N]       # Xem lịch sử thay đổi từng model")
        print("  python check_quota.py history [N]   # Xem N entries gần nhất")
        print("  python check_quota.py monitor [N]   # Giám sát liên tục mỗi N giây")

