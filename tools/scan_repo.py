# -*- coding: utf-8 -*-
"""scan_repo.py —— 发布前全量扫描：凭据 / 弱口令 / 本机路径 / 不应入库的文件类型。

为什么需要它：口令、模型 Key 一旦写进文档、脚本或提交历史，泄露不可逆。
因此把"发布前该看什么"固化成断言，命中即阻断，而不是靠记忆。

用法：
    python scan_repo.py <待检目录> [--git-status]

示例：
    python scan_repo.py .            # 扫当前仓库
    python scan_repo.py . --git-status   # 附带输出 git status

退出码：命中敏感项为 1，可用作 CI 门禁。
"""
import io, os, re, subprocess, sys

PATTERNS = {
    # 各家模型/服务的 API Key 特征
    "sk-key": re.compile(rb"sk-[A-Za-z0-9]{16,}"),
    "google-key": re.compile(rb"AIza[0-9A-Za-z\-_]{20,}"),
    "aws-key": re.compile(rb"AKIA[0-9A-Z]{16}"),
    # 本机绝对路径与开发机用户名（开源仓库不应出现本地隐私）
    "本机路径": re.compile(rb"[A-Za-z]:\\Users\\[A-Za-z0-9_]{3,}|[A-Za-z]:/Users/[A-Za-z0-9_]{3,}|/home/[A-Za-z0-9_]{3,}/"),
    "用户名残留": re.compile(rb"Users" + rb"[\\/]"),
    # 常见弱口令：必须出现在「口令赋值位置」才算命中。
    # ⚠ 不要用裸串匹配 123456789 —— 第三方库（base64 字典等）里遍地都是，会淹没真正的泄露。
    "弱口令": re.compile(
        rb"(?:ADMIN_PASS|COUNSELOR_PASS|SESSION_SECRET|SECRET|PASSWORD|PASSWD|PASS|secret)"
        rb"\s*[:=]\s*[\"']?(?:admin2026|counselor2026|admin123|password123|123456|123456789)",
        re.I),
    # 真实口令疑似：口令位被赋了一个「非占位、非注释」的值。
    # 为什么需要它：上一条只认已知弱值，而强口令照样能登进系统。真正的风险是
    # 「把线上在用的口令原样推到公开仓库」——不管它强还是弱，推上去就是泄露。
    # 因此这里不判断强度，只判断「这里是不是写了东西」，命中后由人工确认是否为真口令。
    # 注：占位值（"你的管理员强口令" / "随机长串"）都是中文或过短，天然不匹配；
    # 所以这里不写中文前向排除——bytes 字面量不允许含非 ASCII 字符。
    "真实口令疑似": re.compile(
        rb"(?:ADMIN_PASS|COUNSELOR_PASS|SESSION_SECRET)"
        rb"\s*[:=]\s*[\"']?[A-Za-z0-9_\-]{8,}"),
}

# 文件名层面：这些文件一律不该入库
BAD_NAME = re.compile(r"keys\.json$|口令\.txt$|.*\.sqlite.*|.*\.log$|^.*备份.*|.*\.zip$", re.I)

# 不入库的目录：扫它们既无意义（.gitignore 已排除）又会淹没在第三方代码的误报里
SKIP_DIR = re.compile(r"node_modules|\.git$|\.gradle|coverage", re.I)

# 白名单：规则文件自身必然包含上述模式，否则会自我命中
SELF = os.path.basename(__file__)

# 演示口令白名单：admin2026 / counselor2026 是项目自带的**本地演示**口令，已明确写进
# README 已公开这两组口令供下载者体验双角色，因此允许出现在启动脚本里——否则"下载即用"就无从谈起。
# ⚠ 只放行「启动树洞信箱.bat」一个文件：同样的值若出现在别的脚本、文档或
# 其它任何位置，仍然按可疑泄露处理。白名单意味着"文档已公开"，不意味着"值本身安全"，
# 这两组口令不在 fail-closed 自检名单里，对外公开前照旧必须换成强口令。
DEMO_PASS_VALUES = (b"admin2026", b"counselor2026")
DEMO_PASS_ALLOW_IN = ("启动树洞信箱.bat",)


def is_demo_pass_hit(label, rel, m):
    """判断一条命中是否属于「已公开的演示口令 + 允许出现的文件」组合。"""
    if label not in ("弱口令", "真实口令疑似"):
        return False
    if os.path.basename(rel) not in DEMO_PASS_ALLOW_IN:
        return False
    val = m.group().split(b"=")[-1].strip(b'"`\' \r\n')
    return val in DEMO_PASS_VALUES


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    root = sys.argv[1]
    with_status = "--git-status" in sys.argv

    files = []
    _demo_seen = set()          # 同一个文件里重复的放行项只提示一次
    for dirpath, dirnames, filenames in os.walk(root):
        # 剪枝而不是 continue：continue 只跳过当前目录，仍会继续往下走；
        # 且 .git / node_modules 必须整体剪掉，否则会把提交历史与第三方代码一起扫进来误报。
        dirnames[:] = [d for d in dirnames if not SKIP_DIR.search(d)]
        for fn in filenames:                       # ← 必须留在 os.walk 循环体内
            if fn == SELF:
                continue
            files.append(os.path.join(dirpath, fn))

    print("扫描文件数：%d\n" % len(files))
    hits = 0
    for f in files:
        name = os.path.basename(f)
        rel = os.path.relpath(f, root)
        if BAD_NAME.search(name):
            print("  [不应入库] %s" % rel)
            hits += 1
        try:
            data = io.open(f, "rb").read()
        except Exception as e:
            print("  [读不了] %s %s" % (rel, e))
            continue
        for label, pat in PATTERNS.items():
            for m in pat.finditer(data):
                if is_demo_pass_hit(label, rel, m):
                    key = (rel, m.group().split(b"=")[-1].strip(b'"`\' \r\n'))
                    if key in _demo_seen:
                        continue          # 放行项不计入 hits，否则扫描恒红、门禁失去意义
                    _demo_seen.add(key)
                    print("  [演示口令·放行] %s  ->  %r（公开值，仅允许出现在启动脚本）"
                          % (rel, m.group()[:60]))
                    continue
                print("  [%s] %s  ->  %r" % (label, rel, m.group()[:60]))
                hits += 1

    print("\n命中：%d" % hits)
    if with_status:
        try:
            r = subprocess.run(["git", "-C", root, "status", "--short"],
                               capture_output=True, text=True, encoding="utf-8")
            print("--- git status ---")
            print(r.stdout)
        except FileNotFoundError:
            print("(未安装 git，跳过 git status)")
    sys.exit(1 if hits else 0)


if __name__ == "__main__":
    main()
