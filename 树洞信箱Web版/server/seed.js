/* seed.js — 灌入脱敏示例数据，演示「上报 → 聚合 → 看板」闭环。
 * 仅生成 日期 + 情绪 + 话题 + 匿名ID，无任何原文，符合隐私设计。
 *
 * 两种用法：
 *   1) 手动：node seed.js
 *   2) 被 server.js 复用：库为空时自动灌入，保证首次启动的演示看板不空
 */
const { insertReport } = require('./db');

// 8 种情绪（按前端定义），前 3 种为偏正向，后 5 种为偏负向（含 4 种严格负向）
const MOODS = ['希望','温暖','平静','疲惫','焦虑','低落','崩溃','麻木'];
// 8 种话题
const TOPICS = ['学业','人际','就业','未来','身体','恋情','家庭','经济'];

// 用一组固定的匿名 ID 模拟不同同学（不绑定任何个人信息）
const ANONS = Array.from({ length: 40 }, (_, i) => 'seed-' + (i + 1).toString(36));

// 加权池：让负向情绪占比落在 ~40%（演示预警），学业话题最热
const moodPool = []
  .concat(Array(10).fill('希望'), Array(8).fill('温暖'), Array(6).fill('平静'))
  .concat(Array(9).fill('疲惫'), Array(9).fill('焦虑'), Array(6).fill('低落'))
  .concat(Array(2).fill('崩溃'), Array(4).fill('麻木'));
const topicPool = []
  .concat(Array(22).fill('学业'), Array(12).fill('人际'), Array(10).fill('就业'))
  .concat(Array(9).fill('未来'), Array(7).fill('身体'), Array(6).fill('恋情'))
  .concat(Array(5).fill('家庭'), Array(7).fill('经济'));

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pad(n) { return n < 10 ? '0' + n : '' + n; }

/* 最近 N 天，每天 8~11 条。日期取「运行当天」往前推，保证趋势图右端落在今天。 */
function seed({ days = 14 } = {}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let count = 0;
  for (let d = days - 1; d >= 0; d--) {
    const day = new Date(today.getTime() - d * 86400000);
    const date = day.getFullYear() + '-' + pad(day.getMonth() + 1) + '-' + pad(day.getDate());
    const n = 8 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      insertReport({
        anonId: pick(ANONS),
        date,
        mood: pick(moodPool),
        topic: pick(topicPool)
      });
      count++;
    }
  }
  return count;
}

/* 作为脚本直接运行时才灌数据；被 require 时不产生副作用 */
if (require.main === module) {
  const n = seed();
  console.log('已写入 ' + n + ' 条脱敏示例数据（截至今天往前 14 天）。');
  console.log('运行 npm start 后访问 http://localhost:3000/center 查看晴雨表。');
}

module.exports = { seed };
