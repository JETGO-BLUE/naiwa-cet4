"""Rebuild the two public word lists from pinned, hash-checked upstream data.

Run with Python 3 (standard library only). No downloads happen in the extension.
"""
import hashlib
import json
from datetime import date
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "cet6": {
        "title": "OpenEtymology CET6",
        "repository": "https://github.com/openetymology/OpenEtymology",
        "commit": "7d89f3697abf26e305fe2627f181b692c2c10b28",
        "path": "CET6/CET6.txt",
        "sha256": "9a8fa3f2464a39526472211228ef1f331ab1e3d67567b11eea49efc7444d5647",
        "count": 2219,
        "license": "CC-BY-SA-4.0",
        "license_path": "DATA_LICENSE.md",
        "description": "公开六级词表；仅词头，无释义。",
    },
    "ielts": {
        "title": "WordLevel TOEFL & IELTS Essential Vocabulary",
        "repository": "https://github.com/gungorkaya-eng/toefl-essential-vocabulary-dataset",
        "commit": "85d4392a2254d2a1ad73cf12cdd8898b49cd3295",
        "path": "toefl_essential_vocabulary.json",
        "sha256": "1771a0b444f8a3141339c07474336fdf1336d2f966bef3d13a2a8fd64f9ea885",
        "count": 1000,
        "license": "MIT",
        "license_path": "LICENSE",
        "description": "社区、AI 增补的 TOEFL/IELTS 共用学术词表，非官方、非雅思专属。保留英文释义。",
    },
}
POS = {"noun": "n.", "verb": "v.", "adjective": "adj.", "adverb": "adv."}


def download(url):
    with urlopen(url, timeout=60) as response:
        return response.read()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    metadata = {"schema_version": 1, "retrieved_on": date.today().isoformat(), "sources": {}}
    (ROOT / "licenses").mkdir(exist_ok=True)
    for category, source in SOURCES.items():
        repo = source["repository"].removeprefix("https://github.com/")
        raw_base = f"https://raw.githubusercontent.com/{repo}/{source['commit']}/"
        raw = download(raw_base + source["path"])
        if digest(raw) != source["sha256"]:
            raise ValueError(f"Unexpected upstream SHA-256: {category}")
        if category == "cet6":
            words = {word.strip().lower(): "" for word in raw.decode("utf-8-sig").splitlines() if word.strip()}
        else:
            rows = json.loads(raw)
            words = {}
            for row in rows:
                word = row["word"].strip().lower()
                if word in words:
                    raise ValueError(f"Duplicate word: {word}")
                definition = row["definition_en"].strip()
                pos = POS.get(row["pos"], row["pos"] + ".")
                words[word] = f"{pos} {definition}"
        if len(words) != source["count"]:
            raise ValueError(f"Unexpected word count: {category}: {len(words)}")
        if any(not word or any(c not in "abcdefghijklmnopqrstuvwxyz-" for c in word) for word in words):
            raise ValueError(f"Invalid headword in {category}")
        output = (json.dumps(words, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
        filename = f"{category}_words.json"
        # Preserve the upstream license notice alongside each derived list.
        license_bytes = download(raw_base + source["license_path"])
        (ROOT / "licenses" / f"{category}-LICENSE.txt").write_bytes(license_bytes)
        (ROOT / filename).write_bytes(output)
        metadata["sources"][category] = {
            **source,
            "source_url": source["repository"] + "/blob/" + source["commit"] + "/" + source["path"],
            "license_url": source["repository"] + "/blob/" + source["commit"] + "/" + source["license_path"],
            "output_file": filename,
            "output_sha256": digest(output),
            "changes": "词头转小写、按字母排序、转为项目 JSON 格式；" + (
                "原数据仅词头，未新增释义。" if category == "cet6" else "保留原英文释义与词性，未生成中文释义。"
            ),
        }
        print(f"{filename}: {len(words)} words, SHA-256 {digest(output)}")
    (ROOT / "vocabulary-sources.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
