# -*- coding: utf-8 -*-
"""从固定版本的上游词表重建扩展用的词库文件。

为什么要有这个脚本：
  扩展里附带的数据必须能追溯到具体来源和许可，否则一旦有人问"这些词哪来的、
  能不能商用"，就只剩一句"网上下的"。这个脚本把「固定 commit → 校验源文件哈希 →
  转换 → 记录输出哈希」整条链固定下来，任何人都能照着复现。

用法（需要先自己把三个源文件下到本地）：

  python scripts/build-vocab-data.py \\
      --cet6   CET6.txt \\
      --ielts  toefl_essential_vocabulary.json \\
      --extras quiz_extras.json

也可以用 --fetch 让它自己去下载（会先校验 SHA-256，不一致直接退出）。

产出：
  cet6_words.json            六级词头（只有词，没有释义；释义由 vocab_extra_meanings 补）
  ielts_words.json           雅思/学术词表（带英文释义）
  vocab_extra_meanings.json  非四级词的中文释义（补在四级词表之外的那 1453 个词）
  vocabulary-sources.json    来源、许可、校验值、条目数、改动说明

注意：脚本只在构建期跑，扩展运行时不调用、不联网。
"""
import argparse
import hashlib
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 固定版本：commit 写死，避免上游改动让结果漂移
CET6_COMMIT = "7d89f3697abf26e305fe2627f181b692c2c10b28"
CET6_PATH = "CET6/CET6.txt"
CET6_REPO = "https://github.com/openetymology/OpenEtymology"
CET6_SHA = "9a8fa3f2464a39526472211228ef1f331ab1e3d67567b11eea49efc7444d5647"
CET6_URL = "https://raw.githubusercontent.com/openetymology/OpenEtymology/%s/%s" % (CET6_COMMIT, CET6_PATH)

IELTS_COMMIT = "85d4392a2254d2a1ad73cf12cdd8898b49cd3295"
IELTS_PATH = "toefl_essential_vocabulary.json"
IELTS_REPO = "https://github.com/gungorkaya-eng/toefl-essential-vocabulary-dataset"
IELTS_SHA = "1771a0b444f8a3141339c07474336fdf1336d2f966bef3d13a2a8fd64f9ea885"
IELTS_URL = "https://raw.githubusercontent.com/gungorkaya-eng/toefl-essential-vocabulary-dataset/%s/%s" % (IELTS_COMMIT, IELTS_PATH)

# 词性缩写：上游用完整单词，扩展里习惯用缩写，保持卡片上风格统一
POS_MAP = {
    "noun": "n.",
    "verb": "v.",
    "adjective": "adj.",
    "adverb": "adv.",
    "preposition": "prep.",
    "conjunction": "conj.",
    "pronoun": "pron.",
    "numeral": "num.",
    "interjection": "int.",
    "determiner": "det.",
    "article": "art.",
    "auxiliary verb": "aux.",
    "phrase": "phr.",
}


def sha256_of(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def dump_json(path, obj):
    """统一格式：2 空格缩进、不转义中文、\n 换行。"""
    text = json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return sha256_bytes(text.encode("utf-8")), len(text.encode("utf-8"))


def fetch(url, expect_sha, cache_path):
    if os.path.exists(cache_path):
        if sha256_of(cache_path) == expect_sha:
            print("  复用本地缓存 %s（哈希一致）" % os.path.basename(cache_path))
            return cache_path
        print("  本地缓存哈希不一致，重新下载")
    print("  下载 %s" % url)
    req = urllib.request.Request(url, headers={"User-Agent": "naiwa-cet4-build/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    got = sha256_bytes(data)
    if got != expect_sha:
        sys.exit("源文件哈希不一致，拒绝继续\n  期望 %s\n  实际 %s" % (expect_sha, got))
    with open(cache_path, "wb") as f:
        f.write(data)
    print("  哈希校验通过")
    return cache_path


def build_cet6(src):
    words = []
    with open(src, encoding="utf-8") as f:
        for line in f:
            w = line.strip().lower()
            if not w or w.startswith("#"):
                continue
            words.append(w)
    words = sorted(set(words))
    return {w: "" for w in words}


def build_ielts(src):
    data = json.load(open(src, encoding="utf-8"))
    if not isinstance(data, list):
        sys.exit("雅思词表格式意外：期望数组")
    out = {}
    for item in data:
        if not isinstance(item, dict):
            continue
        w = str(item.get("word") or "").strip().lower()
        if not w:
            continue
        pos = POS_MAP.get(str(item.get("pos") or "").strip().lower(), "")
        definition = str(item.get("definition_en") or "").strip()
        if not definition:
            continue
        out[w] = (pos + " " + definition).strip() if pos else definition
    return out


def build_extras(src):
    """把上游补充题里的中文释义抽出来，变成「词 → 释义」。

    只留 correct 释义（其余干扰项、规则说明在扩展里用不上，省掉 660 KB）。
    上游的 correct 不带词性前缀，这里按 partOfSpeech 补上，让卡片上的选项风格一致。
    """
    data = json.load(open(src, encoding="utf-8"))
    if not isinstance(data, dict):
        sys.exit("quiz_extras 格式意外：期望对象")
    out = {}
    for word, entry in data.items():
        if not isinstance(entry, dict):
            continue
        w = str(word).strip().lower()
        meaning = str(entry.get("correct") or "").strip()
        if not w or not meaning:
            continue
        pos = POS_MAP.get(str(entry.get("partOfSpeech") or "").strip().lower(), "")
        out[w] = (pos + " " + meaning).strip() if pos else meaning
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cet6", help="OpenEtymology CET6.txt 路径")
    ap.add_argument("--ielts", help="WordLevel toefl_essential_vocabulary.json 路径")
    ap.add_argument("--extras", help="quiz_extras.json 路径（提供中文释义）")
    ap.add_argument("--fetch", action="store_true", help="自己下载 CET6 / IELTS 源文件")
    args = ap.parse_args()

    cache_dir = os.path.join(ROOT, "scripts", ".cache")
    os.makedirs(cache_dir, exist_ok=True)

    print("=" * 62)
    print("1. 准备源文件")
    cet6_src = args.cet6
    ielts_src = args.ielts
    if args.fetch or not cet6_src:
        cet6_src = fetch(CET6_URL, CET6_SHA, os.path.join(cache_dir, "CET6.txt"))
    else:
        if sha256_of(cet6_src) != CET6_SHA:
            sys.exit("CET6 源文件哈希不匹配，可能下错了版本")
        print("  CET6 哈希一致")
    if args.fetch or not ielts_src:
        ielts_src = fetch(IELTS_URL, IELTS_SHA, os.path.join(cache_dir, "toefl.json"))
    else:
        if sha256_of(ielts_src) != IELTS_SHA:
            sys.exit("IELTS 源文件哈希不匹配，可能下错了版本")
        print("  IELTS 哈希一致")
    if not args.extras:
        sys.exit("必须用 --extras 指定 quiz_extras.json（中文释义来源）")
    if not os.path.exists(args.extras):
        sys.exit("找不到 --extras 指定的文件: " + args.extras)

    print("\n2. 生成词库")
    cet6 = build_cet6(cet6_src)
    ielts = build_ielts(ielts_src)
    extras = build_extras(args.extras)

    files = [
        ("cet6_words.json", cet6),
        ("ielts_words.json", ielts),
        ("vocab_extra_meanings.json", extras),
    ]
    out_meta = {}
    for name, obj in files:
        path = os.path.join(ROOT, name)
        digest, size = dump_json(path, obj)
        out_meta[name] = {"count": len(obj), "sha256": digest, "bytes": size}
        print("  %-28s %5d 条  %7.1f KB  %s" % (name, len(obj), size / 1024, digest[:12] + "..."))

    print("\n3. 写 vocabulary-sources.json")
    sources = {
        "schema_version": 1,
        "retrieved_on": "2026-10-18",
        "sources": {
            "cet6": {
                "title": "OpenEtymology CET6",
                "repository": CET6_REPO,
                "commit": CET6_COMMIT,
                "path": CET6_PATH,
                "source_url": CET6_URL,
                "source_sha256": CET6_SHA,
                "license": "CC-BY-SA-4.0",
                "license_file": "licenses/CC-BY-SA-4.0.txt",
                "upstream_license_note": "licenses/cet6-LICENSE.txt",
                "description": "公开六级词表，仅词头，源数据不带释义。",
                "output_file": "cet6_words.json",
                "output_count": out_meta["cet6_words.json"]["count"],
                "output_sha256": out_meta["cet6_words.json"]["sha256"],
                "changes": "词头转小写、去重、按字母排序、转为 {词: \"\"} 的 JSON；未新增释义。",
            },
            "ielts": {
                "title": "WordLevel TOEFL & IELTS Essential Vocabulary",
                "repository": IELTS_REPO,
                "commit": IELTS_COMMIT,
                "path": IELTS_PATH,
                "source_url": IELTS_URL,
                "source_sha256": IELTS_SHA,
                "license": "MIT",
                "license_file": "licenses/ielts-LICENSE.txt",
                "description": "社区整理、含 AI 增补的 TOEFL/IELTS 共用学术词表，非官方雅思词表、非雅思专属。",
                "output_file": "ielts_words.json",
                "output_count": out_meta["ielts_words.json"]["count"],
                "output_sha256": out_meta["ielts_words.json"]["sha256"],
                "changes": "词头转小写、按字母排序；definition_en 前加词性缩写，保留英文释义，未译成中文。",
            },
            "extra_meanings": {
                "title": "非四级词的中文释义（补充）",
                "derived_from": [
                    "ECDICT（中文释义，仓库声明 MIT；其 README 说明为多来源汇编，单词条未保留上游出处）",
                    "Wiktionary（固定修订，少量词条）",
                ],
                "license_file": "licenses/ecdict-LICENSE.txt",
                "description": "四级词表以外、六级/雅思词同表头的中文释义，用来让六级与雅思模式也能离线出中文题。",
                "output_file": "vocab_extra_meanings.json",
                "output_count": out_meta["vocab_extra_meanings.json"]["count"],
                "output_sha256": out_meta["vocab_extra_meanings.json"]["sha256"],
                "changes": "只取 correct 释义，按 partOfSpeech 补词性前缀；丢掉干扰项与规则说明（省约 660 KB）。",
                "provenance_caveat": "ECDICT 为汇编数据，单词条无独立出处；本项目依仓库级 MIT 声明复用，并在此记录该限制。",
            },
        },
    }
    digest, size = dump_json(os.path.join(ROOT, "vocabulary-sources.json"), sources)
    print("  vocabulary-sources.json 已写入（%.1f KB）" % (size / 1024))

    print("\n" + "=" * 62)
    total = sum(m["count"] for m in out_meta.values())
    print("完成：%d 条数据，词库文件共 %.1f KB" % (total, sum(m["bytes"] for m in out_meta.values()) / 1024))


if __name__ == "__main__":
    main()
