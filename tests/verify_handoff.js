/* 端到端回归：直接抽仓库里 树洞信箱_原型.html 自己的 buildChatTurns / buildHandoffNote 来装配，
   证明「小咨推给小咨」（跨 Agent 历史污染）不再出现。
   用法: node tests/verify_handoff.js [apiKey]
   Key 来源（按优先级）：命令行参数 > 环境变量 DEEPSEEK_KEY > 树洞信箱Web版/keys.json */
const fs = require('fs');
const path = require('path');

const P = path.join(__dirname, '..', '树洞信箱Web版', '树洞信箱_原型.html');
const KEYS_PATH = path.join(__dirname, '..', '树洞信箱Web版', 'keys.json');
const src = fs.readFileSync(P, 'utf8').replace(/\r\n/g, '\n');

/* 按大括号配对精确抽函数，避免正则截断 */
function extractFn(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const CONSULT_PROMPT = src.match(/const CONSULT_PROMPT = `([\s\S]*?)`;/)[1];

function resolveKey() {
  if (process.argv[2]) return process.argv[2];
  if (process.env.DEEPSEEK_KEY) return process.env.DEEPSEEK_KEY;
  try {
    const obj = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
    const arr = Array.isArray(obj) ? obj : obj.keys;
    const hit = (arr || []).find(x => x.provider === 'deepseek' && x.key);
    if (hit) return hit.key;
  } catch (e) { /* keys.json 不存在 */ }
  return '';
}

/* —— 复刻运行环境（只取被测函数需要的全局） —— */
const AGENTS = { pei: { name: '小陪' }, zi: { name: '小咨' }, ce: { name: '小测' } };
const window = {};
const history = [];                       // 注意：必须先绑定、再原地 push——
const buildChatTurns = new Function('history', 'return ' + extractFn('buildChatTurns'))(history);
const agentName = new Function('AGENTS', 'return ' + extractFn('agentName'))(AGENTS);
const buildHandoffNote = new Function('AGENTS', 'agentName', 'return ' + extractFn('buildHandoffNote'))(AGENTS, agentName);

/* 截图场景：小陪交完棒，学生回「你帮我分析分析」 */
[
  { role: 'user', content: '最近跟室友关系特别僵，家里又天天催我考研，两头一起堵着' },
  { role: 'bot', agent: 'pei', content: '哎，两头一起堵着……这日子确实憋得慌。' },
  { role: 'user', content: '也不是谁对谁错吧，就是说不清' },
  { role: 'bot', agent: 'pei', content: '嗯，说不清的时候最磨人。那你现在最难受的，是跟他们没话说的那种感觉吗？' },
  { role: 'user', content: '都有吧，一团乱麻' },
  { role: 'bot', agent: 'pei', content: '哎，这个我帮不了你分析呀，我这儿只负责听你说。想捋捋怎么办，得去小咨那儿。这会儿想让我再陪会儿，还是去小咨那看看？' },
  { role: 'user', content: '你帮我分析分析' }
].forEach(m => history.push(m));          // 原地改，闭包才看得到
const memo = '\n\n【你之前听 ta 说过这些，聊到相关话题时自然接住、表现出你记得，别生硬重复】\n· 最近跟室友关系特别僵，家里又天天催我考研，两头\n· 也不是谁对谁错吧，就是说不清\n· 都有吧，一团乱麻';

const cy = buildChatTurns('zi');
const system = CONSULT_PROMPT + memo + buildHandoffNote('zi', cy.others);
const messages = [{ role: 'system', content: system }, ...cy.turns];

console.log('装配结果：messages 共 ' + messages.length + ' 条 —— '
  + messages.map(m => m.role === 'system' ? 'system(' + m.content.length + '字)' : m.role).join(' → '));
console.log('小陪的话是否还冒充成"我说过的"(assistant)：',
  cy.turns.some(t => t.role === 'assistant' && /帮不了|小咨那儿/.test(t.content)) ? '是（未修好）' : '否 ✔');
console.log('小陪的话是否进了背景块并标明不是你：', /这些话不是你/.test(system) ? '是 ✔' : '否');

const SELF_REF = /小咨那儿|小咨那看看|找小咨|去小咨|问小咨|交给小咨|小咨更|小咨擅|小咨比我/;
const PUSH_OUT = /帮不了|帮不上|不是该我|该接的活|不是我的活|只负责听|不归我|接不住|不是我负责/;

(async () => {
  const KEY = resolveKey();
  if (!KEY) {
    console.error('\n未找到 Key，跳过真实模型调用（装配自检已通过）。');
    console.error('要跑真实调用：node tests/verify_handoff.js [apiKey]（或设 DEEPSEEK_KEY 环境变量）');
    return;
  }
  const N = 8; let sr = 0, po = 0;
  console.log('\n—— 8 次真实调用（deepseek-chat, T=0.9）——');
  for (let i = 1; i <= N; i++) {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
      body: JSON.stringify({ model: 'deepseek-chat', messages, stream: false, temperature: 0.9 })
    });
    if (!res.ok) { console.log('  #' + i + ' 调用失败 ' + res.status); continue; }
    const out = (await res.json()).choices[0].message.content.trim();
    const a = SELF_REF.test(out), b = PUSH_OUT.test(out);
    if (a) sr++; if (b) po++;
    console.log('  #' + i + (a ? ' [自指]' : '') + (b ? ' [撇清]' : '') + ' ' + out.replace(/\n+/g, ' / '));
  }
  console.log('\n结论：自指 ' + sr + '/' + N + '，撇清 ' + po + '/' + N + '（期望均为 0）');
})();
