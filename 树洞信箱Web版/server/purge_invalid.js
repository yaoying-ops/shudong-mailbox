/* purge_invalid.js — 清理白名单外的脏数据
 * 用途：删除 mood 不在 8 个合法情绪里的记录；topic 非法时置空。
 * 运行：node purge_invalid.js
 */
const { db, MOODS, TOPICS } = require('./db');

const moodPh = MOODS.map(() => '?').join(',');
const before = db.prepare('SELECT COUNT(*) AS n FROM mood_reports').get().n;

const del = db.prepare(`DELETE FROM mood_reports WHERE mood NOT IN (${moodPh})`).run(...MOODS);
const fixTopic = db
  .prepare(`UPDATE mood_reports SET topic = NULL WHERE topic IS NOT NULL AND topic NOT IN (${TOPICS.map(() => '?').join(',')})`)
  .run(...TOPICS);
const after = db.prepare('SELECT COUNT(*) AS n FROM mood_reports').get().n;

console.log(`before: ${before} rows`);
console.log(`deleted invalid-mood rows: ${del.changes}`);
console.log(`cleared invalid topics: ${fixTopic.changes}`);
console.log(`after: ${after} rows`);
