#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deidentify.py —— 树洞信箱 · 学生倾诉语料脱敏流水线
====================================================================
设计原则（重要）
  1. 绝不修改原始文件：只读 input，只写 output 目录。
  2. 可复现：同一 salt + 同一输入 => 同一输出（保证跨文件同一称呼映射一致）。
  3. 可审计：每个类别替换了多少次、抽样明细全部落盘 audit.json。
  4. 最小依赖：核心只用标准库（零依赖即可跑）；jieba 为可选增强（中文姓名识别）。

处理顺序（顺序敏感，勿随意调整）
  规则正则脱敏 -> 日期/地址泛化 -> 中文姓名启发式 -> 假名化(salt)
  手机号/身份证/银行卡彼此会重叠，必须"特异性优先"：
    先替换 11 位手机号，再替换 15/18 位身份证，最后剩下的长数字串才是银行卡。
    替换后的占位符不含数字，天然阻断后续正则误匹配。

用法
  python deidentify.py --input corpus.json  --outdir out
  python deidentify.py --input corpus.jsonl --outdir out --salt my_secret
  python deidentify.py --demo                 # 自检：生成合成数据并跑通
输出
  out/deidentified.json / .jsonl   脱敏后语料（保持输入格式）
  out/audit.json                   各类别替换计数 + 抽样明细 + 高风险记录清单
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
from collections import Counter, defaultdict

# ----------------------------------------------------------------------------
# 0. 配置
# ----------------------------------------------------------------------------
DEFAULT_SALT = os.environ.get("TREEHOLE_SALT", "TREEHOLE_SALT_CHANGE_ME_v1")

# 各字段在记录中的候选键名（兼容多种 schema）
TEXT_KEYS = ("text", "content", "message", "msg", "utterance", "sentence")
LIST_KEYS = ("conversation", "messages", "dialog", "dialogue", "turns", "history", "chat")
META_KEYS = ("metadata", "meta", "profile", "user_info", "userinfo", "info")

# 可能携带 PII 的元数据字段（直接整字段打码 / 泛化）
META_PII_FIELDS = {
    "name": "<NAME>", "username": "<NAME>", "real_name": "<NAME>", "realname": "<NAME>",
    "nickname": "<NICK>", "nick": "<NICK>",
    "phone": "<PHONE>", "mobile": "<PHONE>", "tel": "<PHONE>",
    "id_card": "<IDCARD>", "idcard": "<IDCARD>", "id_number": "<IDCARD>",
    "email": "<EMAIL>", "mail": "<EMAIL>",
    "student_id": "<STUDENT_ID>", "student_no": "<STUDENT_ID>", "sno": "<STUDENT_ID>",
    "qq": "<QQ>", "wechat": "<WECHAT>", "weixin": "<WECHAT>",
    "address": "<ADDRESS>", "addr": "<ADDRESS>", "home": "<ADDRESS>",
    "school": "<SCHOOL>", "college": "<SCHOOL>", "university": "<SCHOOL>",
    "class": "<CLASS>", "dorm": "<DORM>", "room": "<DORM>",
    "bank_card": "<BANKCARD>", "bankcard": "<BANKCARD>",
}

# ----------------------------------------------------------------------------
# 1. 正则规则（特异性优先）
# ----------------------------------------------------------------------------
REGEX_RULES: list[tuple[str, str, str]] = [
    # name, pattern, placeholder
    ("phone",      r"(?<![\d])(?:\+?86[-\s]?)?1[3-9]\d{9}(?![\d])", "<PHONE>"),
    ("idcard",     r"(?<![\d])\d{17}[\dXx](?![\d])",                "<IDCARD>"),
    ("idcard15",   r"(?<![\d])\d{15}(?![\d])",                      "<IDCARD>"),
    ("email",      r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", "<EMAIL>"),
    ("bankcard",   r"(?<![\d])(?:\d[ \-]?){15,19}(?![\d])",         "<BANKCARD>"),
    ("url",        r"https?://[^\s，。；）)】\"]+|www\.[^\s，。；）)】\"]+", "<URL>"),
    ("ip",         r"(?<![\d])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d])", "<IP>"),
    ("wechat_id",  r"(?:微信号?|vx|VX|V信|weixin|WeChat)\s*(?:号|是|为)?\s*[:：]?\s*[A-Za-z][A-Za-z0-9_\-]{5,19}", "<WECHAT>"),
    ("qq_number",  r"(?:QQ|qq|Q号|扣扣)\s*[:：]?\s*[1-9]\d{4,11}",   "<QQ>"),
    ("student_id", r"(?:学号|工号|学籍号|准考证号)\s*[:：]?\s*\d{4,16}", "<STUDENT_ID>"),
    ("exam_score", r"(?:身份证号|身份证)\s*[:：]?\s*\d{15,18}[\dXx]?", "<IDCARD>"),
]
# 说明：qq 裸数字（无关键字前缀）风险高（易误伤年份/金额），默认不脱；如语料确认，可加：
#   ("qq_bare", r"(?<![\d])[1-9]\d{5,10}(?![\d])", "<QQ>")   # ← 谨慎启用
REGEX_COMPILED = [(n, re.compile(p), ph) for n, p, ph in REGEX_RULES]

# ----------------------------------------------------------------------------
# 2. 日期 / 年龄 / 地址 泛化（降低间接可识别性）
# ----------------------------------------------------------------------------
DATE_PATTERNS = [
    (re.compile(r"(?<!\d)(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?"), r"\1年\2月"),   # 精确到"月"，抹掉"日"
    (re.compile(r"(?<!\d)(\d{1,2})[-/月](\d{1,2})日"),              r"<DATE>"),      # 无年份的月日
]
# 年龄泛化到 5 岁区间，如 20岁 -> 20-24岁（幂等：避免对"20-24岁"二次处理）
AGE_BUCKET = re.compile(r"(?<![\d\-])(\d{2})\s*(岁|周岁)")

# 省级行政区（保留到省，抹掉市县）——常用集合，可自行扩充
PROV_FULL = {
    "北京": "北京市", "天津": "天津市", "上海": "上海市", "重庆": "重庆市",
    "内蒙古": "内蒙古自治区", "广西": "广西壮族自治区", "西藏": "西藏自治区",
    "宁夏": "宁夏回族自治区", "新疆": "新疆维吾尔自治区",
    "香港": "香港", "澳门": "澳门", "台湾": "台湾",
}
for _p in ["河北", "山西", "辽宁", "吉林", "黑龙江", "江苏", "浙江", "安徽", "福建", "江西",
           "山东", "河南", "湖北", "湖南", "广东", "海南", "四川", "贵州", "云南", "陕西",
           "甘肃", "青海"]:
    PROV_FULL.setdefault(_p, _p + "省")
PROVINCE_RE = re.compile("|".join(sorted(PROV_FULL, key=len, reverse=True)) + "(?:省|市|自治区|特别行政区)?")

# 市级 -> 省级 映射（示例集，生产请扩充到全量地级市）
CITY_TO_PROV = {
    "南通": "江苏", "南京": "江苏", "苏州": "江苏", "无锡": "江苏", "徐州": "江苏",
    "常州": "江苏", "扬州": "江苏", "镇江": "江苏", "盐城": "江苏", "泰州": "江苏",
    "杭州": "浙江", "宁波": "浙江", "温州": "浙江", "嘉兴": "浙江", "金华": "浙江",
    "广州": "广东", "深圳": "广东", "珠海": "广东", "佛山": "广东", "东莞": "广东",
    "武汉": "湖北", "成都": "四川", "绵阳": "四川", "西安": "陕西", "长沙": "湖南",
    "郑州": "河南", "济南": "山东", "青岛": "山东", "烟台": "山东", "福州": "福建",
    "厦门": "福建", "合肥": "安徽", "南昌": "江西", "昆明": "云南", "贵阳": "贵州",
    "石家庄": "河北", "沈阳": "辽宁", "大连": "辽宁", "长春": "吉林", "哈尔滨": "黑龙江",
    "兰州": "甘肃", "太原": "山西", "南宁": "广西", "海口": "海南", "天津": "天津",
}
CITY_RE = re.compile("|".join(sorted(CITY_TO_PROV, key=len, reverse=True)))

# ----------------------------------------------------------------------------
# 3. 中文姓名启发式（默认保守，可选 jieba 增强）
# ----------------------------------------------------------------------------
SURNAMES = set(
    "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻"
    "柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤"
    "滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄"
    "米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭"
    "梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯咎管卢莫经房裘缪干解应宗丁宣邓郁"
    "单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊甄封芮储靳汲邴糜松井段富巫乌焦巴弓牧"
    "隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭历戎祖武符刘景詹束龙叶幸司韶郜"
    "黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申"
    "扶堵冉宰郦雍却璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾"
    "鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩"
    "厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益"
    "桓公"
)
# 高频名用字（用于"姓+1~2字"候选）
COMMON_NAME_CHARS = set(
    "伟芳娜秀英敏静丽强磊军洋勇艳杰娟涛明超秀霞平刚桂香文华建国志强"
    "宇轩浩然梓涵欣怡雨泽佳琪一诺子墨思远若曦嘉懿晨曦沐阳"
    "婷璐妍彤悦舒雅琪瑶岚琛琦研怡宁宁萱冉"
)
# 语境触发词：紧跟在后的 2~3 个中文字更可能是姓名
NAME_CUES = re.compile(
    r"(?:我叫|我是|名字叫|叫做|姓|姓名[:：]?\s*|称呼我|叫我|人称)\s*([\u4e00-\u9fa5]{2,3})"
)
NAME_WITH_TITLE = re.compile(r"([\u4e00-\u9fa5])([\u4e00-\u9fa5])?(?=(?:老师|同学|教授|医生|阿姨|叔叔|辅导员))")

_JIEBA = None
def _load_jieba():
    global _JIEBA
    if _JIEBA is None:
        try:
            import jieba  # type: ignore
            for s in SURNAMES:
                jieba.add_word(s + "某")
            _JIEBA = jieba
        except Exception:
            _JIEBA = False
    return _JIEBA

# ----------------------------------------------------------------------------
# 4. 假名化（salt 哈希 -> 稳定短 token，保留共指但不可逆）
# ----------------------------------------------------------------------------
def _token(value: str, salt: str, prefix: str, length: int = 6) -> str:
    h = hashlib.sha256((salt + "||" + value).encode("utf-8")).hexdigest()[:length]
    return f"<{prefix}_{h}>"

# ----------------------------------------------------------------------------
# 5. 核心：单段文本脱敏
# ----------------------------------------------------------------------------
# 学校/机构名：需要"函数词守卫"，否则会把"在南通大学"整段吞掉
SCHOOL_SUFFIX = re.compile(r"([\u4e00-\u9fa5]{2,8}?)(大学|学院|职业技术学院|学校)")
FUNC_WORDS = set("在了的是去到上这那个所好每本我你他她它们和与或")


def redact_schools(text: str, stats: Counter) -> str:
    out = text
    for m in list(SCHOOL_SUFFIX.finditer(text)):
        name = m.group(1)
        while name and name[0] in FUNC_WORDS:
            name = name[1:]
        if len(name) >= 2:
            full = name + m.group(2)
            if full in out:
                out = out.replace(full, "<SCHOOL>", 1)
                stats["school"] += 1
    return out


def generalize_places(text: str, stats: Counter) -> str:
    # (1) 保留到省：把"江苏/江苏省/内蒙古自治区"等归一化
    def _prov(m):
        s = m.group(0)
        for k in sorted(PROV_FULL, key=len, reverse=True):
            if s.startswith(k):
                return PROV_FULL[k]
        return s
    if PROVINCE_RE.search(text):
        text = PROVINCE_RE.sub(_prov, text)
        stats["region_generalized"] += 1
    # (2) 市级 -> 省级；若前文已出现该省，则直接删除市名，避免"江苏省江苏省"
    def _city(m):
        city = m.group(0)
        prov = CITY_TO_PROV[city]
        prev = text[max(0, m.start() - 6):m.start()]
        if prov in prev:
            stats["city_removed"] += 1
            return ""
        stats["city_generalized"] += 1
        return PROV_FULL.get(prov, prov + "省")
    return CITY_RE.sub(_city, text)


def deid_text(text: str, salt: str, stats: Counter, samples: dict) -> str:
    if not isinstance(text, str):
        return text

    # 5.1 规则正则
    for name, pat, ph in REGEX_COMPILED:
        def _repl(m, _name=name, _ph=ph):
            stats[_name] += 1
            samples.setdefault(_name, [])
            if len(samples[_name]) < 5:
                samples[_name].append(_mask_sample(m.group(0)))
            return _ph
        text = pat.sub(_repl, text)

    # 5.2 学校/机构名
    text = redact_schools(text, stats)

    # 5.3 日期泛化（只留年/月）
    for pat, rep in DATE_PATTERNS:
        text, n = pat.subn(rep, text)
        if n:
            stats["date_generalized"] += n

    # 5.4 年龄泛化到 5 岁区间（幂等：已分桶的不再二次处理）
    def _age(m):
        a = int(m.group(1))
        lo = (a // 5) * 5
        stats["age_generalized"] += 1
        return f"{lo}-{lo + 4}岁"
    text = AGE_BUCKET.sub(_age, text)

    # 5.5 地址：保留到省，抹掉市县
    text = generalize_places(text, stats)

    # 5.5 姓名启发式（保守：仅语境触发 + 姓名字符）
    def _name_cue(m):
        cand = m.group(1)
        if cand and cand[0] in SURNAMES:
            stats["name_heuristic"] += 1
            samples.setdefault("name_heuristic", [])
            if len(samples["name_heuristic"]) < 5:
                samples["name_heuristic"].append(cand)
            return m.group(0).replace(cand, _token(cand, salt, "NAME"))
        return m.group(0)
    text = NAME_CUES.sub(_name_cue, text)

    # 5.6 jieba 增强（可选）：识别"姓+名"连续词
    jb = _load_jieba()
    if jb:
        out = []
        for tok in jb.cut(text):
            if len(tok) in (2, 3) and tok[0] in SURNAMES and all(c in COMMON_NAME_CHARS or c in SURNAMES for c in tok[1:]):
                stats["name_jieba"] += 1
                out.append(_token(tok, salt, "NAME"))
            else:
                out.append(tok)
        text = "".join(out)

    return text


def _mask_sample(s: str) -> str:
    """审计里展示时也做部分遮蔽，避免审计文件本身成为泄露源。"""
    if len(s) <= 4:
        return s[0] + "*" * (len(s) - 1) if len(s) > 1 else "*"
    return s[:3] + "*" * (len(s) - 4) + s[-1:]

# ----------------------------------------------------------------------------
# 6. 记录级处理（自动识别 schema）
# ----------------------------------------------------------------------------
def _walk_conversation(conv, salt, stats, samples, path="conv"):
    """递归处理对话列表；支持 [{role,text}] 或 [[q,a]] 或纯字符串列表。"""
    high_risk = 0
    if isinstance(conv, list):
        for i, item in enumerate(conv):
            if isinstance(item, dict):
                key = next((k for k in TEXT_KEYS if k in item), None)
                if key:
                    before = stats_total(stats)
                    item[key] = deid_text(item[key], salt, stats, samples)
                    if stats_total(stats) > before:
                        high_risk += 1
                # 嵌套 messages
                for lk in LIST_KEYS:
                    if lk in item and isinstance(item[lk], list):
                        high_risk += _walk_conversation(item[lk], salt, stats, samples, f"{path}[{i}].{lk}")
            elif isinstance(item, list):
                for j, sub in enumerate(item):
                    if isinstance(sub, str):
                        item[j] = deid_text(sub, salt, stats, samples)
            elif isinstance(item, str):
                conv[i] = deid_text(item, salt, stats, samples)
    return high_risk


def stats_total(stats: Counter) -> int:
    return sum(stats.values())


def deid_record(rec, salt, stats, samples):
    hits = 0
    if not isinstance(rec, dict):
        return rec, 0
    # 对话体
    for lk in LIST_KEYS:
        if lk in rec:
            hits += _walk_conversation(rec[lk], salt, stats, samples, lk)
    # 直接文本字段
    for k in TEXT_KEYS:
        if k in rec and isinstance(rec[k], str):
            before = stats_total(stats)
            rec[k] = deid_text(rec[k], salt, stats, samples)
            if stats_total(stats) > before:
                hits += 1
    # 元数据字段
    for mk in META_KEYS:
        meta = rec.get(mk)
        if isinstance(meta, dict):
            for k, v in list(meta.items()):
                lk = k.lower()
                if lk in META_PII_FIELDS:
                    stats["meta_" + lk] += 1
                    meta[k] = META_PII_FIELDS[lk]
                elif isinstance(v, str):
                    before = stats_total(stats)
                    meta[k] = deid_text(v, salt, stats, samples)
                    if stats_total(stats) > before:
                        hits += 1
    return rec, hits

# ----------------------------------------------------------------------------
# 7. 载入 / 写出
# ----------------------------------------------------------------------------
def load_records(path: str):
    with open(path, "r", encoding="utf-8") as f:
        head = f.read(1)
        f.seek(0)
        if head == "[":
            return json.load(f), "json"
        # JSONL
        return [json.loads(line) for line in f if line.strip()], "jsonl"


def save_records(path: str, records, fmt: str):
    with open(path, "w", encoding="utf-8") as f:
        if fmt == "json":
            json.dump(records, f, ensure_ascii=False, indent=2)
        else:
            for r in records:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

# ----------------------------------------------------------------------------
# 8. 主流程
# ----------------------------------------------------------------------------
def run(input_path: str, outdir: str, salt: str, fmt_hint: str | None = None):
    os.makedirs(outdir, exist_ok=True)
    records, fmt = load_records(input_path)
    if fmt_hint:
        fmt = fmt_hint
    stats = Counter()
    samples: dict = {}
    high_risk = []
    for idx, rec in enumerate(records):
        _, hits = deid_record(rec, salt, stats, samples)
        if hits >= 3:
            high_risk.append(rec.get("id", idx))

    # 写出脱敏语料
    shard = os.path.join(outdir, f"deidentified.{fmt}")
    save_records(shard, records, fmt)

    # 审计报告
    audit = {
        "input": os.path.abspath(input_path),
        "records": len(records),
        "format": fmt,
        "salt_fingerprint": hashlib.sha256(salt.encode()).hexdigest()[:12],
        "replacement_counts": dict(stats.most_common()),
        "samples_masked": {k: v for k, v in samples.items()},
        "high_pii_density_records": high_risk[:200],
        "note": "审计文件同样只含遮蔽样本，不保留任何原始 PII；请勿将本文件与原始语料同目录公开。",
    }
    with open(os.path.join(outdir, "audit.json"), "w", encoding="utf-8") as f:
        json.dump(audit, f, ensure_ascii=False, indent=2)

    print("=== 脱敏完成 ===")
    print(f"记录数: {len(records)}  格式: {fmt}")
    print(f"替换统计: {dict(stats.most_common())}")
    print(f"高 PII 密度记录(建议人工复核): {len(high_risk)} 条")
    print(f"输出: {shard}  +  {os.path.join(outdir, 'audit.json')}")
    return audit


# ----------------------------------------------------------------------------
# 9. 自检 demo（合成含 PII 数据，验证流水线可跑通）
# ----------------------------------------------------------------------------
DEMO = [
    {"id": "u1", "conversation": [
        {"role": "user", "text": "老师您好，我叫李明，今年20岁，在南通大学读书。我最近很累，不知道怎么办。我的手机138xxxx5678。"},
        {"role": "assistant", "text": "我在。你愿意说说最近发生了什么吗？"},
        {"role": "user", "text": "我从江苏南通来的，家里都指望我考研。我微信是 lmx1999，可以加你吗？"},
    ], "metadata": {"name": "李明", "student_id": "2021012345", "phone": "138xxxx5678", "school": "南通大学"}},
    {"id": "u2", "conversation": [
        {"role": "user", "text": "我是王芳，2021年3月15日开始失眠，最近总想消失，觉得活着没意思。"},
        {"role": "assistant", "text": "谢谢你告诉我这些。你现在安全吗？"},
    ], "metadata": {"name": "王芳", "email": "wangfang@stu.ntu.edu.cn"}},
]


def demo():
    here = os.path.dirname(os.path.abspath(__file__))
    demo_dir = os.path.join(here, "demo")
    os.makedirs(demo_dir, exist_ok=True)
    inp = os.path.join(demo_dir, "sample_corpus.json")
    with open(inp, "w", encoding="utf-8") as f:
        json.dump(DEMO, f, ensure_ascii=False, indent=2)
    run(inp, os.path.join(demo_dir, "out"), DEFAULT_SALT, fmt_hint="json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="树洞语料脱敏流水线")
    ap.add_argument("--input", help="输入语料 .json 或 .jsonl")
    ap.add_argument("--outdir", default="out", help="输出目录")
    ap.add_argument("--salt", default=DEFAULT_SALT, help="假名化盐值（跨批次保持一致）")
    ap.add_argument("--demo", action="store_true", help="运行合成数据自检")
    args = ap.parse_args()
    if args.demo:
        demo()
    elif args.input:
        run(args.input, args.outdir, args.salt)
    else:
        ap.print_help()
