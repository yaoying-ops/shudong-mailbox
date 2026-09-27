# -*- coding: utf-8 -*-
"""把候选 oklch 配色转成 hex，并做 WCAG 对比度校验。仅用标准库。"""
import math, json

def oklch_to_hex(L, C, H):
    h = math.radians(H)
    a = C * math.cos(h)
    b = C * math.sin(h)
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    B = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    out = []
    for v in (R, G, B):
        v = max(0.0, min(1.0, v))
        if v <= 0.0031308:
            v12 = 12.92 * v
        else:
            v12 = 1.055 * (v ** (1 / 2.4)) - 0.055
        out.append(int(round(max(0, min(1, v12)) * 255)))
    return "#{:02X}{:02X}{:02X}".format(*out)

def lum(L, C, H):
    h = math.radians(H)
    a, b = C * math.cos(h), C * math.sin(h)
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    B = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    f = lambda v: v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, bb = f(max(0, min(1, R))), f(max(0, min(1, G))), f(max(0, min(1, B)))
    return 0.2126 * r + 0.7152 * g + 0.0722 * bb

def ratio(fg, bg):
    a, b = lum(*fg), lum(*bg)
    hi, lo = max(a, b), min(a, b)
    return round((hi + 0.05) / (lo + 0.05), 2)

SCHEMES = {
    "sage": {
        "name": "苔痕 Sage",
        "colors": {
            "bg": (.955, .008, 88), "surface": (.991, .004, 90), "chrome": (.973, .006, 88),
            "fg": (.28, .012, 65), "muted": (.52, .016, 72),
            "border": (.903, .012, 86), "border-strong": (.832, .018, 84),
            "accent": (.520, .055, 152), "accent-hover": (.455, .055, 152),
            "accent-soft": (.932, .024, 152), "accent-ink": (.385, .050, 152), "accent-line": (.762, .032, 152),
            "accent2": (.545, .040, 118),
            "warn": (.600, .075, 55), "danger": (.520, .120, 22), "progress": (.580, .100, 78),
        }
    },
    "teal": {
        "name": "青霭 Teal",
        "colors": {
            "bg": (.958, .008, 220), "surface": (.992, .003, 230), "chrome": (.976, .006, 225),
            "fg": (.272, .014, 250), "muted": (.522, .018, 245),
            "border": (.905, .012, 230), "border-strong": (.840, .016, 230),
            "accent": (.520, .048, 192), "accent-hover": (.455, .048, 192),
            "accent-soft": (.930, .022, 192), "accent-ink": (.385, .045, 192), "accent-line": (.780, .028, 192),
            "accent2": (.545, .042, 232),
            "warn": (.620, .070, 60), "danger": (.530, .120, 25), "progress": (.555, .062, 200),
        }
    },
    "mauve": {
        "name": "藕荷 Mauve",
        "colors": {
            "bg": (.956, .008, 18), "surface": (.991, .004, 20), "chrome": (.974, .006, 18),
            "fg": (.288, .014, 340), "muted": (.528, .018, 340),
            "border": (.906, .012, 20), "border-strong": (.838, .016, 20),
            "accent": (.552, .050, 320), "accent-hover": (.488, .050, 320),
            "accent-soft": (.935, .022, 320), "accent-ink": (.402, .045, 320), "accent-line": (.800, .028, 320),
            "accent2": (.552, .040, 150),
            "warn": (.605, .070, 55), "danger": (.522, .110, 20), "progress": (.580, .080, 330),
        }
    },
    "ink": {
        "name": "宣纸 Ink",
        "colors": {
            "bg": (.962, .004, 95), "surface": (.995, .002, 95), "chrome": (.978, .004, 95),
            "fg": (.262, .008, 80), "muted": (.505, .010, 80),
            "border": (.906, .008, 95), "border-strong": (.838, .012, 95),
            "accent": (.485, .070, 45), "accent-hover": (.420, .070, 45),
            "accent-soft": (.940, .022, 48), "accent-ink": (.365, .060, 45), "accent-line": (.805, .035, 48),
            "accent2": (.490, .040, 210),
            "warn": (.620, .070, 65), "danger": (.505, .110, 25), "progress": (.550, .060, 120),
        }
    },
    "sand": {
        "name": "暖砂 Sand",
        "colors": {
            "bg": (.954, .010, 78), "surface": (.991, .005, 80), "chrome": (.972, .007, 78),
            "fg": (.285, .014, 70), "muted": (.525, .017, 72),
            "border": (.902, .013, 78), "border-strong": (.830, .019, 76),
            "accent": (.525, .045, 118), "accent-hover": (.458, .045, 118),
            "accent-soft": (.933, .023, 118), "accent-ink": (.390, .042, 118), "accent-line": (.775, .030, 118),
            "accent2": (.570, .050, 60),
            "warn": (.605, .070, 58), "danger": (.525, .115, 22), "progress": (.585, .085, 90),
        }
    },
}

MOODS = {
    "hope": (.720, .055, 112), "warm": (.700, .055, 62), "calm": (.670, .042, 232),
    "tired": (.680, .035, 86), "anxious": (.600, .070, 46), "low": (.600, .045, 300),
    "breakdown": (.550, .060, 26), "numb": (.580, .035, 330),
}

SERIOUS = {
 "graphite": {
  "name": "石墨", "group": "serious",
  "colors": {
   "bg": (.958, .003, 250), "surface": (.994, .001, 250), "chrome": (.976, .002, 250),
   "fg": (.245, .008, 260), "muted": (.495, .010, 260),
   "border": (.900, .006, 255), "border-strong": (.828, .008, 255),
   "accent": (.420, .028, 250), "accent-hover": (.360, .028, 250),
   "accent-soft": (.935, .012, 250), "accent-ink": (.300, .025, 250), "accent-line": (.760, .018, 250),
   "accent2": (.470, .020, 200),
   "warn": (.580, .060, 70), "danger": (.480, .100, 25), "progress": (.520, .050, 240),
  }},
 "indigo": {
  "name": "学府靛", "group": "serious",
  "colors": {
   "bg": (.955, .006, 260), "surface": (.992, .003, 265), "chrome": (.972, .005, 262),
   "fg": (.250, .022, 265), "muted": (.495, .020, 265),
   "border": (.898, .010, 262), "border-strong": (.825, .014, 262),
   "accent": (.400, .058, 265), "accent-hover": (.345, .058, 265),
   "accent-soft": (.930, .022, 265), "accent-ink": (.290, .050, 265), "accent-line": (.745, .035, 265),
   "accent2": (.500, .040, 230),
   "warn": (.600, .065, 65), "danger": (.485, .110, 25), "progress": (.500, .070, 265),
  }},
 "pine": {
  "name": "深松", "group": "serious",
  "colors": {
   "bg": (.956, .005, 150), "surface": (.993, .003, 150), "chrome": (.974, .004, 150),
   "fg": (.248, .014, 155), "muted": (.492, .014, 155),
   "border": (.898, .008, 150), "border-strong": (.826, .012, 150),
   "accent": (.400, .045, 158), "accent-hover": (.345, .045, 158),
   "accent-soft": (.930, .018, 158), "accent-ink": (.292, .040, 158), "accent-line": (.750, .028, 158),
   "accent2": (.470, .030, 200),
   "warn": (.590, .065, 62), "danger": (.480, .105, 25), "progress": (.510, .055, 158),
  }},
 "slate": {
  "name": "铅青", "group": "serious",
  "colors": {
   "bg": (.957, .006, 230), "surface": (.993, .003, 232), "chrome": (.975, .005, 230),
   "fg": (.246, .014, 235), "muted": (.490, .014, 235),
   "border": (.899, .009, 232), "border-strong": (.828, .013, 232),
   "accent": (.415, .035, 232), "accent-hover": (.358, .035, 232),
   "accent-soft": (.932, .014, 232), "accent-ink": (.300, .030, 232), "accent-line": (.755, .022, 232),
   "accent2": (.480, .025, 195),
   "warn": (.595, .062, 65), "danger": (.482, .105, 25), "progress": (.515, .055, 235),
  }},
}

ALL = dict(SCHEMES)
ALL.update(SERIOUS)

out = {}
for k, s in ALL.items():
    hexes = {n: oklch_to_hex(*v) for n, v in s["colors"].items()}
    c = s["colors"]
    out[k] = {
        "name": s["name"], "group": s.get("group", "soft"), "hex": hexes,
        "contrast": {
            "fg/bg": ratio(c["fg"], c["bg"]),
            "muted/bg": ratio(c["muted"], c["bg"]),
            "fg/surface": ratio(c["fg"], c["surface"]),
            "accent-ink/accent-soft": ratio(c["accent-ink"], c["accent-soft"]),
            "white/accent": ratio((1.0, 0.0, 0.0), c["accent"]),
            "accent/bg": ratio(c["accent"], c["bg"]),
        }
    }
out["_moods"] = {n: oklch_to_hex(*v) for n, v in MOODS.items()}

print(json.dumps(out, ensure_ascii=False, indent=1))
