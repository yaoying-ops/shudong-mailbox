/* 端到端：用 树洞信箱_原型.html 里真实的 CONSULT_PROMPT + buildChatTurns + squeezeChatText，
   跑真实 deepseek-chat，验证小咨输出的「空行压缩」（\n{2,} → \n，单换行保留）确实生效。
   用法: node tests/e2e_zi_newline.js [apiKey]
   Key 来源（按优先级）：命令行参数 > 环境变量 DEEPSEEK_KEY > 树洞信箱Web版/keys.json */
const fs = require('fs');
const path = require('path');
const https = require('https');

const SRC = path.join(__dirname, '..', '树洞信箱Web版', '树洞信箱_原型.html');
const KEYS_PATH = path.join(__dirname, '..', '树洞信箱Web版', 'keys.json');
const s = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function grab(re, name) {
  const m = s.match(re);
  if (!m) throw new Error('抽不到 ' + name);
  return m[0];
}
/* prompt 只取模板字符串内容；函数取完整源码文本 */
const CONSULT_PROMPT = (s.match(/const CONSULT_PROMPT = `([\s\S]*?)`;/) || [])[1];
if (!CONSULT_PROMPT) throw new Error('抽不到 CONSULT_PROMPT');
const buildChatTurns = grab(/function buildChatTurns\([\s\S]*?\n\}/, 'buildChatTurns');
const squeezeChatText = grab(/function squeezeChatText\([\s\S]*?\n\}/, 'squeezeChatText');
const _noteSrc = grab(/function buildHandoffNote\([\s\S]*?\n\}/, 'buildHandoffNote');

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

const AGENTS = { zi: { name: '小咨' } };
const window = {};
const history = [];
const ctx = new Function('history', 'AGENTS',
  buildChatTurns + ';' + _noteSrc + '; return { turns: buildChatTurns, note: buildHandoffNote };'
)(history, AGENTS);
const build = ctx.turns, buildHandoffNote = ctx.note;
const squeeze = new Function(squeezeChatText + '; return squeezeChatText;')();

function post(body, KEY) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.deepseek.com', path: '/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, 'Content-Length': Buffer.byteLength(data) }
    }, r => {
      let buf = '';
      r.on('data', d => buf += d);
      r.on('end', () => {
        try { res(JSON.parse(buf)); } catch (e) { rej(new Error(buf.slice(0, 300))); }
      });
    });
    req.on('error', rej);
    req.write(data); req.end();
  });
}

let KEY = '';
async function turn(hist, userText) {
  hist.push({ role: 'user', content: userText });
  const { turns, others } = build(hist);
  const system = CONSULT_PROMPT + buildHandoffNote('zi', others);
  const messages = [{ role: 'system', content: system }, ...turns];
  const r = await post({ model: 'deepseek-chat', messages, stream: false, temperature: 0.9 }, KEY);
  const text = r.choices[0].message.content;
  hist.push({ role: 'bot', agent: 'zi', content: text });
  return text;
}

const blank = t => /\n\s*\n/.test(t);

(async () => {
  KEY = resolveKey();
  if (!KEY) {
    console.error('未找到 Key。用法：node tests/e2e_zi_newline.js [apiKey]（或设 DEEPSEEK_KEY 环境变量）');
    process.exit(1);
  }
  const scenes = [
    ['场景1 考试失利→想要办法', [
      '我这次期末真的认真复习了，结果还是没考过，白忙一场。',
      '我真的想不通，到底哪里出了问题。',
      '你帮我分析分析，我下一步该怎么办？'
    ]],
    ['场景2 人际困扰→要具体步骤', [
      '我跟一个室友闹得挺僵的，现在连话都不想说了。',
      '我也想和好，但拉不下脸。',
      '给我几个能直接做的事行不行？'
    ]],
    ['场景3 家庭压力', [
      '我妈天天催我考研，我压力特别大。',
      '我知道她是为我好，但是我真的喘不过气。',
      '那我先做点什么？'
    ]]
  ];

  let total = 0, blankBefore = 0, blankAfter = 0, multiBlankAfter = 0;
  for (const [name, turns] of scenes) {
    const hist = [];
    console.log('\n' + '='.repeat(74));
    console.log('【' + name + '】');
    let idx = 0;
    for (const t of turns) {
      idx++;
      const raw = await turn(hist, t);
      const out = squeeze(raw, 'zi');
      total++;
      if (blank(raw)) blankBefore++;
      if (blank(out)) blankAfter++;
      if (/[^\S\n]*\n[^\S\n]*(?=\n)/.test(out)) multiBlankAfter++;
      console.log(`\n--- 第${idx}轮 学生: ${t}`);
      console.log(`    模型原样 (行数 ${raw.split('\n').length}${blank(raw) ? '，含空行' : ''}):`);
      console.log('    ' + raw.replace(/\n/g, ' ⏎ '));
      console.log(`    压缩后 (行数 ${out.split('\n').length}):`);
      console.log('    ' + out.replace(/\n/g, ' ⏎ '));
    }
  }
  console.log('\n' + '='.repeat(74));
  console.log(`共 ${total} 轮小咨输出`);
  console.log(`  压缩前含空行: ${blankBefore}/${total}`);
  console.log(`  压缩后仍含空行: ${blankAfter}/${total}   ← 必须为 0`);
  console.log(`  压缩后仍有「连续空行」: ${multiBlankAfter}/${total}   ← 必须为 0`);
  process.exit(blankAfter || multiBlankAfter ? 1 : 0);
})();
