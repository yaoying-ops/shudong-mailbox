#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_synthetic.py —— 生成合成学生倾诉语料（仅用于流水线自检，非真实数据）
覆盖 8 类话题 + 含 PII + 含危机信号，验证 deidentify + analyze 端到端可跑。
用法: python make_synthetic.py --n 60 --out demo_synth/corpus.json
"""
import argparse, json, os, random

TOPICS = {
    "学业/考研": [
        "老师，我最近复习不进去，一想到考研就心慌，怕考不上。",
        "我已经连续三周每天只睡五个小时，刷题刷到麻木了。",
        "爸妈觉得我必须考上985，可我真的很累。",
        "同学都好厉害，我觉得自己什么都学不会。",
    ],
    "家庭/父母期待": [
        "我妈总是拿我跟别人家孩子比，我好难受。",
        "家里希望我考公务员，可我想做设计，我不敢说。",
        "我爸从来不听我说话，只讲他的道理。",
        "每次回家都要吵架，我越来越不想回去了。",
    ],
    "亲密关系/失恋": [
        "我们在一起三年，他昨天说分手，我一夜没睡。",
        "我还是忘不掉她，看到她的动态就难受。",
        "异地恋好累，我不知道还能撑多久。",
        "我总怕他不够喜欢我，一遍遍看他手机。",
    ],
    "人际/同辈": [
        "宿舍关系很差，我回去都觉得压抑。",
        "我在社团里像个透明人，没人理我。",
        "朋友好像都比我过得好，我有点嫉妒又讨厌这样的自己。",
        "我帮了别人很多，却没人记得我。",
    ],
    "情绪/抑郁焦虑": [
        "我最近总是莫名想哭，什么都不想做。",
        "心慌得厉害，去医院说是焦虑症。",
        "我睡不好，白天又困，整个人是空的。",
        "我好像失去了开心的能力。",
    ],
    "自我认同/意义感": [
        "我不知道自己是谁，也不知道想要什么。",
        "努力到底为了什么，我觉得一切都没意义。",
        "我很讨厌现在的自己。",
        "我总觉得自己是多余的。",
    ],
    "就业/未来": [
        "秋招一个offer都没有，我是不是很失败。",
        "看到同学都签了，我晚上睡不着。",
        "我学的专业好像没什么用，很迷茫。",
        "面试被拒了好多次，我不敢再投了。",
    ],
    "危机（自伤/自杀）": [
        "我真的很想消失，睡着了就不想再醒来。",
        "有时候我会想，如果我不在了，是不是大家都轻松了。",
        "我最近总想着自残，看到刀就控制不住。",
        "我觉得撑不住了，活不下去。",
    ],
}
ASSIST = [
    "我在，你愿意多说一点吗？",
    "谢谢你愿意告诉我这些，我听到了。",
    "这种感觉确实很难熬，你并不孤单。",
    "你现在安全吗？我很在意你的状态。",
    "慢慢来，不用急着说清楚。",
]
PII_TEMPLATES = [
    "（我叫{name}，手机{phone}）",
    "（学号{sid}，在南通大学）",
    "（微信是{wx}）",
    "（我从{city}来的）",
    "（{y}年{m}月{d}日开始这样）",
]
NAMES = ["李明", "王芳", "张伟", "刘洋", "陈静", "杨雷", "赵磊", "周敏"]


def gen(n, seed=42):
    rnd = random.Random(seed)
    out = []
    for i in range(n):
        topic = rnd.choice(list(TOPICS))
        nl = rnd.randint(2, 5)
        msgs = TOPICS[topic][:]
        rnd.shuffle(msgs)
        conv = []
        for j in range(min(nl, len(msgs))):
            txt = msgs[j]
            if rnd.random() < 0.5:
                txt += rnd.choice(PII_TEMPLATES).format(
                    name=rnd.choice(NAMES), phone="13" + str(rnd.randint(100000000, 999999999)),
                    sid=str(rnd.randint(2021000000, 2023999999)), wx="stu" + str(rnd.randint(1000, 9999)),
                    city=rnd.choice(["南通", "南京", "苏州", "杭州", "武汉", "成都"]),
                    y=rnd.choice([2021, 2022, 2023, 2024]), m=rnd.randint(1, 12), d=rnd.randint(1, 28))
            conv.append({"role": "user", "text": txt})
            conv.append({"role": "assistant", "text": rnd.choice(ASSIST)})
        out.append({"id": f"s{i:04d}", "topic_hint": topic, "conversation": conv,
                    "metadata": {"name": rnd.choice(NAMES), "student_id": str(rnd.randint(2021000000, 2023999999)),
                                 "school": "南通大学", "grade": rnd.choice(["大一", "大二", "大三", "大四"]),
                                 "major": rnd.choice(["计算机", "中文", "机械", "临床医学"]),
                                 "gender": rnd.choice(["男", "女"])}})
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--out", default="demo_synth/corpus.json")
    a = ap.parse_args()
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    data = gen(a.n)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"生成 {len(data)} 条 -> {a.out}")
