/* 复现「小咨推给小咨」：跨 Agent 历史污染（三臂对照实验）
   用法: node tests/repro_handoff.js [apiKey]
   对照 A=旧写法(所有 bot 轮一律当 assistant)
        B=只做历史隔离          C=隔离 + prompt 明确「你就是小咨本人」
   线上现行版本 = C 臂（buildChatTurns + buildHandoffNote + 自我指涉护栏）。
   Key 来源（按优先级）：命令行参数 > 环境变量 DEEPSEEK_KEY > 树洞信箱Web版/keys.json */
const fs = require('fs');
const path = require('path');

const PROTO = path.join(__dirname, '..', '树洞信箱Web版', '树洞信箱_原型.html');
const KEYS_PATH = path.join(__dirname, '..', '树洞信箱Web版', 'keys.json');

const html = fs.readFileSync(PROTO, 'utf8');
const grab = n => { const m = html.match(new RegExp('const ' + n + ' = `([\\s\\S]*?)`;')); if (!m) throw new Error('missing ' + n); return m[1]; };
const CONSULT_PROMPT = grab('CONSULT_PROMPT');

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

const URL_DS = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';
const N = 8;

const GUARD = '\n- **你就是小咨本人**：绝不说"去小咨那儿""找小咨""小咨更擅长"这类话——那是小陪的台词。'
  + '学生要找的就是你，用第一人称回应，别把自己当外人、也别替他转介。只有校心理中心和热线 12356 这类真实资源才需要"去找"。';

const history = [
  { role: 'user', content: '最近跟室友关系特别僵，家里又天天催我考研，两头一起堵着' },
  { role: 'bot', agent: 'pei', content: '哎，两头一起堵着……这日子确实憋得慌。' },
  { role: 'user', content: '也不是谁对谁错吧，就是说不清' },
  { role: 'bot', agent: 'pei', content: '嗯，说不清的时候最磨人。那你现在最难受的，是跟他们没话说的那种感觉吗？' },
  { role: 'user', content: '都有吧，一团乱麻' },
  { role: 'bot', agent: 'pei', content: '哎，这个我帮不了你分析呀，我这儿只负责听你说。想捋捋怎么办，得去小咨那儿。这会儿想让我再陪会儿，还是去小咨那看看？' },
  { role: 'user', content: '你帮我分析分析' }
];
const MEMO = '\n\n【你之前听 ta 说过这些，聊到相关话题时自然接住、表现出你记得，别生硬重复】\n· 最近跟室友关系特别僵，家里又天天催我考研，两头\n· 也不是谁对谁错吧，就是说不清\n· 都有吧，一团乱麻';
const NAME = { pei: '小陪', zi: '小咨', ce: '小测' };

/* 隔离后的装配：自己的轮次 → assistant；别家的轮次 → 收进 system 背景并标明"不是你" */
function buildTurns(agent) {
  const turns = [], others = [];
  for (const m of history) {
    if (m.role === 'user') { turns.push({ role: 'user', content: m.content }); continue; }
    const who = m.agent || 'pei';
    if (who === agent) turns.push({ role: 'assistant', content: m.content });
    else others.push({ who, content: m.content });
  }
  let sys = CONSULT_PROMPT + MEMO;
  if (others.length) {
    const last = others[others.length - 1];
    sys += '\n\n【背景·这些话不是你（' + NAME[agent] + '）说的】'
      + '学生在你之前是和「' + NAME[last.who] + '」聊的。下面是「' + NAME[last.who] + '」的原话，'
      + '那是**另一个伙伴**说的，不是你的话——别沿用那个口吻，更别跟着把自己叫作"那边""小咨那儿"。\n'
      + others.map(o => '· ' + NAME[o.who] + '：' + o.content).join('\n')
      + '\n现在由你（' + NAME[agent] + '）接手，回答学生的最后一句。';
  }
  return [{ role: 'system', content: sys }, ...turns];
}
function buildA(agent) {
  return [
    { role: 'system', content: CONSULT_PROMPT + MEMO },
    ...history.map(m => ({ role: m.role === 'bot' ? 'assistant' : m.role, content: m.content }))
  ];
}
function buildB() { return buildTurns('zi'); }
function buildC() {
  const msgs = buildTurns('zi');
  msgs[0] = { role: 'system', content: msgs[0].content + GUARD };
  return msgs;
}

async function ask(messages, KEY) {
  const res = await fetch(URL_DS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
    body: JSON.stringify({ model: MODEL, messages, stream: false, temperature: 0.9 })
  });
  if (!res.ok) throw new Error(res.status + ' ' + (await res.text()).slice(0, 200));
  return (await res.json()).choices[0].message.content.trim();
}

/* 判据收紧：只认「把小咨当外人」的说法；"室友那边"这类正常表述不算 */
const SELF_REF = /小咨那儿|小咨那看看|找小咨|去小咨|问小咨|交给小咨|小咨更|小咨擅|小咨比我/;
const PUSH_OUT = /帮不了|帮不上|不是该我|该接的活|不是我的活|只负责听|不归我|接不住|不是我负责/;

(async () => {
  const KEY = resolveKey();
  if (!KEY) {
    console.error('未找到 Key。用法：node tests/repro_handoff.js [apiKey]（或设 DEEPSEEK_KEY 环境变量）');
    process.exit(1);
  }
  for (const [tag, build] of [['A 旧写法', buildA], ['B 仅隔离历史', buildB], ['C 隔离+措辞护栏（线上现行）', buildC]]) {
    let sr = 0, po = 0, ok = 0;
    console.log('\n======== ' + tag + ' ========');
    for (let i = 1; i <= N; i++) {
      let out;
      try { out = await ask(build('zi'), KEY); } catch (e) { console.log('  #' + i + ' 调用失败 ' + e.message); continue; }
      ok++;
      const a = SELF_REF.test(out), b = PUSH_OUT.test(out);
      if (a) sr++; if (b) po++;
      console.log('  #' + i + (a ? ' [自指]' : '') + (b ? ' [撇清]' : '') + ' ' + out.replace(/\n+/g, ' / '));
    }
    console.log('  —— 自指 ' + sr + '/' + ok + '，撇清 ' + po + '/' + ok);
  }
})();
