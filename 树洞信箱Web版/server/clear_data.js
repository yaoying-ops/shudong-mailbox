/* clear_data.js — 清空树洞晴雨表的所有样本数据，让心理中心看板初始为空。
 * 用法：node clear_data.js
 * 说明：只删 mood_reports 表的行（保留表结构，随时可重新上报）。
 *       顺手用 fs 清掉遗留的 WAL/SHM 日志（主库被删后它们是孤儿，避免下次打开报 malformed）。
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dir = __dirname;
for (const f of ['shudong.sqlite-wal', 'shudong.sqlite-shm']) {
  const p = path.join(dir, f);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
}

const db = new Database(path.join(dir, 'shudong.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS mood_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, anon_id TEXT, date TEXT,
  mood TEXT, topic TEXT, created_at TEXT DEFAULT (datetime('now'))
);`);
db.exec('DELETE FROM mood_reports;');
db.pragma('wal_checkpoint(TRUNCATE)');
const n = db.prepare('SELECT COUNT(*) AS c FROM mood_reports').get().c;
console.log('cleared. rows left:', n);
db.close();
