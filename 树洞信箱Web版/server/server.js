/* server.js — 树洞信箱后端聚合 + 中心管控服务
 * 同源托管：/  → 学生端原型页；/center → 心理中心看板
 * 接口：
 *   学生端：POST /api/mood（脱敏上报）  POST /api/chat（中心代理，持有 Key + 配额 + 轮转）
 *           POST /api/asr（中心代理语音识别，使用中心 qwen/glm Key）
 *           GET  /api/kb/resource（从中心知识库派生自助资源，公开）
 *   中心端：GET  /api/insight/aggregate（群体聚合 + 告警落库）  GET /api/ledger（逐条台账）
 *           GET/PUT /api/alerts（告警历史）  GET/POST/PUT /api/interventions（干预台账）
 *           GET /api/kb（查看）  POST /api/kb（更新）  GET /api/reports/export（CSV 导出）
 *           GET/PUT /api/keys（Key 管理，需登录）
 *           POST /api/center/login · GET /api/center/session · POST /api/center/logout（登录）
 *   运维：   GET /api/health  POST /api/clear（清空）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const {
  db, insertReport, getAggregate, getLedger, clearAll,
  upsertAlert, getAlerts, updateAlert,
  addIntervention, getInterventions, updateIntervention, clearLoop,
  insertAssessment, insertAssessmentAlert, updateAssessmentContact, getAssessments,
  getUsage, incUsage, NEG_MOODS,
  getKbEntries, getKbIds, upsertKbEntry, softDeleteKbEntry, seedKbFromJson,
  nowCN, dateCN
} = require('./db');
// 启动自检：防止 db 导出函数缺失导致线上每个请求静默崩溃
// （历史上曾因漏导 dateCN，致 /api/chat、CSV 导出、预警落库全线 ReferenceError）
if (typeof dateCN !== 'function' || typeof nowCN !== 'function') {
  throw new Error('[startup] db.dateCN / db.nowCN 未正确导入，请检查 server.js 的 require 解构列表');
}
const { seed } = require('./seed');
const app = express();

/* 路径前缀兼容：同一份代码既能直接跑在根路径（/、/center），
 * 也能挂在 HTTP 网关的 /shudong 路由下（https://example.com/shudong）。
 * 无论网关是否透传前缀，这里都先把 /shudong 剥掉再交给路由匹配。 */
const MOUNT_PREFIX = process.env.MOUNT_PREFIX || '/shudong';
app.use((req, res, next) => {
  const i = req.url.indexOf('?');
  const pathOnly = i === -1 ? req.url : req.url.slice(0, i);
  const query = i === -1 ? '' : req.url.slice(i);
  if (pathOnly === MOUNT_PREFIX) req.url = '/' + query;
  else if (pathOnly.startsWith(MOUNT_PREFIX + '/')) req.url = pathOnly.slice(MOUNT_PREFIX.length) + query;
  next();
});

app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

/* ============ 学生端原型页 / 中心端看板 定位 ============ */
function resolveProto() {
  const root = path.join(__dirname, '..');
  const exact = path.join(root, '树洞信箱_原型.html');
  if (fs.existsSync(exact)) return exact;
  try {
    const html = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith('.html'));
    if (html.length === 1) {
      console.warn(`[warn] 原型页文件名异常，回退使用 ${html[0]}`);
      return path.join(root, html[0]);
    }
  } catch (e) { }
  return exact;
}
const PROTO_HTML = resolveProto();
const CENTER_HTML = path.join(__dirname, 'center.html');

/* ============ 心理中心行动建议（话题 → 干预动作） ============ */
const TOPIC_ADVICE = {
  '学业': '学业压力应对团体辅导 / 时间管理工作坊',
  '人际': '人际沟通主题沙龙 / 寝室关系工作坊',
  '就业': '求职心理门诊 / 简历与面试辅导',
  '未来': '生涯规划讲座 / 专业探索活动',
  '身体': '睡眠健康科普推送',
  '恋情': '亲密关系主题讲座',
  '家庭': '家庭沟通线上推文',
  '经济': '资助政策宣讲 / 兼职信息对接'
};
const ALERT_THRESHOLD = Number(process.env.ALERT_THRESHOLD || 35);

/* ============ ① 中心端知识库（参照 DeepSeek Harness 知识库机制） ============
 * 存储层：db.js 的 kb_entries 表（结构化 + 元数据 + 版本 + 软删除 tombstone）
 * 索引层：kbRows 内存索引，由 kb_entries 构建；编辑/重建后调用 buildKbIndex() 重载
 * 检索层：searchKb() 做「关键词(lexical) + 标签/分类语义(semantic)」混合召回 + 重排序
 * 溯源：  检索结果携带 id/source/version，供学生端渲染「参考来源」（引用溯源） */
let kbRows = [];   // 内存索引：每条 {id,title,category,tags,keywords,answer,source,version,effectiveDate,grams,titleGrams,tagSet}

/* 中文友好的轻量分词：取 2-gram 与 3-gram 集合，规避 FTS5 默认分词器对中文整词切分的问题 */
function ngrams(s) {
  const out = new Set();
  s = String(s || '');
  for (let i = 0; i < s.length; i++) {
    if (i + 2 <= s.length) out.add(s.slice(i, i + 2));
    if (i + 3 <= s.length) out.add(s.slice(i, i + 3));
  }
  return out;
}

/* 同义词 / 语义映射：学生口语 → 知识库规范标签/分类（混合检索的「语义」一路） */
const KB_THESAURUS = {
  '考研': '考试焦虑', '挂科': '考试焦虑', '考试': '考试焦虑', '成绩': '考试焦虑', '复习': '考试焦虑', '笔试': '考试焦虑',
  '宿舍': '人际与关系', '室友': '人际与关系', '同学': '人际与关系', '吵架': '人际与关系', '矛盾': '人际与关系', '孤立': '人际与关系', '排挤': '人际与关系',
  '分手': '情感困扰', '失恋': '情感困扰', '暗恋': '情感困扰', '恋爱': '情感困扰', '对象': '情感困扰', '男朋友': '情感困扰', '女朋友': '情感困扰',
  '就业': '生涯发展', '找工作': '生涯发展', '实习': '生涯发展', '面试': '生涯发展', '求职': '生涯发展', '前途': '生涯发展', '秋招': '生涯发展', '迷茫': '自我成长',
  '拖延': '学业压力', '懒': '学业压力',
  '失眠': '睡眠', '睡不好': '睡眠', '睡不着': '睡眠',
  '焦虑': '情绪管理', '低落': '情绪管理', '崩溃': '情绪管理', '麻木': '情绪管理', '空虚': '自我成长', '意义': '自我成长', '孤独': '人际与关系',
  '想家': '适应', '换到大学': '适应', '不适应': '适应'
};

function buildKbIndex() {
  kbRows = getKbEntries().map(e => {
    const tags = (e.tags && e.tags.length) ? e.tags : (e.keywords || []);
    const text = (e.title || '') + ' ' + (e.category || '') + ' ' + tags.join(' ') + ' ' + (e.answer || '');
    return {
      id: e.id, title: e.title, category: e.category,
      tags, keywords: e.keywords, answer: e.answer,
      source: e.source, version: e.version, effectiveDate: e.effectiveDate,
      grams: ngrams(text),
      titleGrams: ngrams(e.title || ''),
      tagSet: new Set(tags.map(t => String(t)))
    };
  });
}

/* 混合召回 + 重排序：lexical(ngram 重叠) + semantic(分类/标签直接命中 + 同义词映射)，合并打分后取前 top */
function searchKb(q, top = 5) {
  const query = String(q || '').trim();
  if (!query) return [];
  const qg = ngrams(query);
  const qTerms = query.split(/[\s，,。.、；;：:！!？?]/).filter(t => t.length >= 2);
  const scored = kbRows.map(e => {
    let lex = 0;
    qg.forEach(g => { if (e.grams.has(g)) lex++; });
    // 标题命中加权
    let titleHit = 0;
    qg.forEach(g => { if (e.titleGrams.has(g)) titleHit++; });
    let sem = 0;
    qTerms.forEach(t => { if (e.tagSet.has(t) || (e.category || '').includes(t)) sem += 2; });
    Object.keys(KB_THESAURUS).forEach(ph => {
      if (query.includes(ph)) {
        const can = KB_THESAURUS[ph];
        if (e.tagSet.has(can) || (e.category || '').includes(can) || (e.title || '').includes(can)) sem += 2;
      }
    });
    const score = lex * 1 + titleHit * 1.5 + sem * 1.5;
    return { e, score };
  }).filter(x => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, top).map(x => ({
    id: x.e.id, title: x.e.title, category: x.e.category, answer: x.e.answer,
    source: x.e.source, version: x.e.version, effectiveDate: x.e.effectiveDate,
    tags: [...x.e.tagSet]
  }));
}

/* 首次启动：JSON 种子导入 + 构建内存索引 */
seedKbFromJson();
buildKbIndex();
console.log('[kb] 知识库已就绪，索引条目数 = ' + kbRows.length);

/* —— 可选：启动即清空业务数据，只留知识库 ——
 * 默认不生效：只有显式设 RESET_DATA=1 才会清空，本地演示想保留数据就不设。
 * 覆盖 mood_reports / alerts / interventions / assessments / usage 五张业务表，
 * 不碰 kb_entries，因此 18 条知识库保持原样。 */
if (process.env.RESET_DATA === '1') {
  try {
    const tables = ['mood_reports', 'alerts', 'interventions', 'assessments', 'usage'];
    let removed = 0;
    tables.forEach(name => {
      try { removed += db.prepare('DELETE FROM ' + name).run().changes || 0; }
      catch (e) { /* 表尚未创建则跳过 */ }
    });
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* 忽略 */ }
    console.log(`[reset] 业务数据已清空：${tables.length} 张表 / 删除 ${removed} 行（知识库保留）`);
  } catch (e) {
    console.warn('[reset] 清空业务数据失败：' + e.message);
  }
}


/* ============ ② 中心 Key 代理（持有 Key + 配额 + 轮转） ============ */
const MODELS = {
  deepseek: { base: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' },
  qwen: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
  glm: { base: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash' }
};
/* Key 统一存于 keys.json（运行时可由中心端「Key 管理」面板热更新）；
 * 首次启动若无 keys.json，则用 LLM_KEYS 环境变量兜底（全部当作 deepseek provider）。 */
const KEYS_PATH = path.join(__dirname, '..', 'keys.json');
let KEYS = [];                                  // [{provider, key}]
let LLM_QUOTA_PER_DAY = parseInt(process.env.LLM_QUOTA_PER_DAY || '100', 10);
let keyCursor = 0;
const keyDead = new Map();                      // idx → true 表示本轮失效
function loadKeys() {
  if (process.env.DISABLE_FILE_KEYS) {
    // 禁用从 keys.json 文件自动加载：若运行目录被持久卷挂载（容器/网络盘常见），
    // 历史写入的 keys.json 会在重启后「复活」，界面里删掉的 Key 又变回来。
    // 打开后 Key 只活在内存里，重启即归零，只认 LLM_KEYS 环境变量；不打开则正常读写同一文件。
    const envKeys = (process.env.LLM_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (envKeys.length) KEYS = envKeys.map(k => ({ provider: 'deepseek', key: k }));
    return;
  }
  try {
    const obj = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
    if (Array.isArray(obj.keys) && obj.keys.length) {
      KEYS = obj.keys.map(k => ({ provider: k.provider || 'deepseek', key: String(k.key || '').trim() })).filter(k => k.key);
      if (obj.quotaPerDay) LLM_QUOTA_PER_DAY = parseInt(obj.quotaPerDay, 10) || LLM_QUOTA_PER_DAY;
      return;
    }
  } catch (e) { /* 无文件则用环境变量兜底 */ }
  const envKeys = (process.env.LLM_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (envKeys.length) {
    KEYS = envKeys.map(k => ({ provider: 'deepseek', key: k }));
    saveKeys();
  }
}
function saveKeys() {
  if (process.env.DISABLE_FILE_KEYS) return; // 云端不把 Key 落盘，避免持久卷残留明文
  try { fs.writeFileSync(KEYS_PATH, JSON.stringify({ keys: KEYS, quotaPerDay: LLM_QUOTA_PER_DAY }, null, 2), 'utf8'); }
  catch (e) { console.warn('[keys] 写入 keys.json 失败：' + e.message); }
}
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '****';
  return k.slice(0, 3) + '****' + k.slice(-4);
}
/* 轮转取 Key：优先指定 provider；strict=true 时只取指定 provider（不退而求其次，ASR 用）；全部失效返回 null */
function pickKey(provider, strict) {
  if (!KEYS.length) return null;
  const n = KEYS.length;
  let best = -1, bestAny = -1;
  for (let kk = 0; kk < n; kk++) {
    const i = (keyCursor + kk) % n;
    if (keyDead.get(i)) continue;
    if (KEYS[i].provider === provider) { best = i; break; }
    if (!strict && bestAny === -1) bestAny = i;
  }
  const idx = best !== -1 ? best : bestAny;
  if (idx === -1) return null;
  keyCursor = (idx + 1) % n;
  return { key: KEYS[idx].key, provider: KEYS[idx].provider, idx };
}
loadKeys();

/* ============ ③ 登录（会话 Cookie，HMAC 签名） ============ */
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-please-change-in-prod';
const ADMIN_PASS = process.env.ADMIN_PASS || process.env.STAFF_TOKEN || '';
const COUNSELOR_PASS = process.env.COUNSELOR_PASS || '';
const DEMO = !ADMIN_PASS; // 未设管理员口令 → 演示态开放

// fail-closed：ADMIN_PASS 为已知弱口令时拒绝启动，避免弱口令 + 含 Key 的中心端公网暴露
const WEAK_PASSWORDS = new Set(['admin','user','123456','password','changeme','root','shudong']);
if (ADMIN_PASS && WEAK_PASSWORDS.has(ADMIN_PASS.toLowerCase())) {
  throw new Error('[auth] ADMIN_PASS 为已知弱口令（' + ADMIN_PASS + '），出于安全拒绝启动。请设置强口令。');
}
if (DEMO) console.warn('[auth] 未设置 ADMIN_PASS，中心端处于「演示态」开放模式（任何人可访问）。生产环境请设置 ADMIN_PASS / COUNSELOR_PASS。');
else if (!COUNSELOR_PASS) console.warn('[auth] 已设 ADMIN_PASS（管理员），但未设 COUNSELOR_PASS，咨询师角色暂不可用（可用同一口令以 ADMIN_PASS 登录）。');

function signSession(user, role) {
  const payload = Buffer.from(JSON.stringify({ user, role: role || 'admin', exp: Date.now() + 8 * 3600 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifySession(cookie) {
  try {
    const [p, s] = cookie.split('.');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('base64url');
    if (s !== expected) return null;
    const obj = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (obj.exp < Date.now()) return null;
    return obj;
  } catch (e) { return null; }
}
function parseCookies(req) {
  const h = req.headers.cookie;
  if (!h) return {};
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function requireLogin(req, res, next) {
  if (DEMO) { req.user = 'center'; req.role = 'admin'; return next(); }
  const c = parseCookies(req)['sd_sid'];
  const s = c && verifySession(c);
  if (!s) return res.status(401).json({ error: 'unauthorized', login: true });
  req.user = s.user;
  req.role = s.role || 'admin';
  next();
}
// 仅管理员：写知识库 / 改 Key / 清空预警 / 清空全量 等破坏性、配置类操作
function requireAdmin(req, res, next) {
  if (DEMO) return next();
  const c = parseCookies(req)['sd_sid'];
  const s = c && verifySession(c);
  if (!s) return res.status(401).json({ error: 'unauthorized', login: true });
  if (s.role !== 'admin') return res.status(403).json({ error: 'forbidden', need: 'admin' });
  req.user = s.user;
  req.role = s.role;
  next();
}
function setSessionCookie(res, user, role) {
  res.setHeader('Set-Cookie',
    // 会话 cookie：不设 Max-Age/Expires → 浏览器关闭即失效，重开必须重新登录
    `sd_sid=${signSession(user, role)}; HttpOnly; Path=/; SameSite=Strict`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sd_sid=; HttpOnly; Path=/; Max-Age=0');
}

/* ============ 接口 ============ */

/* —— 学生端：脱敏上报（只收 date + mood + topic + anonId，绝不收原文） —— */
app.post('/api/mood', (req, res) => {
  const { anonId, date, mood, topic } = req.body || {};
  if (!mood) return res.status(400).json({ error: 'mood required' });
  try {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : dateCN();
    insertReport({ anonId, date: d, mood, topic });
    res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: 'invalid mood', detail: String(e.message || e) });
  }
});

/* —— 学生端：标准化小测（PHQ-9 + GAD-7）结果脱敏上报 ——
 * 仅收分级结果（anonId/date/两表分数与 level/q9Flag），不含任何原文。
 * 上报时机由学生主导：前端只在学生勾选同意并提交留联后才会调用本接口（可携带 contact/contactMode）。
 * 服务端按 §4.3 触发规则：level∈{Moderate,Severe} 或 q9Flag=1 → 落「量表预警」，联系方式直接挂到预警上。 */
const ASSESS_LEVELS = ['Normal', 'Mild', 'Moderate', 'Severe'];
app.post('/api/assessment', (req, res) => {
  const b = req.body || {};
  const anonId = (b.anonId || '').toString().slice(0, 64);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : dateCN();
  const phq9 = b.phq9 || {}, gad7 = b.gad7 || {};
  const phqScore = Number(phq9.score), gadScore = Number(gad7.score);
  const phqLevel = ASSESS_LEVELS.includes(phq9.level) ? phq9.level : 'Normal';
  const gadLevel = ASSESS_LEVELS.includes(gad7.level) ? gad7.level : 'Normal';
  const level = ASSESS_LEVELS[Math.max(ASSESS_LEVELS.indexOf(phqLevel), ASSESS_LEVELS.indexOf(gadLevel))];
  const q9Flag = phq9.q9 > 0 ? 1 : 0;
  const contact = (b.contact || '').toString().slice(0, 64).trim();
  const contactMode = ['phone', 'wechat'].includes(b.contactMode) ? b.contactMode : '';
  if (!Number.isFinite(phqScore) || !Number.isFinite(gadScore)) {
    return res.status(400).json({ error: 'invalid assessment score' });
  }
  if (contact && !contactMode) {
    return res.status(400).json({ error: 'invalid contact mode' });
  }
  try {
    const phqId = insertAssessment({ anonId, date, type: 'PHQ9', score: phqScore, level: phqLevel, q9Flag });
    const gadId = insertAssessment({ anonId, date, type: 'GAD7', score: gadScore, level: gadLevel, q9Flag: 0 });
    let alertId = null;
    if (level === 'Moderate' || level === 'Severe' || q9Flag === 1) {
      const advice = `量表自测分级为 ${level}${q9Flag ? '（含自杀意念项阳性，优先关注）' : ''}，建议联系校心理中心或拨打全国心理援助热线 12356。`;
      alertId = insertAssessmentAlert({ date, level, advice, assessmentId: phqId, topic: '自测·抑郁/焦虑', anonId, contact, contactMode });
    }
    res.json({ ok: true, level, q9Flag, alertCreated: !!alertId });
  } catch (e) {
    return res.status(400).json({ error: 'assessment save failed', detail: String(e.message || e) });
  }
});

/* 学生高危自测后补充留联：把联系方式挂到该匿名标识最新的量表预警上（仅高危可见，普通自测台账不展示）。
   留联为可选 + 显式同意，低风险全程零采集；此处只写已存在的高危预警，不新建预警。 */
app.post('/api/assessment/contact', (req, res) => {
  const b = req.body || {};
  const anonId = (b.anonId || '').toString().slice(0, 64);
  const contact = (b.contact || '').toString().slice(0, 64).trim();
  const contactMode = ['phone', 'wechat'].includes(b.contactMode) ? b.contactMode : '';
  if (!anonId || !contact || !contactMode) {
    return res.status(400).json({ error: 'invalid contact payload' });
  }
  try {
    const ok = updateAssessmentContact({ anonId, contact, contactMode });
    if (!ok) return res.status(404).json({ error: 'no assessment alert to attach' });
    res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: 'contact update failed', detail: String(e.message || e) });
  }
});

/* —— 学生端：中心 Key 代理（持有 Key、按 anonId 计配额、Key 轮转；不落任何对话原文） —— */
app.post('/api/chat', async (req, res) => {
  const body = req.body || {};
  const anonId = body.anonId || 'anon';
  const wantProvider = MODELS[body.model] ? body.model : 'deepseek';

  if (!KEYS.length) {
    // 中心未配 Key：返回 503，前端回退到本地兜底（不连模型）
    return res.status(503).json({ error: 'center has no LLM key configured' });
  }

  const today = dateCN();
  const used = getUsage(anonId, today);
  if (used >= LLM_QUOTA_PER_DAY) {
    return res.status(429).json({ error: 'daily quota exceeded', used, quota: LLM_QUOTA_PER_DAY });
  }

  // 先按 Key 的 provider 选定真实调用的模型与端点，保证「Key 与模型同源」
  const picked = pickKey(wantProvider);
  if (!picked) {
    return res.status(503).json({ error: 'center has no available key for ' + wantProvider });
  }
  const cfg = MODELS[picked.provider] || MODELS.deepseek;

  const proxyBody = {
    model: cfg.model,
    messages: Array.isArray(body.messages) ? body.messages : [],
    stream: !!body.stream,
    temperature: body.temperature,
    max_tokens: body.max_tokens
  };

  const attempts = Math.max(1, KEYS.length);
  let lastErr = null;
  for (let a = 0; a < attempts; a++) {
    const k = pickKey(wantProvider) || pickKey(wantProvider === 'deepseek' ? 'qwen' : 'deepseek');
    if (!k) break;
    try {
      const upstream = await fetch(cfg.base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k.key },
        body: JSON.stringify(proxyBody)
      });
      // Key 失效 / 限流 → 标记该 key 失效，换下一个重试
      if (upstream.status === 401 || upstream.status === 429) {
        keyDead.set(k.idx, true);
        lastErr = 'provider ' + upstream.status;
        // 尝试消费掉响应体，避免连接挂起
        try { await upstream.text(); } catch (e) { }
        continue;
      }
      // 成功：记配额并原样转发（流式透传 SSE，非流式透传 JSON）
      incUsage(anonId, today);
      if (proxyBody.stream) {
        res.status(upstream.status);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        try {
          const reader = upstream.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        } catch (e) { /* 流中断 */ }
        res.end();
        return;
      } else {
        const txt = await upstream.text();
        res.status(upstream.status);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.send(txt);
      }
    } catch (e) {
      keyDead.set(k.idx, true);
      lastErr = e.message;
      continue;
    }
  }
  return res.status(502).json({ error: 'all LLM keys failed', detail: String(lastErr || 'unknown') });
});

/* —— 学生端：从中心知识库派生自助资源（公开）。
 * 不带 q → 返回中心「全量」知识库（纯自护内容，非 PII），供学生端本地缓存并做本地检索，
 *   这样学生的倾诉原文永远不回传服务器；
 * 带 q → 返回服务端关键词命中的前 N 条（可选的服务端兜底检索）。 */
app.get('/api/kb/resource', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) {
    // 无 q → 返回中心全量知识库（纯自护内容、非 PII），供学生端本地缓存并做本地检索；
    // 每条携带 id / 分类 / 来源 / 版本，便于学生端渲染「参考来源」（引用溯源）。
    return res.json({
      entries: kbRows.map(e => ({
        id: e.id, title: e.title, category: e.category, answer: e.answer,
        source: e.source, version: e.version, effectiveDate: e.effectiveDate, tags: [...e.tagSet]
      })),
      source: 'center', indexed: kbRows.length
    });
  }
  // 带 q → 服务端混合检索（关键词 + 标签/分类语义），返回带引用元数据的命中条目
  res.json({ entries: searchKb(q, 5), source: 'center', indexed: kbRows.length });
});

/* —— 中心端：群体聚合（看板数据源）+ 告警落库 —— */
app.get('/api/insight/aggregate', requireLogin, (req, res) => {
  const agg = getAggregate();
  let alert = null;
  if (agg.total && agg.negPct >= ALERT_THRESHOLD) {
    const topic = agg.negTopics[0] ? agg.negTopics[0].topic : (agg.topics[0] ? agg.topics[0].topic : '压力');
    const advice = TOPIC_ADVICE[topic] || '相关主题团体辅导 / 自助推文';
    alert = {
      level: 'warn',
      negPct: agg.negPct,
      topic,
      advice,
      body: `负向情绪占比 ${agg.negPct}%，其中「${topic}」提及最高。建议心理中心本周优先开展「${advice}」，并推送相关自助推文，主动触达高风险群体。`
    };
    // 落库（按 话题+日期 去重，避免自动刷新刷出重复告警）
    upsertAlert({ date: dateCN(), negPct: agg.negPct, topic, advice: alert.body });
  } else if (agg.total) {
    alert = {
      level: 'ok',
      negPct: agg.negPct,
      body: `当前情绪分布健康（负向 ${agg.negPct}%）。维持常规关注与月度盘点即可。`
    };
  }
  res.json({ ...agg, alert, negMoods: NEG_MOODS });
});

/* —— 中心端：逐条脱敏台账 —— */
app.get('/api/ledger', requireLogin, (req, res) => {
  const rows = getLedger(500);
  res.json({ total: rows.length, rows });
});

/* —— 中心端：告警历史 —— */
app.get('/api/alerts', requireLogin, (req, res) => {
  res.json({ rows: getAlerts() });
});
/* 中心端：小测结果台账（一次自测 = 一条记录：PHQ-9 + GAD-7 合并展示；脱敏 + 等级分布统计） */
app.get('/api/assessments', requireLogin, (req, res) => {
  const raw = getAssessments(); /* 按 id 倒序（最新在前） */
  /* 同一次自测的 PHQ9/GAD7 两行在同一请求内连续写入：按 anon_id+日期+分钟 合并为一条 */
  const map = new Map();
  for (const r of raw) {
    const key = [r.anon_id || 'anon', r.date || '', String(r.created_at || '').slice(0, 16)].join('|');
    let s = map.get(key);
    if (!s) {
      s = { anonMask: (r.anon_id || 'anon').slice(0, 6) + '***', date: r.date, created_at: r.created_at, phq9: null, gad7: null };
      map.set(key, s);
    }
    if (r.type === 'PHQ9') s.phq9 = { score: r.score, level: r.level, q9Flag: r.q9Flag ? 1 : 0 };
    else if (r.type === 'GAD7') s.gad7 = { score: r.score, level: r.level };
  }
  const sessions = [...map.values()].map((s, i) => ({ id: i + 1, ...s }));
  const stats = { total: sessions.length, PHQ9: {}, GAD7: {} };
  for (const s of sessions) {
    if (s.phq9) stats.PHQ9[s.phq9.level] = (stats.PHQ9[s.phq9.level] || 0) + 1;
    if (s.gad7) stats.GAD7[s.gad7.level] = (stats.GAD7[s.gad7.level] || 0) + 1;
  }
  res.json({ rows: sessions, stats });
});
app.put('/api/alerts/:id', requireLogin, (req, res) => {
  try {
    updateAlert(Number(req.params.id), req.body || {});
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  res.json({ ok: true });
});

/* —— 中心端：干预台账 —— */
app.get('/api/interventions', requireLogin, (req, res) => {
  res.json({ rows: getInterventions() });
});
app.post('/api/interventions', requireLogin, (req, res) => {
  const id = addIntervention(req.body || {});
  res.json({ ok: true, id });
});
app.put('/api/interventions/:id', requireLogin, (req, res) => {
  updateIntervention(Number(req.params.id), req.body || {});
  res.json({ ok: true });
});

/* —— 中心端：清空预警处理数据（预警历史 + 干预台账） —— */
app.post('/api/loop/clear', requireAdmin, (req, res) => {
  clearLoop();
  res.json({ ok: true });
});

/* —— 中心端：知识库查看 / 更新 / 重建索引（持久化于 kb_entries 表） —— */
app.get('/api/kb', requireLogin, (req, res) => {
  // 返回全部未删除条目（含草稿），供中心端编辑；附当前索引条目数
  try {
    const rows = getKbEntries({ includeDrafts: true });
    res.json({ entries: rows, indexed: kbRows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/kb', requireAdmin, (req, res) => {
  const arr = req.body && req.body.entries;
  if (!Array.isArray(arr)) return res.status(400).json({ error: 'entries required' });
  const cleaned = arr.map(x => ({
    id: x.id ? Number(x.id) || null : null,
    keywords: Array.isArray(x.keywords) ? x.keywords : (x.keywords ? String(x.keywords).split(/[,，|\s、]+/).filter(Boolean) : []),
    tags: Array.isArray(x.tags) ? x.tags : (x.tags ? String(x.tags).split(/[,，|\s、]+/).filter(Boolean) : []),
    title: x.title || x.name || '未命名',
    answer: x.answer || x.content || x.text || '',
    category: (x.category || '').toString().trim(),
    source: (x.source || '').toString().trim(),
    effectiveDate: (x.effectiveDate || x.effective_date || '').toString().trim(),
    status: (x.status || 'published').toString().trim()
  })).filter(x => x.answer && x.answer.trim());
  if (!cleaned.length) return res.status(400).json({ error: 'no valid entry' });
  const handled = [];
  for (const x of cleaned) {
    const id = upsertKbEntry({
      id: x.id, category: x.category || '', title: x.title, content: x.answer,
      keywords: x.keywords, tags: x.tags, source: x.source || '中心录入',
      effectiveDate: x.effectiveDate || x.effective_date || '', status: x.status || 'published',
      createdBy: 'center'
    });
    handled.push(Number(id));
  }
  // diff 软删除：库里存在但本次未提交（UI 中已删除）的条目 → tombstone
  getKbIds().forEach(id => { if (!handled.includes(id)) softDeleteKbEntry(id); });
  buildKbIndex();
  res.json({ ok: true, count: getKbEntries().length, indexed: kbRows.length });
});
/* 重建索引：编辑/上传/外部改动后，手动把 kb_entries 重新载入内存索引
 *（对应 DeepSeek Harness「文档更新需手动触发重建索引」的步骤） */
app.post('/api/kb/reindex', requireAdmin, (req, res) => {
  buildKbIndex();
  res.json({ ok: true, indexed: kbRows.length });
});

/* —— 中心端：Key 管理（需登录；keys.json 热更新，无需重启） —— */
app.get('/api/keys', requireAdmin, (req, res) => {
  // 仅返回脱敏掩码，绝不回传明文 Key（防前端/代理抓包泄露）
  res.json({
    keys: KEYS.map((k, i) => ({ provider: k.provider, masked: maskKey(k.key), dead: !!keyDead.get(i) })),
    quotaPerDay: LLM_QUOTA_PER_DAY
  });
});
app.put('/api/keys', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.keys)) return res.status(400).json({ error: 'keys[] required' });
  // 合并：若某条未填写 key（用户未改动），保留服务端同位置已有 key，避免保存时误清空
  const cleaned = b.keys
    .map((x, i) => {
      const key = String(x.key || '').trim();
      if (key) return { provider: (x.provider || 'deepseek'), key };
      const existing = KEYS[i];
      if (existing && existing.key) return { provider: (x.provider || existing.provider || 'deepseek'), key: existing.key };
      return null;
    })
    .filter(Boolean);
  // 显式清空：所有条目都未填写（含 keys:[]）→ 清空全部 Key，学生端 AI 立即停用。
  // 历史行为是 400 拒绝，导致持久化卷里的旧 Key 永远删不掉、重部署后「复活」。
  const anyFilled = b.keys.some(x => String((x && x.key) || '').trim());
  if (!cleaned.length && !anyFilled) {
    KEYS = [];
    keyDead.clear();
    if (b.quotaPerDay) LLM_QUOTA_PER_DAY = parseInt(b.quotaPerDay, 10) || LLM_QUOTA_PER_DAY;
    saveKeys();
    return res.json({ ok: true, count: 0, quotaPerDay: LLM_QUOTA_PER_DAY, cleared: true });
  }
  if (!cleaned.length) return res.status(400).json({ error: 'no valid key' });
  KEYS = cleaned;
  keyDead.clear();
  if (b.quotaPerDay) LLM_QUOTA_PER_DAY = parseInt(b.quotaPerDay, 10) || LLM_QUOTA_PER_DAY;
  saveKeys();
  res.json({ ok: true, count: KEYS.length, quotaPerDay: LLM_QUOTA_PER_DAY });
});

/* —— 学生端：语音识别代理（公共，使用中心 qwen/glm Key，不落音频） ——
 * qwen → dashscope qwen3-asr-flash（chat/completions + input_audio dataUrl）
 * glm  → 智谱 open.bigmodel.cn /api/paas/v4/audio/transcriptions（multipart 上传，glm-asr-2512）
 * 两家接口完全不同，必须按 Key 的 provider 分流，不能拿 A 家的 Key 调 B 家的端点。 */
app.post('/api/asr', async (req, res) => {
  const dataUrl = (req.body && req.body.dataUrl) || '';
  if (!dataUrl) return res.status(400).json({ error: 'dataUrl required' });
  const picked = pickKey('qwen', true) || pickKey('glm', true);
  if (!picked) return res.status(503).json({ error: 'center has no qwen/glm key for ASR' });
  try {
    let text = '';
    if (picked.provider === 'glm') {
      /* 智谱：解码 dataUrl 成二进制，multipart/form-data 上传 */
      const m = String(dataUrl).match(/^data:([^;,]+)?(?:;[^,]*)?,(.*)$/s);
      if (!m) return res.status(400).json({ error: 'bad dataUrl' });
      const mime = m[1] || 'audio/webm';
      const buf = Buffer.from(m[2], 'base64');
      const ext = (/wav/.test(mime) ? 'wav' : /mp3|mpe?g/.test(mime) ? 'mp3' : /ogg|opus/.test(mime) ? 'ogg' : 'webm');
      const fd = new FormData();
      fd.append('model', 'glm-asr-2512');
      fd.append('stream', 'false');
      fd.append('file', new Blob([buf], { type: mime }), 'audio.' + ext);
      const upstream = await fetch('https://open.bigmodel.cn/api/paas/v4/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + picked.key },
        body: fd
      });
      if (!upstream.ok) {
        const t = await upstream.text();
        return res.status(502).json({ error: 'asr failed: ' + upstream.status, detail: t.slice(0, 200) });
      }
      const j = await upstream.json();
      text = (j.text || j.content || '').trim();
    } else {
      /* 通义千问：dashscope 兼容模式，input_audio 直接传 dataUrl */
      const upstream = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + picked.key },
        body: JSON.stringify({
          model: 'qwen3-asr-flash', stream: false,
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUrl } }] }],
          asr_options: { language: 'zh', enable_itn: false }
        })
      });
      if (!upstream.ok) {
        const t = await upstream.text();
        return res.status(502).json({ error: 'asr failed: ' + upstream.status, detail: t.slice(0, 200) });
      }
      const j = await upstream.json();
      let c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (Array.isArray(c)) c = c.map(x => x.text || '').join('');
      text = (typeof c === 'string' ? c : '').trim();
    }
    if (!text) return res.status(502).json({ error: 'asr empty result' });
    res.json({ text });
  } catch (e) {
    res.status(502).json({ error: 'asr error: ' + e.message });
  }
});

/* —— 中心端：按周/月导出报告（CSV） —— */
app.get('/api/reports/export', requireLogin, (req, res) => {
  const range = req.query.range === 'month' ? 'month' : 'week';
  const agg = getAggregate();
  const now = new Date();
  const curYM = dateCN().slice(0, 7);
  const weekAgo = now.getTime() - 7 * 86400000;
  const inRange = (ts) => {
    if (!ts) return false;
    const d = new Date(String(ts).replace(' ', 'T') + '+08:00');
    if (isNaN(d)) return false;
    return range === 'month' ? String(ts).slice(0, 7) === curYM : d.getTime() >= weekAgo;
  };
  const alerts = getAlerts().filter(a => inRange(a.triggered_at));
  const intervs = getInterventions().filter(i => inRange(i.created_at));

  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [];
  lines.push('树洞信箱·心理中心' + (range === 'month' ? '月度' : '周度') + '报告');
  lines.push(esc('生成时间') + ',' + esc(new Date().toLocaleString('zh-CN')));
  lines.push(esc('累计脱敏样本') + ',' + esc(agg.total));
  lines.push(esc('负向情绪占比') + ',' + esc(agg.negPct + '%'));
  lines.push('');

  lines.push(esc('一、情绪分布'));
  lines.push([esc('情绪'), esc('人数'), esc('占比')].join(','));
  (agg.distribution || []).forEach(d => lines.push([esc(d.mood), esc(d.cnt), esc(d.pct + '%')].join(',')));
  lines.push('');

  lines.push(esc('二、高频话题（脱敏聚合）'));
  lines.push([esc('话题'), esc('人数')].join(','));
  (agg.topics || []).forEach(t => lines.push([esc(t.topic), esc(t.cnt)].join(',')));
  lines.push('');

  lines.push(esc('三、预警历史'));
  lines.push([esc('ID'), esc('触发时间'), esc('负向占比'), esc('话题'), esc('状态'), esc('处置备注')].join(','));
  alerts.forEach(a => lines.push([esc(a.id), esc(a.triggered_at), esc(a.neg_pct + '%'), esc(a.topic), esc(a.status), esc(a.note)].join(',')));
  lines.push('');

  lines.push(esc('四、干预台账'));
  lines.push([esc('ID'), esc('登记时间'), esc('话题'), esc('干预动作'), esc('经办人'), esc('说明'), esc('状态')].join(','));
  intervs.forEach(i => lines.push([esc(i.id), esc(i.created_at), esc(i.topic), esc(i.action), esc(i.handler), esc(i.detail), esc(i.status)].join(',')));

  const fname = `树洞信箱_${range === 'month' ? '月度' : '周度'}报告_${now.toISOString().slice(0, 10)}.csv`;
  // 中文文件名必须用 RFC 5987 编码（filename*=UTF-8''...），否则 Node 报 ERR_INVALID_CHAR；
  // 同时保留一个 ASCII 兜底文件名，兼容老旧下载器。
  const asciiName = `shudong_${range === 'month' ? 'monthly' : 'weekly'}_report_${now.toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send('\uFEFF' + lines.join('\r\n')); // BOM + CRLF，Excel 中文不乱码
});

/* —— 登录 —— */
app.post('/api/center/login', (req, res) => {
  if (DEMO) return res.status(400).json({ error: 'demo mode: no admin password set' });
  const token = (req.body && req.body.token) || '';
  if (ADMIN_PASS && token === ADMIN_PASS) {
    setSessionCookie(res, 'center', 'admin');
    return res.json({ ok: true, role: 'admin' });
  }
  if (COUNSELOR_PASS && token === COUNSELOR_PASS) {
    setSessionCookie(res, 'center', 'counselor');
    return res.json({ ok: true, role: 'counselor' });
  }
  return res.status(401).json({ error: 'invalid' });
});
app.get('/api/center/session', (req, res) => {
  const c = parseCookies(req)['sd_sid'];
  const s = c && verifySession(c);
  res.json({ authed: !!s || DEMO, demo: DEMO, user: s ? s.user : null, role: s ? s.role : (DEMO ? 'admin' : null) });
});
app.post('/api/center/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* —— 健康检查 —— */
app.get('/api/health', (req, res) => res.json({ ok: true }));

/* —— 清空全部脱敏样本（受登录保护） —— */
app.post('/api/clear', requireAdmin, (req, res) => {
  try { clearAll(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

/* ============ 静态页（同源，免 CORS） ============ */
const NO_STORE = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
app.get('/', NO_STORE, (req, res) => res.sendFile(PROTO_HTML));
app.get(['/center', '/center.html'], NO_STORE, (req, res) => res.sendFile(CENTER_HTML));

/* ============ 演示数据（默认关闭） ============ */
if (process.env.AUTO_SEED === '1') {
  try {
    if (getAggregate().total === 0) {
      const n = seed();
      console.log(`[seed] 已按 AUTO_SEED=1 灌入 ${n} 条脱敏示例数据`);
    }
  } catch (e) {
    console.warn('[seed] 自动灌数据失败（不影响服务启动）：' + (e && e.message ? e.message : e));
  }
}

const server = app.listen(PORT, () => {
  console.log(`树洞信箱后端已启动：http://localhost:${PORT}`);
  console.log(`  学生端原型：http://localhost:${PORT}/`);
  console.log(`  心理中心看板：http://localhost:${PORT}/center`);
  console.log(`  子路径挂载：${MOUNT_PREFIX}/ 与 ${MOUNT_PREFIX}/center（供 HTTP 网关路由使用）`);
  if (ADMIN_PASS) console.log('  中心端登录已启用（ADMIN_PASS）');
  else console.log('  ⚠ 中心端处于演示态（未设 ADMIN_PASS），任何人可访问');
  if (KEYS.length) console.log(`  LLM 代理已启用（${KEYS.length} 个 Key，单端每日配额 ${LLM_QUOTA_PER_DAY}）；Key 可在中心端「Key 管理」面板热更新`);
  else console.log('  ⚠ 未配置任何 Key（keys.json 为空且未设 LLM_KEYS 环境变量），/api/chat 与 /api/asr 将返回 503');
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n【启动失败】端口 ${PORT} 已被占用。`);
    console.error('最常见原因：上一次启动的树洞信箱窗口还没关（黑窗口关掉即释放端口）。');
    console.error('如果找不到那个窗口，可重启电脑，或换端口：修改启动脚本里的 PORT 后再启动。');
    process.exit(1);
  }
  throw err;
});
