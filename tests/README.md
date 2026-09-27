# tests/ · 回归测试脚本

针对学生端多 Agent 对话链路（prompt + 上下文装配 + 输出排版）的端到端回归。
**所有脚本都直接从 `树洞信箱Web版/树洞信箱_原型.html` 里抽取线上在用的 prompt 与函数**，测的是真身，不是副本。

## 运行前提

- Node.js 18+（脚本只用内置 `fetch` / `https` / `fs`，**零依赖，不用 npm install**）
- 一个 DeepSeek Key，三选一提供：
  1. 命令行参数：`node tests/xxx.js sk-你的Key`
  2. 环境变量：`DEEPSEEK_KEY=sk-你的Key`
  3. `树洞信箱Web版/keys.json` 里已配置 `provider: "deepseek"` 的条目

> 测试会真实调用大模型 API（每次几毛钱以内的 token 消耗），`prompt_scenarios.js` 也支持 qwen / glm。

## 脚本一览

| 脚本 | 验证什么 | 用法 |
|---|---|---|
| `prompt_scenarios.js` | 小陪/小咨四阶框架的 6 个典型场景：阶段推进器、跨 Agent 出口、身体紧旁路、危机旁路（12356）、小咨四阶全流程 | `node tests/prompt_scenarios.js [key] [deepseek\|qwen\|glm]` |
| `repro_handoff.js` | 跨 Agent 历史污染的三臂对照：A 旧写法 / B 仅隔离 / C 隔离+护栏（线上现行），证明 C 臂自指与撇清均为 0 | `node tests/repro_handoff.js [key]` |
| `verify_handoff.js` | 从 `树洞信箱_原型.html` 抽出现行 `buildChatTurns` / `buildHandoffNote` 装配并真实调用，端到端证明「小咨推给小咨」已修复；无 Key 时只做装配自检 | `node tests/verify_handoff.js [key]` |
| `e2e_zi_newline.js` | 小咨输出的空行压缩（`squeezeChatText`）：压缩后空行必须为 0，且第 4 阶步骤的单换行必须保留；失败时退出码 1 | `node tests/e2e_zi_newline.js [key]` |

## 建议的回归时机

- 改了 `树洞信箱_原型.html` 里任何 prompt（`SYSTEM_PROMPT` / `CONSULT_PROMPT` / `ASSESS_PROMPT`）→ 跑 `prompt_scenarios.js`
- 改了历史装配（`buildChatTurns` / `buildHandoffNote` / history 结构）→ 跑 `verify_handoff.js`，有疑问再跑 `repro_handoff.js` 对照
- 改了 `squeezeChatText` → 跑 `e2e_zi_newline.js`
