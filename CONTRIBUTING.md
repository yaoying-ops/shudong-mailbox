# 贡献指南

树洞信箱是一个面向高校心理健康场景的开源项目。我们欢迎任何形式的参与：提交缺陷、补充文档、改进交互、优化后端性能、加入新的统计口径。

在动手之前，请花两分钟读完本文档——尤其是**「红线」那一节**。这个项目处理的是学生的情绪倾诉内容，一次 careless 的提交造成的后果远大于普通开源项目。

## 一、五分钟跑起来

```bash
git clone <你的 fork 地址>
cd shudong
cd 树洞信箱Web版/server
npm install          # 首次需要，better-sqlite3 会下载预编译二进制
node server.js       # 访问 http://localhost:3000/ 与 http://localhost:3000/center
```

**版本要求：Node 18 – 22（推荐 20 LTS）。** `better-sqlite3@11` 的**早期版本**在 Node 23/24 下没有预编译二进制，`npm install` 会静默通过，但启动时抛 `ERR_DLOPEN_FAILED`；当前锁定的 `11.10.0` 已补上 Node 24 预编译（本项目在 Node 24 上实测可跑），但为稳妥仍建议按 20 LTS 走。

Windows 用户也可以直接双击 `启动树洞信箱.bat`（会自动找 node、首次自动装依赖），中心端默认用演示口令登录：管理员 `admin2026`、咨询师 `counselor2026`。想换成自己的口令，直接改 bat 里 `ADMIN_PASS` / `COUNSELOR_PASS` 两行的值；命中弱口令自检会拒绝启动。

命令行等价写法（bat 做的事就这些）。口令沿用上表：`ADMIN_PASS` / `COUNSELOR_PASS`。

```bash
set ADMIN_PASS=<管理员口令，见 README「本地演示口令」>
set COUNSELOR_PASS=<咨询师口令，见 README「本地演示口令」>
node server.js
```

模型 Key 不入库，复制模板再填。**注意位置：`keys.json` 必须与 `keys.json.example` 同在 `树洞信箱Web版/` 下**，放到仓库根目录不会生效，表现为 AI 接口一直返回 503。

```bash
# 回到仓库根目录再执行（此时上一段已 cd 到 树洞信箱Web版/server）
cp 树洞信箱Web版/keys.json.example 树洞信箱Web版/keys.json
```

## 二、改代码前要知道的四件事

1. **前端只有一份真身。** 学生端 `树洞信箱Web版/树洞信箱_原型.html` 是唯一维护对象，别在别处另起一份 HTML。
2. **知识库是幂等的。** `kb_entries` 播种有 `if (n > 0) return 0` 保护。手动改过库之后再启动不会重复灌。注意条目存在本地 `shudong.sqlite` 中，**删库或换机器会丢**，重要改动记得导出回 `树洞信箱_知识库_ima补充.json`。
3. **弱口令会被拒启动。** 启动时自检会比对 `WEAK_PASSWORDS`，命中即抛错。这不是 bug。
4. **学生端本机清障靠白名单。** `purgeLegacyData` 清空的是 8 个固定 localStorage key，新增本机 storage key 必须同步补进这个列表，否则旧数据会残留。

## 三、提交前必做的三件事

```bash
# 1. 跑回归（tests/ 四个脚本零依赖，直接 node 跑，不需要 npm install；
#    没配 Key 时 verify/repro 只做装配自检，e2e 会在调 API 前优雅退出）
node tests/verify_handoff.js
node tests/repro_handoff.js
node tests/e2e_zi_newline.js
node tests/prompt_scenarios.js

# 2. 敏感项扫描，命中断言即阻断发布（退出码 1）
python tools/scan_repo.py . --git-status

# 3. 确认前端构建标识仍是占位串（别把手改出来的时间戳提交上去）
grep -o "const BUILD_ID = '[^']*'" 树洞信箱Web版/树洞信箱_原型.html   # 应为 __BUILD_ID__
```

另外，改到 `.bat` / `.sh` 时留意换行：`.gitattributes` 已把 `*.bat` / `*.html` 固定为 CRLF，`*.sh` 固定为 LF。本机若开了 `core.autocrlf=true`，`启动.sh` 会被检出成 CRLF，然后在 Linux 上报 `bad interpreter`。手写 `.bat` 请保持 **GBK + CRLF**。

## 四、红线（违反一律不予合并）

- **不要把任何线上凭据写进仓库**：模型 Key、生产口令、SESSION_SECRET、CloudBase 环境 ID/密钥。配置文件见 `keys.json.example`，真实值走环境变量或中心端「Key 管理」面板热更新。
- **不要把学生的倾诉原文写进仓库**：包括 commit message、测试用例、文档引用、Issue 描述。对话语料的脱敏三元组（情绪标签 / 主题 / 时段）才是允许进版本库的形式。
- **不要把 `keys.json`、`口令.txt`、`*.sqlite*`、`*.log` 提交上去**（`.gitignore` 已覆盖 `keys.json`，但请自查）。

## 五、提交流程

1. Fork 后新建分支，命名建议 `feat/xxx`、`fix/xxx`、`docs/xxx`。
2. 一次提交只做一件事；commit message 用中文或英文都行，写清**为什么**改，而不只是改了什么（代码里的注释也是这个风格）。
3. 提 PR 前请确认：回归跑通、敏感扫描零命中、文档有同步更新。
4. Review 会重点关注：是否引入新的学生数据出口、是否绕过脱敏与最小样本抑制、是否破坏幂等与清障白名单。

## 六、提 Issue 时请附带

复现步骤、期望与实际行为、Node 与操作系统版本、相关日志片段（**请自行去除里面的 ID 与原文**）。涉及隐私的问题请直接描述现象，不要粘贴真实对话内容。

---

感谢你让这个项目对更多人有用。
