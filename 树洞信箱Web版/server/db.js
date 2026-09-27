/* db.js — 数据层
 * 用 better-sqlite3 做落地（文件即数据库，零外部服务，npm install 后即可跑）。
 * 所有 SQL 都写成标准 SQL，将来要换成 PostgreSQL 只改这一个文件：
 *   - CREATE TABLE 的 AUTOINCREMENT 换成 SERIAL；
 *   - datetime('now') 换成 now()；
 *   - 下面的 db.prepare(...).all() 换成 pg 的 client.query(...)。
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'shudong.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

/* 唯一一张事实表：只存「脱敏三元组」，绝不存任何倾诉原文 */
db.exec(`
  CREATE TABLE IF NOT EXISTS mood_reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    anon_id    TEXT,
    date       TEXT,            -- YYYY-MM-DD
    mood       TEXT,            -- 希望/温暖/平静/疲惫/焦虑/低落/崩溃/麻木
    topic      TEXT,            -- 学业/人际/就业/未来/身体/恋情/家庭/经济
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mood_date ON mood_reports(date);
`);

/* 告警历史：每次聚合触发预警时落库，形成可跟踪的闭环（按 话题+日期 去重） */
db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    triggered_at TEXT DEFAULT (datetime('now')),
    date         TEXT,          -- 触发预警的日期（YYYY-MM-DD）
    neg_pct      INTEGER,      -- 当日负向占比
    topic        TEXT,          -- 负向最高话题
    advice       TEXT,          -- 系统给出的干预建议
    status       TEXT DEFAULT 'pending',  -- pending / handling / done / ignored
    note         TEXT           -- 心理中心老师填写的处置备注
  );
`);

/* 干预台账：心理中心针对某次预警 / 某话题实际采取的干预动作 */
db.exec(`
  CREATE TABLE IF NOT EXISTS interventions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id   INTEGER,        -- 关联的预警（可空：也可直接针对某话题登记）
    topic      TEXT,
    action     TEXT,           -- 干预动作（团体辅导 / 一对一约谈 / 推送推文 …）
    handler    TEXT,           -- 经办人
    detail     TEXT,           -- 处置说明
    status     TEXT DEFAULT 'done',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

/* 小测（PHQ-9 / GAD-7 标准化量表）结果：全脱敏，只存分级，不含任何原文 */
db.exec(`
  CREATE TABLE IF NOT EXISTS assessments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    anon_id    TEXT,                         -- 与 mood_reports 同源匿名标识
    date       TEXT,                         -- YYYY-MM-DD
    type       TEXT,                         -- 'PHQ9' / 'GAD7'
    score      INTEGER,
    level      TEXT,                         -- 'Normal'/'Mild'/'Moderate'/'Severe'
    q9_flag    INTEGER DEFAULT 0,           -- 自杀意念标记（PHQ-9 第 9 题 > 0）
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

/* 迁移：alerts 表扩展量表预警字段（幂等，可重复执行）。
   SQLite 不支持 ADD COLUMN IF NOT EXISTS，故用 PRAGMA 探测已存在列后按需补齐。 */
(function migrateAlerts(){
  try{
    const cols = db.prepare('PRAGMA table_info(alerts)').all().map(c=>c.name);
    const need = { source:"TEXT DEFAULT 'mood'", level:"TEXT", assessment_id:"INTEGER", anon_id:"TEXT DEFAULT ''", contact:"TEXT DEFAULT ''", contact_mode:"TEXT DEFAULT ''" };
    for(const [col, def] of Object.entries(need)){
      if(!cols.includes(col)) db.prepare(`ALTER TABLE alerts ADD COLUMN ${col} ${def}`).run();
    }
  }catch(e){ console.warn('[migrateAlerts] 跳过：'+e.message); }
})();

/* 用量配额：每个学生端匿名标识每日的代理调用次数（用于 Key 配额） */
db.exec(`
  CREATE TABLE IF NOT EXISTS usage (
    anon_id TEXT,
    date    TEXT,
    cnt     INTEGER DEFAULT 0,
    PRIMARY KEY (anon_id, date)
  );
`);

/* 合法情绪 / 话题白名单（与前端约定一致），非法值一律拒收 */
const MOODS = ['希望', '温暖', '平静', '疲惫', '焦虑', '低落', '崩溃', '麻木'];
const TOPICS = ['学业', '人际', '就业', '未来', '身体', '恋情', '家庭', '经济'];

/* 负向情绪集合（与前端 NEG_MOODS 保持一致） */
const NEG_MOODS = ['低落', '崩溃', '焦虑', '麻木'];

function insertReport({ anonId, date, mood, topic }) {
  if (!MOODS.includes(mood)) throw new Error('invalid mood: ' + mood);
  if (topic && !TOPICS.includes(topic)) topic = null; // 未知话题按空处理
  const stmt = db.prepare(
    'INSERT INTO mood_reports (anon_id, date, mood, topic) VALUES (?, ?, ?, ?)'
  );
  stmt.run(anonId || 'anon', date, mood, topic || null);
}

function getAggregate() {
  const totalRow = db.prepare('SELECT COUNT(*) AS n FROM mood_reports').get();
  const total = totalRow ? totalRow.n : 0;

  // 情绪分布
  const moodRows = db
    .prepare('SELECT mood, COUNT(*) AS cnt FROM mood_reports GROUP BY mood')
    .all();
  const distMap = {};
  moodRows.forEach(r => { distMap[r.mood] = r.cnt; });
  const distribution = Object.keys(distMap).map(mood => ({
    mood,
    cnt: distMap[mood],
    pct: total ? Math.round((distMap[mood] / total) * 100) : 0
  }));

  // 负向占比
  const negCnt = db
    .prepare(
      `SELECT COUNT(*) AS n FROM mood_reports WHERE mood IN (${NEG_MOODS.map(() => '?').join(',')})`
    )
    .get(...NEG_MOODS).n;
  const negPct = total ? Math.round((negCnt / total) * 100) : 0;

  // 最小样本抑制：仅用于「负向话题定向预警」（见 negTopics），避免拿单条负向发言反推个人。
  // 2026-09-24 起：高频话题词云不再设显示阈值（哪怕只有 1 条也按占比展示），
  // 隐私削减改由「占比」承担——小样本话题自然落在低占比上，不做硬性隐藏。
  const MIN_TOPIC_COUNT = 3;

  // 高频话题（脱敏聚合）：不限条数阈值，只按条数倒序取前 12
  const topicRows = db
    .prepare(
      `SELECT topic, COUNT(*) AS cnt FROM mood_reports
       WHERE topic IS NOT NULL GROUP BY topic ORDER BY cnt DESC, topic ASC LIMIT 12`
    )
    .all();

  // 负向情绪下的高频话题（用于预警建议定向）
  // 这里【保留】MIN_TOPIC_COUNT 抑制：它是预警定向的依据，单条负向发言即可反推出个人，
  // 与词云的「统计展示」性质不同，不能一并放开。
  const negTopics = db
    .prepare(
      `SELECT topic, COUNT(*) AS cnt FROM mood_reports
       WHERE topic IS NOT NULL AND mood IN (${NEG_MOODS.map(() => '?').join(',')})
       GROUP BY topic HAVING cnt >= ? ORDER BY cnt DESC LIMIT 8`
    )
    .all(...NEG_MOODS, MIN_TOPIC_COUNT);

  // 话题总条数（全部带话题的记录）：作为高频话题「占比」的分母，8 类话题占比之和为 100%
  const topicsTotal = db
    .prepare('SELECT COUNT(*) AS n FROM mood_reports WHERE topic IS NOT NULL')
    .get().n;

  return { total, distribution, negPct, topics: topicRows, negTopics, topicsTotal };
}

/* 台账：逐条（脱敏）记录，供心理中心逐条追溯。
 * 只含 anon_id（匿名设备标识，脱敏掩码）、date、mood、topic、created_at，绝不含任何原文。 */
function maskAnon(id) {
  if (!id) return '匿名';
  const s = String(id);
  // 仅展示前缀 6 位，其余打码：既能区分不同设备，又不暴露完整标识
  return s.length <= 6 ? s : s.slice(0, 6) + '•••';
}
function getLedger(limit = 500) {
  const rows = db
    .prepare(
      'SELECT id, anon_id, date, mood, topic, created_at FROM mood_reports ORDER BY created_at DESC LIMIT ?'
    )
    .all(limit);
  return rows.map(r => ({ ...r, anon_mask: maskAnon(r.anon_id) }));
}

/* 清空全部脱敏样本（物理删除，不可恢复）。保留数据表结构，仅清行。 */
function clearAll() {
  db.prepare('DELETE FROM mood_reports').run();
  db.pragma('wal_checkpoint(TRUNCATE)'); // 把 WAL 折叠回主库，避免残留
}

/* ---------------- 北京时间工具：不依赖主机/容器时区，固定 UTC+8 ---------------- */
function nowCN() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}
function dateCN() {
  return nowCN().slice(0, 10);
}

/* ---------------- 告警历史：触发预警时落库（按 话题+日期 去重） ---------------- */
/* 情绪预警冷却：同一话题在冷却窗口内已有预警时直接跳过（不新建也不更新）。
   「话题+日期」去重只能挡住同日同话题的重复；不同话题在几分钟内会各建一条，
   用户量大时预警历史会刷屏。默认 6 小时冷却，兼顾及时性与可读性。 */
const ALERT_COOLDOWN_MS = 6 * 3600000;
function upsertAlert({ date, negPct, topic, advice }) {
  const last = db
    .prepare('SELECT id, triggered_at FROM alerts WHERE topic=? ORDER BY id DESC LIMIT 1')
    .get(topic);
  if (last && last.triggered_at) {
    // triggered_at 存北京时间文本（nowCN），补 +08:00 解析成 UTC 时间戳再比较
    const lastTs = Date.parse(last.triggered_at.replace(' ', 'T') + '+08:00');
    if (Number.isFinite(lastTs) && Date.now() - lastTs < ALERT_COOLDOWN_MS) return last.id;
  }
  const exist = db
    .prepare('SELECT id FROM alerts WHERE topic=? AND date=? ORDER BY id DESC LIMIT 1')
    .get(topic, date);
  if (exist) {
    db.prepare(
      'UPDATE alerts SET neg_pct=?, advice=?, triggered_at=? WHERE id=?'
    ).run(negPct, advice, nowCN(), exist.id);
    return exist.id;
  }
  const info = db
    .prepare(
      "INSERT INTO alerts (date, neg_pct, topic, advice, status, triggered_at) VALUES (?,?,?,?, 'pending', ?)"
    )
    .run(date, negPct, topic, advice, nowCN());
  return info.lastInsertRowid;
}

function getAlerts() {
  return db.prepare('SELECT * FROM alerts ORDER BY triggered_at DESC').all();
}

// 状态值只允许小写字母/下划线、长度受限，从根源阻断 XSS 注入（原库写入不校验）
function validStatus(s) { return typeof s === 'string' && /^[a-z_]{1,24}$/.test(s); }
function updateAlert(id, { status, note }) {
  if (status !== undefined) {
    if (!validStatus(status)) throw new Error('invalid alert status: ' + status);
    db.prepare('UPDATE alerts SET status=? WHERE id=?').run(status, id);
  }
  if (note !== undefined) db.prepare('UPDATE alerts SET note=? WHERE id=?').run(note, id);
}

/* ---------------- 干预台账 ---------------- */
function addIntervention({ alert_id, topic, action, handler, detail, status }) {
  const info = db
    .prepare(
      `INSERT INTO interventions (alert_id, topic, action, handler, detail, status)
       VALUES (?,?,?,?,?,?)`
    )
    .run(alert_id || null, topic || null, action || '', handler || '', detail || '', validStatus(status) ? status : 'done');
  return info.lastInsertRowid;
}

function getInterventions() {
  return db.prepare('SELECT * FROM interventions ORDER BY created_at DESC').all();
}

/* 小测结果（脱敏）：仅存 anon_id + 分级，不含任何原文 */
function insertAssessment({ anonId, date, type, score, level, q9Flag }) {
  const info = db.prepare(
    `INSERT INTO assessments (anon_id, date, type, score, level, q9_flag)
     VALUES (?,?,?,?,?,?)`
  ).run(anonId || null, date || null, type || '', score || 0, level || 'Normal', q9Flag ? 1 : 0);
  return info.lastInsertRowid;
}

/* 量表预警（与小测结果关联）：仅当 level∈{Moderate,Severe} 或 q9Flag=1 时由服务端调用。
   neg_pct 对量表预警无意义，置 NULL；中心端按 source/level 渲染。 */
function insertAssessmentAlert({ date, level, advice, assessmentId, topic, anonId, contact, contactMode }) {
  const info = db.prepare(
    `INSERT INTO alerts (date, neg_pct, topic, advice, status, triggered_at, source, level, assessment_id, anon_id, contact, contact_mode)
     VALUES (?,NULL,?,?,'pending',?,'assessment',?,?,?,?,?)`
  ).run(date || null, topic || '自测·抑郁/焦虑', advice || '', dateCN(), level || 'Normal', assessmentId || null, anonId || '', contact || '', contactMode || '');
  return info.lastInsertRowid;
}
/* 学生高危自测后补充留联：把联系方式挂到该匿名标识最新的量表预警上（仅高危可见，普通台账不展示）。降级不写。 */
function updateAssessmentContact({ anonId, contact, contactMode }) {
  if (!anonId) return false;
  const row = db.prepare(
    `SELECT id FROM alerts WHERE source='assessment' AND anon_id=? ORDER BY id DESC LIMIT 1`
  ).get(anonId);
  if (!row) return false;
  db.prepare(`UPDATE alerts SET contact=?, contact_mode=? WHERE id=?`).run(contact || '', contactMode || '', row.id);
  return true;
}

/* 小测结果台账：脱敏返回（anon_id 掩码），供中心端「自测台账」展示 */
function getAssessments() {
  return db.prepare(
    `SELECT id, anon_id, date, type, score, level, q9_flag AS q9Flag, created_at
     FROM assessments ORDER BY id DESC`
  ).all();
}
/* 清空小测台账（仅演示/隐私重置用，物理删除不可恢复） */
function clearAssessments() {
  db.prepare('DELETE FROM assessments').run();
  db.pragma('wal_checkpoint(TRUNCATE)');
}

/* 清空预警处理数据（预警历史 + 干预台账），物理删除不可恢复，保留表结构。 */
function clearLoop() {
  db.prepare('DELETE FROM alerts').run();
  db.prepare('DELETE FROM interventions').run();
  db.pragma('wal_checkpoint(TRUNCATE)');
}

function updateIntervention(id, { action, handler, detail, status }) {
  if (action !== undefined) db.prepare('UPDATE interventions SET action=? WHERE id=?').run(action, id);
  if (handler !== undefined) db.prepare('UPDATE interventions SET handler=? WHERE id=?').run(handler, id);
  if (detail !== undefined) db.prepare('UPDATE interventions SET detail=? WHERE id=?').run(detail, id);
  if (status !== undefined) db.prepare('UPDATE interventions SET status=? WHERE id=?').run(status, id);
}

/* ---------------- 用量配额 ---------------- */
function getUsage(anonId, date) {
  const row = db.prepare('SELECT cnt FROM usage WHERE anon_id=? AND date=?').get(anonId, date);
  return row ? row.cnt : 0;
}

function incUsage(anonId, date) {
  db.prepare(
    `INSERT INTO usage (anon_id, date, cnt) VALUES (?,?,1)
     ON CONFLICT(anon_id, date) DO UPDATE SET cnt = cnt + 1`
  ).run(anonId, date);
}

/* ---------------- 知识库（参照 DeepSeek Harness 知识库机制） ----------------
 * 存储层：kb_entries —— 结构化条目 + 元数据（source/version/effective_date/status）+ 软删除（tombstone）
 * 索引层：放在 server.js（内存索引 kbIndex，由本表构建；编辑/重建后重载）—— 对应 Harness「重建索引」步骤
 * 检索层：server.js 的 searchKb —— 关键词(lexical) + 标签/分类语义(semantic) 混合召回 + 重排序
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS kb_entries (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    category       TEXT,
    title          TEXT NOT NULL,
    content        TEXT NOT NULL,
    keywords       TEXT DEFAULT '[]',   -- JSON 数组
    tags           TEXT DEFAULT '[]',   -- JSON 数组（语义标签，用于混合检索）
    source         TEXT DEFAULT '中心录入',
    version        INTEGER DEFAULT 1,
    effective_date TEXT,               -- YYYY-MM-DD
    status         TEXT DEFAULT 'published',  -- published | draft
    deleted        INTEGER DEFAULT 0,  -- tombstone（软删除）
    created_by     TEXT,
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now'))
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_kb_deleted ON kb_entries(deleted);');

function jsonArr(s) {
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function kbRowToObj(r) {
  return {
    id: r.id,
    category: r.category || '',
    title: r.title || '',
    content: r.content || '',
    answer: r.content || '',                 // 兼容学生端 e.answer 字段
    keywords: jsonArr(r.keywords),
    tags: jsonArr(r.tags),
    source: r.source || '',
    version: r.version || 1,
    effectiveDate: r.effective_date || '',
    status: r.status || 'published',
    deleted: !!r.deleted,
    createdBy: r.created_by || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
function getKbEntries({ includeDrafts = false, includeDeleted = false } = {}) {
  let sql = 'SELECT * FROM kb_entries WHERE 1=1';
  if (!includeDeleted) sql += ' AND deleted=0';
  if (!includeDrafts) sql += " AND status='published'";
  sql += ' ORDER BY id';
  return db.prepare(sql).all().map(kbRowToObj);
}
function getKbIds() {
  return db.prepare('SELECT id FROM kb_entries WHERE deleted=0').all().map(r => r.id);
}
function getKbEntry(id) {
  const r = db.prepare('SELECT * FROM kb_entries WHERE id=?').get(id);
  return r ? kbRowToObj(r) : null;
}
/* upsert：有 id 且存在则更新（内容变更时 version+1），否则插入。返回 id。 */
function upsertKbEntry(e) {
  const kw = JSON.stringify((e.keywords && e.keywords.length) ? e.keywords : []);
  const tg = JSON.stringify((e.tags && e.tags.length) ? e.tags : []);
  if (e.id) {
    const ex = db.prepare('SELECT id, content FROM kb_entries WHERE id=?').get(e.id);
    if (ex) {
      const bump = (ex.content !== (e.content || '')) ? ', version = version + 1' : '';
      db.prepare(
        `UPDATE kb_entries SET category=?, title=?, content=?, keywords=?, tags=?, source=?,
           effective_date=?, status=?, created_by=?, updated_at=datetime('now')${bump} WHERE id=?`
      ).run(
        e.category || '', e.title || '未命名', e.content || '', kw, tg,
        e.source || '中心录入', e.effectiveDate || null, e.status || 'published',
        e.createdBy || null, e.id
      );
      return e.id;
    }
  }
  const info = db.prepare(
    `INSERT INTO kb_entries (category,title,content,keywords,tags,source,effective_date,status,created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    e.category || '', e.title || '未命名', e.content || '', kw, tg,
    e.source || '中心录入', e.effectiveDate || null, e.status || 'published', e.createdBy || null
  );
  return info.lastInsertRowid;
}
function softDeleteKbEntry(id) {
  db.prepare("UPDATE kb_entries SET deleted=1, updated_at=datetime('now') WHERE id=?").run(id);
}
function softDeleteAllKb() {
  db.prepare("UPDATE kb_entries SET deleted=1, updated_at=datetime('now') WHERE deleted=0").run();
}
/* 首次启动若知识库为空，从中心端 JSON（原单一真相源）一次性导入，保留已有分类/关键词 */
function seedKbFromJson() {
  const n = db.prepare('SELECT COUNT(*) n FROM kb_entries WHERE deleted=0').get().n;
  if (n > 0) return 0;
  const p = path.join(__dirname, '..', '树洞信箱_知识库_ima补充.json');
  try {
    if (!fs.existsSync(p)) return 0;
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) return 0;
    const stmt = db.prepare(
      `INSERT INTO kb_entries (category,title,content,keywords,tags,source,status)
       VALUES (?,?,?,?,?,?,?)`
    );
    const ins = db.transaction(rows => {
      let c = 0;
      for (const x of rows) {
        const content = x.answer || x.content || x.text || '';
        if (!content.trim()) continue;
        const kw = Array.isArray(x.keywords)
          ? x.keywords
          : (x.keywords ? String(x.keywords).split(/[,，|\s、]+/).filter(Boolean) : []);
        stmt.run(x.category || '', x.title || x.name || '未命名', content,
          JSON.stringify(kw), JSON.stringify(kw), '初始导入', 'published');
        c++;
      }
      return c;
    });
    return ins(arr);
  } catch (e) {
    console.warn('[kb] 种子导入失败：' + e.message);
    return 0;
  }
}

module.exports = {
  db, insertReport, getAggregate, getLedger, clearAll,
  nowCN, dateCN,
  upsertAlert, getAlerts, updateAlert,
  addIntervention, getInterventions, updateIntervention, clearLoop,
  insertAssessment, insertAssessmentAlert, updateAssessmentContact, getAssessments, clearAssessments,
  getUsage, incUsage,
  NEG_MOODS, MOODS, TOPICS,
  getKbEntries, getKbIds, getKbEntry, upsertKbEntry, softDeleteKbEntry, softDeleteAllKb, seedKbFromJson
};
