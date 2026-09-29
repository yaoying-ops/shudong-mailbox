#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyze.py —— 树洞信箱 · 学生倾诉语料分析流水线（9 阶段）
====================================================================
输入：deidentify.py 产出的【已脱敏】语料（.json / .jsonl）
输出：<outdir>/
  report.md             面向人的可读分析报告
  summary.json          结构化总览
  topics.json           话题聚类结果（词表 + 代表句）
  risk_flags.jsonl      危机标记记录（供人工复核 / 转介流程设计）
  disengagement.json    离场/沉默节点统计（对接"呼吸放松卡片"触发逻辑）
  intent.json           需求意图分布（被听见/要建议/要分散注意力）
  eval_set.jsonl        脱敏评估集（供 Agent 回归测试）
  yalom_alignment.md    话题 -> Yalom 主题 -> 建议写入 Yalom.md 的条目

依赖策略
  必需：无（纯标准库即可跑 Stage1/3/4/5/6/8 与简化版 2）
  可选：jieba（中文分词）、scikit-learn + numpy（TF-IDF + KMeans 话题聚类）
       缺失时自动降级为"词典命中 + 字符 n-gram 频次"，并明确标注降级状态。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
from collections import Counter, defaultdict

# ---------------------------------------------------------------- 可选依赖
try:
    import jieba  # type: ignore
    _HAS_JIEBA = True
except Exception:
    _HAS_JIEBA = False

try:
    from sklearn.feature_extraction.text import TfidfVectorizer  # type: ignore
    from sklearn.cluster import KMeans  # type: ignore
    from sklearn.metrics import silhouette_score  # type: ignore
    import numpy as np  # type: ignore
    _HAS_SK = True
except Exception:
    _HAS_SK = False

# ---------------------------------------------------------------- 词表
STOPWORDS = set("""
的 了 是 我 你 他 她 它 我们 你们 他们 这 那 这个 那个 一个 就 都 也 还 又 很 太 更
和 与 或 及 而 但 可是 不过 因为 所以 如果 然后 现在 就是 什么 怎么 为什么 没有 不是
在 有 会 能 可以 要 想 说 觉得 感觉 知道 自己 时候 一次 一下 真的 好像 其实 应该 可能
啊 吧 呢 吗 哦 嗯 哈 呀 嘛 呗 啦 各位 老师 同学 谢谢 你好 您好
""".split())

# 情绪词典（可扩充；生产建议换 SnowNLP / 大模型打分）
POS_WORDS = set("""
开心 高兴 快乐 幸福 满足 感 感动 温暖 希望 期待 轻松 放松 释然 舒服 安心 踏实 有力量
感谢 谢谢 喜欢 爱 顺利 进步 成功 好起来 想通了 明白了 被理解 有人陪 不开心 不难过
""".split())
NEG_WORDS = set("""
难过 伤心 痛苦 抑郁 焦虑 压力 崩溃 绝望 孤独 寂寞 委屈 生气 愤怒 害怕 恐惧 担心 无助
迷茫 累 疲惫 失眠 空虚 麻木 无力 撑不住 想不通 自责 内疚 羞耻 失败 没意思 没意义
烦 郁闷 压抑 难受 想哭 想消失 想死 讨厌 恨 不公平 委屈 被忽视 被否定
""".split())
NEGATORS = set("不 没 无 别 莫 未 非 没有 不是 不再".split())

# 危机语言分级（渐进式；T1 最高危）
CRISIS_TIERS = {
    "T1_直接风险": ["自杀", "自残", "自伤", "割腕", "跳楼", "上吊", "服毒", "安眠药", "结束生命",
                "不想活", "想死", "去死", "活不下去", "不如死", "解脱了", "遗书", "交代后事"],
    "T2_重度痛苦": ["绝望", "崩溃", "撑不住", "熬不住", "活不下去", "没意义", "没意思", "行尸走肉",
                "窒息", "喘不过气", "一片黑", "走不出来", "恨自己", "恨这个世界"],
    "T3_被动/隐匿": ["想消失", "消失", "睡着不想醒", "不想醒", "无所谓了", "随便吧", "都行",
                "麻木", "空空的", "无感", "算什么", "不麻烦别人", "一个人的时候"],
}
CRISIS_WEIGHT = {"T1_直接风险": 10, "T2_重度痛苦": 4, "T3_被动/隐匿": 1}

# 需求意图（规则命中；生产建议换分类模型）
INTENT_RULES = {
    "要被听见": ["你说", "倾听", "陪陪我", "有人在吗", "想找人说", "只想说说", "不用建议", "说出来好受"],
    "要建议":   ["怎么办", "我该", "如何", "建议", "怎么处理", "有没有办法", "帮我分析", "该不该"],
    "要分散注意力": ["陪我聊点别的", "不想聊这个", "分心", "转移", "做点什么", "聊点轻松的"],
    "要信息":   ["是什么", "正常吗", "是不是", "算不算", "严重吗", "怎么回事"],
}

# Yalom 团体治疗 11 个疗效因子（与倾诉陪伴场景相关映射起点）
YALOM_THEMES = [
    "宣泄（Catharsis）", "普遍性（Universality）", "传递信息（Imparting Information）",
    "利他（Altruism）", "希望灌注（Instillation of Hope）", "模仿行为（Imitative Behavior）",
    "人际学习-输入（Interpersonal Learning-Input）", "人际学习-输出（Interpersonal Learning-Output）",
    "团体凝聚力（Group Cohesiveness）", "存在性因子（Existential Factors）",
    "原生家庭矫正性重现（Corrective Recapitulation）",
]
TOPIC2YALOM = {
    "学业/考研": ["普遍性", "希望灌注", "传递信息"],
    "家庭/父母期待": ["原生家庭矫正性重现", "宣泄", "存在性因子"],
    "亲密关系/失恋": ["宣泄", "人际学习-输入", "团体凝聚力"],
    "人际/同辈": ["人际学习-输入", "人际学习-输出", "普遍性"],
    "情绪/抑郁焦虑": ["宣泄", "希望灌注", "团体凝聚力"],
    "自我认同/意义感": ["存在性因子", "普遍性", "希望灌注"],
    "就业/未来": ["希望灌注", "传递信息", "普遍性"],
    "危机（自伤/自杀）": ["存在性因子", "凝聚力", "希望灌注"],
}

# ---------------------------------------------------------------- 载入
def load_records(path: str):
    with open(path, "r", encoding="utf-8") as f:
        head = f.read(1); f.seek(0)
        if head == "[":
            return json.load(f)
        return [json.loads(l) for l in f if l.strip()]


def tokens(text: str):
    if _HAS_JIEBA:
        ws = [w for w in jieba.cut(text) if len(w) > 1 and w not in STOPWORDS]
    else:
        ws = re.findall(r"[\u4e00-\u9fa5]{2,4}", text)
    return ws


def get_turns(rec):
    """返回 [(role, text)]，尽量兼容 schema。"""
    turns = []
    for lk in ("conversation", "messages", "dialog", "dialogue", "turns", "history", "chat"):
        if lk in rec and isinstance(rec[lk], list):
            for it in rec[lk]:
                if isinstance(it, dict):
                    role = str(it.get("role") or it.get("from") or it.get("speaker") or "?")
                    txt = it.get("text") or it.get("content") or it.get("message") or ""
                    if isinstance(txt, str):
                        turns.append((role, txt))
                elif isinstance(it, str):
                    turns.append(("?", it))
            break  # 只取第一个命中的对话键
    if not turns:
        for k in ("text", "content", "message"):
            if isinstance(rec.get(k), str):
                turns.append(("user", rec[k]))
    return turns


def user_turns(turns):
    return [t for r, t in turns if r.lower() in ("user", "human", "student", "作者", "我", "?")]


# ---------------------------------------------------------------- Stage 1
def stage1_stats(records):
    n = len(records)
    turns_dist, char_user, char_asst = [], [], []
    for rec in records:
        ts = get_turns(rec)
        turns_dist.append(len(ts))
        us = user_turns(ts)
        char_user.append(sum(len(x) for x in us))
        char_asst.append(sum(len(t) for r, t in ts if r.lower() in ("assistant", "ai", "bot", "助手", "reply")))
    def desc(xs):
        if not xs: return {}
        xs2 = sorted(xs)
        return {"min": xs2[0], "p50": xs2[len(xs2)//2], "p90": xs2[int(len(xs2)*0.9)],
                "max": xs2[-1], "mean": round(sum(xs)/len(xs), 1)}
    return {"records": n, "turns_per_record": desc(turns_dist),
            "user_chars": desc(char_user), "assistant_chars": desc(char_asst),
            "multi_turn_ratio": round(sum(1 for t in turns_dist if t >= 4)/n, 3) if n else 0}


# ---------------------------------------------------------------- Stage 3
def polarity(text: str) -> float:
    words = tokens(text) if _HAS_JIEBA else re.findall(r"[\u4e00-\u9fa5]{1,4}", text)
    pos = neg = 0
    for i, w in enumerate(words):
        neg_prev = i > 0 and words[i-1] in NEGATORS
        if w in POS_WORDS:
            neg += 1 if neg_prev else 0
            pos += 0 if neg_prev else 1
        elif w in NEG_WORDS:
            pos += 1 if neg_prev else 0
            neg += 0 if neg_prev else 1
    tot = pos + neg
    return 0.0 if tot == 0 else (pos - neg) / tot  # -1..1


def stage3_emotion(records):
    traj = Counter()
    per_rec = []
    for rec in records:
        ps = [polarity(t) for t in user_turns(get_turns(rec))]
        if not ps:
            continue
        h = len(ps)//2
        first = sum(ps[:h])/max(1, h) if h else ps[0]
        last = sum(ps[h:])/max(1, len(ps)-h)
        delta = last - first
        label = ("明显走低(需关注)" if delta <= -0.3 else
                 "略走低" if delta <= -0.1 else
                 "明显回暖" if delta >= 0.3 else
                 "略回暖" if delta >= 0.1 else "平稳")
        traj[label] += 1
        per_rec.append({"id": rec.get("id"), "start": round(first, 2),
                        "end": round(last, 2), "delta": round(delta, 2), "label": label})
    return {"distribution": dict(traj), "per_record": per_rec[:500]}


# ---------------------------------------------------------------- Stage 4
def stage4_crisis(records):
    flags = []
    for rec in records:
        text = "\n".join(user_turns(get_turns(rec)))
        hit = {}
        score = 0
        for tier, words in CRISIS_TIERS.items():
            found = [w for w in words if w in text]
            if found:
                hit[tier] = found
                score += CRISIS_WEIGHT[tier] * len(found)
        if score >= 4:  # 触发阈值（可调）
            level = "高" if score >= 10 else "中"
            flags.append({"id": rec.get("id"), "score": score, "level": level, "hits": hit})
    flags.sort(key=lambda x: -x["score"])
    return {"flagged": len(flags), "total": len(records),
            "high": sum(1 for f in flags if f["level"] == "高"),
            "records": flags}


# ---------------------------------------------------------------- Stage 5
def stage5_disengagement(records):
    ACK = {"嗯", "哦", "好的", "好", "谢谢", "嗯嗯", "知道了", "行", "过吧", "算了", "没事"}
    short_after_long = 0
    abrupt_end = 0
    ack_runs = 0
    for rec in records:
        ts = get_turns(rec)
        if len(ts) < 3:
            continue
        # 助手长回复后用户极短回复
        for i in range(1, len(ts)):
            r_prev, t_prev = ts[i-1]
            r_cur, t_cur = ts[i]
            if r_prev.lower() in ("assistant", "ai", "bot") and len(t_prev) > 80 \
               and r_cur.lower() in ("user", "human", "?") and len(t_cur) < 6:
                short_after_long += 1
        # 用户在重度表达后突然结束
        last_role, last_txt = ts[-1]
        if last_role.lower() in ("user", "human", "?") and len(last_txt) < 8:
            abrupt_end += 1
        # 连续敷衍
        acks = sum(1 for r, t in ts if r.lower() in ("user", "human", "?") and t.strip() in ACK)
        if acks >= 2:
            ack_runs += 1
    n = len(records)
    return {"records": n,
            "short_reply_after_long_assistant": short_after_long,
            "abrupt_user_end": abrupt_end,
            "repeated_acknowledgement": ack_runs,
            "trigger_hint": "以上三处即为『呼吸放松卡片』候选触发点；建议按其分布设阈值而非定时弹。"}


# ---------------------------------------------------------------- Stage 6
def stage6_intent(records):
    dist = Counter()
    for rec in records:
        text = "\n".join(user_turns(get_turns(rec)))
        best, best_n = "未分类", 0
        for intent, kws in INTENT_RULES.items():
            n = sum(1 for k in kws if k in text)
            if n > best_n:
                best, best_n = intent, n
        dist[best] += 1
    return dict(dist)


# ---------------------------------------------------------------- Stage 2
def stage2_topics(records, k=8):
    docs, ids = [], []
    for rec in records:
        txt = " ".join(user_turns(get_turns(rec)))
        if txt.strip():
            docs.append(txt); ids.append(rec.get("id"))
    if not docs:
        return {"degraded": True, "reason": "无有效文本", "topics": []}
    if not _HAS_SK:
        # 降级：高频词 + 简单共现
        wc = Counter()
        for d in docs:
            wc.update(tokens(d))
        return {"degraded": True, "reason": "未安装 scikit-learn", "top_words": wc.most_common(60), "topics": []}
    vec = TfidfVectorizer(tokenizer=tokens if _HAS_JIEBA else None,
                          token_pattern=None if _HAS_JIEBA else r"[\u4e00-\u9fa5]{2,4}",
                          max_features=4000, min_df=3)
    X = vec.fit_transform(docs)
    k = min(k, max(2, len(docs)//10))
    km = KMeans(n_clusters=k, n_init=10, random_state=42).fit(X)
    terms = vec.get_feature_names_out()
    topics = []
    for ci in range(k):
        center = km.cluster_centers_[ci]
        top = center.argsort()[::-1][:12]
        words = [terms[i] for i in top]
        members = [ids[i] for i in range(len(ids)) if km.labels_[i] == ci]
        topics.append({"cluster": ci, "size": len(members), "keywords": words,
                       "sample_ids": members[:8]})
    try:
        sil = float(silhouette_score(X, km.labels_, sample_size=min(1000, X.shape[0])))
    except Exception:
        sil = None
    return {"degraded": False, "k": k, "silhouette": sil, "topics": topics}


# ---------------------------------------------------------------- Stage 7
def stage7_demographics(records):
    dims = defaultdict(Counter)
    for rec in records:
        meta = None
        for mk in ("metadata", "meta", "profile", "user_info", "info"):
            if isinstance(rec.get(mk), dict):
                meta = rec[mk]; break
        if not meta:
            continue
        for key in ("grade", "major", "gender", "province", "college"):
            if key in meta:
                dims[key][meta[key]] += 1
    return {k: dict(v) for k, v in dims.items()} or {"note": "语料未提供元数据，跳过人群差异分析"}


# ---------------------------------------------------------------- Stage 8 / 9
def stage8_eval_set(records, crisis, emotion, n=60):
    """挑多样性样本做 Agent 回归评估集。"""
    by_id = {r.get("id"): r for r in records}
    picked = []
    # 高危全收（截断）
    for f in crisis["records"][:20]:
        if f["id"] in by_id:
            picked.append({**f, "tag": "crisis"})
    # 情绪走低样本
    low = [p for p in emotion["per_record"] if p["label"] in ("明显走低(需关注)", "略走低")][:20]
    picked += [{**p, "tag": "emotion_decline"} for p in low]
    # 平稳样本作对照
    stable = [p for p in emotion["per_record"] if p["label"] == "平稳"][:20]
    picked += [{**p, "tag": "baseline"} for p in stable]
    return picked[:n]


def stage9_yalom(topics, intent):
    lines = ["# 话题 → Yalom 主题 → Yalom.md 写入建议", ""]
    def match(topic_words, kw):
        return not kw or any(k in " ".join(topic_words) for k in kw.split("/"))
    for t in topics.get("topics", []):
        kw = " ".join(t["keywords"])
        theme = None
        for name, y in TOPIC2YALOM.items():
            if match(t["keywords"], name):
                theme, yaloms = name, y; break
        if not theme:
            theme, yaloms = "（待人工归并）", ["普遍性", "宣泄"]
        lines.append(f"## 话题簇 {t['cluster']}（{t['size']} 条）")
        lines.append(f"- 关键词：{'、'.join(t['keywords'][:8])}")
        lines.append(f"- 建议对应 Yalom 因子：{', '.join(yaloms)}")
        lines.append(f"- Yalom.md 建议追加：以『{theme}』为场景的 3 条陪聊话术（呼应 {yaloms[0]}）+ 1 条常见误区")
        lines.append("")
    lines.append("## 需求意图 → 回复策略")
    for k, v in intent.items():
        lines.append(f"- {k}: 命中 {v} 条 —— 策略见分析方案『意图-策略矩阵』")
    return "\n".join(lines)


# ---------------------------------------------------------------- 主流程
def main(input_path, outdir):
    os.makedirs(outdir, exist_ok=True)
    records = load_records(input_path)

    s1 = stage1_stats(records)
    s2 = stage2_topics(records)
    s3 = stage3_emotion(records)
    s4 = stage4_crisis(records)
    s5 = stage5_disengagement(records)
    s6 = stage6_intent(records)
    s7 = stage7_demographics(records)
    s8 = stage8_eval_set(records, s4, s3)
    s9 = stage9_yalom(s2, s6)

    summary = {"dependency": {"jieba": _HAS_JIEBA, "scikit_learn": _HAS_SK},
               "stage1_basic": s1, "stage2_topics_overview": {k: v for k, v in s2.items() if k != "topics"},
               "stage3_emotion": s3["distribution"], "stage4_crisis": {k: v for k, v in s4.items() if k != "records"},
               "stage5_disengagement": s5, "stage6_intent": s6, "stage7_demographics": s7}
    _dump(os.path.join(outdir, "summary.json"), summary)
    _dump(os.path.join(outdir, "topics.json"), s2)
    _dump(os.path.join(outdir, "disengagement.json"), s5)
    _dump(os.path.join(outdir, "intent.json"), s6)
    with open(os.path.join(outdir, "risk_flags.jsonl"), "w", encoding="utf-8") as f:
        for r in s4["records"]:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(os.path.join(outdir, "eval_set.jsonl"), "w", encoding="utf-8") as f:
        for r in s8:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(os.path.join(outdir, "yalom_alignment.md"), "w", encoding="utf-8") as f:
        f.write(s9)

    report = _render_report(s1, s2, s3, s4, s5, s6, s7, s8, summary["dependency"])
    with open(os.path.join(outdir, "report.md"), "w", encoding="utf-8") as f:
        f.write(report)
    print(report)
    print(f"\n输出目录: {os.path.abspath(outdir)}")


def _dump(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def _render_report(s1, s2, s3, s4, s5, s6, s7, s8, dep):
    L = []
    L.append("# 树洞语料分析报告（自动生成）\n")
    L.append(f"> 依赖状态：jieba={dep['jieba']}，scikit-learn={dep['scikit_learn']}"
             + ("（话题聚类降级为词频）" if not dep["scikit_learn"] else "") + "\n")
    L.append("## 1. 基础统计")
    L.append(f"- 记录数：**{s1['records']}**，多轮对话(≥4轮)占比：**{s1['multi_turn_ratio']}**")
    for k in ("turns_per_record", "user_chars", "assistant_chars"):
        L.append(f"- {k}: {s1[k]}")
    L.append("\n## 2. 话题聚类")
    if s2.get("degraded"):
        L.append(f"- ⚠️ 降级（{s2.get('reason')}）；Top 词：{s2.get('top_words', [])[:25]}")
    else:
        L.append(f"- k={s2['k']}，轮廓系数={s2['silhouette']}")
        for t in s2["topics"]:
            L.append(f"  - 簇{t['cluster']}（{t['size']}条）：{'、'.join(t['keywords'][:8])}")
    L.append("\n## 3. 情绪轨迹")
    for k, v in s3["distribution"].items():
        L.append(f"- {k}: {v}")
    L.append("\n## 4. 危机语言标记（⭐ 最高优先级）")
    L.append(f"- 命中记录：**{s4['flagged']} / {s4['total']}**，其中高危 **{s4['high']}** 条 → 详见 risk_flags.jsonl")
    L.append("\n## 5. 离场/沉默节点（→ 呼吸卡片触发）")
    for k, v in s5.items():
        L.append(f"- {k}: {v}")
    L.append("\n## 6. 需求意图")
    for k, v in s6.items():
        L.append(f"- {k}: {v}")
    L.append("\n## 7. 人群差异")
    L.append(f"- {s7}")
    L.append(f"\n## 8. 评估集\n- 已生成 {len(s8)} 条脱敏样本 → eval_set.jsonl（tags: crisis/emotion_decline/baseline）")
    return "\n".join(L)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="树洞语料分析流水线")
    ap.add_argument("--input", required=True, help="已脱敏语料 .json/.jsonl")
    ap.add_argument("--outdir", default="analysis", help="输出目录")
    a = ap.parse_args()
    main(a.input, a.outdir)
