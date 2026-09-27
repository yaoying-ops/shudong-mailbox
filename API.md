# 接口文档 · 26 个 API 端点

服务入口 `server/server.js`。本地默认 `http://localhost:3000`；挂在 HTTP 网关子路径下时（如 `https://example.com/shudong`），前缀由 `MOUNT_PREFIX` 中间件自动剥离，**下表路径均不含前缀**。

**鉴权图例**

| 标记 | 含义 |
|---|---|
| 公开 | 学生端直接调用，无需登录 |
| 登录 | 需中心端登录会话（`POST /api/center/login` 获取 `sd_sid` Cookie，HMAC 签名，8 小时有效，浏览器关闭即失效） |
| 管理员 | 登录且角色为 `admin`（咨询师角色只读，无法调用） |

> 未设置 `ADMIN_PASS` 时中心端处于**演示态**：所有「登录/管理员」接口免鉴权直接放行（仅供本地演示）。

---

## 学生端 · 对话与语音（2）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/chat` | 公开 | LLM 对话代理：中心持有 Key + 按 anonId 计每日配额 + Key 轮转/失效标记；支持 SSE 流式透传；**不落任何对话原文**。无 Key 返回 503（前端回落本地兜底话术），超配额返回 429 |
| POST | `/api/asr` | 公开 | 语音识别代理：按 Key 的 provider 分流（qwen → qwen3-asr-flash；glm → glm-asr-2512 multipart 上传）；音频不落盘 |

## 学生端 · 脱敏上报（3）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/mood` | 公开 | 情绪上报：只收 `{anonId, date, mood, topic}` 脱敏三元组，mood/topic 走白名单校验，绝不收原文 |
| POST | `/api/assessment` | 公开 | PHQ-9 + GAD-7 小测结果上报：只收分数与分级；服务端判定 level∈{Moderate,Severe} 或 q9Flag=1 时自动落「量表预警」 |
| POST | `/api/assessment/contact` | 公开 | 高危自测后补充留联：把联系方式挂到该匿名标识最新的量表预警上（可选 + 显式同意，低风险全程零采集） |

## 学生端 · 自助资源（1）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/kb/resource` | 公开 | 不带 `q` → 返回中心全量知识库（纯自护内容、非 PII），学生端本地缓存并本地检索，**倾诉原文因此永远不用回传**；带 `q` → 服务端混合检索兜底（ngram 关键词 + 标签/同义词语义，带引用元数据） |

## 中心端 · 看板与台账（4）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/insight/aggregate` | 登录 | 群体聚合（情绪分布 / 负向占比 / 高频话题）+ 超阈值自动生成预警并落库（按话题+日期去重 + 6 小时冷却） |
| GET | `/api/ledger` | 登录 | 逐条脱敏台账（最多 500 条），anon_id 掩码展示 |
| GET | `/api/assessments` | 登录 | 小测结果台账：同一次自测的 PHQ9/GAD7 两行合并展示 + 等级分布统计 |
| GET | `/api/reports/export` | 登录 | 导出周度/月度 CSV 报告（`?range=week\|month`；BOM+CRLF，Excel 中文不乱码；文件名 RFC 5987 编码） |

## 中心端 · 预警与干预闭环（6）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/alerts` | 登录 | 预警历史（情绪预警 + 量表预警，按触发时间倒序） |
| PUT | `/api/alerts/:id` | 登录 | 更新预警状态（pending/handling/done/ignored，状态值正则白名单防注入）与处置备注 |
| GET | `/api/interventions` | 登录 | 干预台账列表 |
| POST | `/api/interventions` | 登录 | 登记干预动作（可关联预警 id，也可直接针对话题登记） |
| PUT | `/api/interventions/:id` | 登录 | 更新干预记录（动作/经办人/说明/状态） |
| POST | `/api/loop/clear` | 管理员 | 清空预警处理数据（预警历史 + 干预台账，物理删除） |

## 中心端 · 知识库管理（3）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/kb` | 登录 | 查看全部未删除条目（含草稿），附当前索引条目数 |
| POST | `/api/kb` | 管理员 | 批量更新：upsert（内容变更自动 version+1）+ diff 软删除（tombstone），完成后自动重建内存索引 |
| POST | `/api/kb/reindex` | 管理员 | 手动重建检索索引（对应外部改动后的索引重载） |

## 中心端 · 密钥与登录（5）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/keys` | 管理员 | 查看 Key 列表：**只回脱敏掩码，绝不回传明文**；附各 Key 失效标记与每日配额 |
| PUT | `/api/keys` | 管理员 | 更新 Key 与配额：按数组下标合并（留空行保留原值），保存即热更新 `keys.json`，无需重启 |
| POST | `/api/center/login` | 公开 | 单口令登录：匹配 `ADMIN_PASS` → admin 角色，匹配 `COUNSELOR_PASS` → counselor 角色 |
| GET | `/api/center/session` | 公开 | 查询当前会话状态（authed / demo / role） |
| POST | `/api/center/logout` | 公开 | 登出（清除会话 Cookie） |

## 运维（2）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 公开 | 健康检查，返回 `{ok: true}` |
| POST | `/api/clear` | 管理员 | 清空全部脱敏上报样本（mood_reports，物理删除，WAL 折叠） |

---

## 备注

- 以上共 **26 个接口端点**：其中 21 个遵循 REST 资源语义，5 个为动作式接口（`/api/chat`、`/api/asr`、`/api/clear`、`/api/loop/clear`、`/api/kb/reindex`）。
- 静态页面 `GET /`（学生端）与 `GET /center`（中心端）为同源托管、不计入接口数；两者均带 `Cache-Control: no-store`。
- 所有写接口的 SQL 均为参数化查询；情绪/话题/分级/状态等枚举字段在数据层做白名单校验，非法值拒收。
