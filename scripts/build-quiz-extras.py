"""Build the extra local questions needed by CET6 and IELTS vocabulary.

The upstream CET4 question bank remains untouched. Missing answers come from a
hash-pinned ECDICT snapshot (MIT declared by its repository); distractors are
generated from other vocabulary entries with matching part of speech and
different Chinese wording. The corrected IELTS phrase is kept as an explicit
compatibility exception with its own source record.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import tempfile
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ECdict_COMMIT = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b"
ECdict_BASE = f"https://raw.githubusercontent.com/skywind3000/ECDICT/{ECdict_COMMIT}/"
ECdict_CSV_SHA256 = "1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf"
ECdict_LICENSE_SHA256 = "f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f"
ECdict_URL = f"https://github.com/skywind3000/ECDICT/blob/{ECdict_COMMIT}/ecdict.csv"
ECdict_LICENSE_URL = f"https://github.com/skywind3000/ECDICT/blob/{ECdict_COMMIT}/LICENSE"
WIKTIONARY_PHRASE_URL = "https://en.wiktionary.org/wiki/inasmuch_as"
WIKTIONARY_REVISION_ID = 91768332
WIKTIONARY_API_URL = (
    "https://en.wiktionary.org/w/api.php?action=query&revids=91768332"
    "&prop=revisions&rvprop=ids%7Ccontent&rvslots=main&format=json"
)
WIKTIONARY_SNAPSHOT_SHA256 = "8b2d11955cc46163c87841293da822d1795ee44e0b3d8d3b4e1e7e8a15c8b034"
WIKTIONARY_LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/"
WIKTIONARY_LICENSE_SHA256 = "28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5"

CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
POS_PREFIX = re.compile(r"^\s*(n|v|vt|vi|a|adj|ad|adv|pron|prep|conj|art|aux|int|num|abbr)\.?\s+", re.I)
POS_MAP = {
    "n": "noun", "v": "verb", "vt": "verb", "vi": "verb",
    "a": "adjective", "adj": "adjective", "ad": "adverb", "adv": "adverb",
    "pron": "pronoun", "prep": "preposition", "conj": "conjunction",
    "art": "article", "aux": "auxiliary", "int": "interjection",
    "num": "numeral", "abbr": "abbreviation",
}
IGNORED_CHARS = set("的了是使把由在与及或而于为对和将可其一之所并更最多少很不有被向从等")
MANUAL_PHRASE = {
    "word": "inasmuchas",
    "correct": "因为；鉴于；由于",
    "pos": "conjunction",
    "meaningSource": {
        "dataset": "English Wiktionary",
        "url": WIKTIONARY_PHRASE_URL,
        "license": "CC-BY-SA-4.0",
        "field": "English gloss localized for this compatibility correction",
    },
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch_pinned_source(temp_dir: Path) -> tuple[Path, bytes]:
    csv_path = temp_dir / "ecdict.csv"
    license_path = temp_dir / "ecdict-LICENSE.txt"
    for name, path, expected in (
        ("ecdict.csv", csv_path, ECdict_CSV_SHA256),
        ("LICENSE", license_path, ECdict_LICENSE_SHA256),
    ):
        request = urllib.request.Request(
            ECdict_BASE + name,
            headers={"User-Agent": "Mozilla/5.0 (compatible; naiwa-cet4 source verifier/1.0)"},
        )
        with urllib.request.urlopen(request, timeout=60) as response, path.open("wb") as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
        actual = sha256_file(path)
        if actual != expected:
            raise ValueError(f"Unexpected SHA-256 for {name}: {actual}")
    return csv_path, license_path.read_bytes()


def fetch_pinned_wiktionary_revision() -> tuple[dict, bytes]:
    request = urllib.request.Request(
        WIKTIONARY_API_URL,
        headers={"User-Agent": "Mozilla/5.0 (compatible; naiwa-cet4 source verifier/1.0)"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
    actual = hashlib.sha256(raw).hexdigest()
    if actual != WIKTIONARY_SNAPSHOT_SHA256:
        raise ValueError(f"Unexpected Wiktionary snapshot SHA-256: {actual}")
    data = json.loads(raw)
    revisions = next(iter(data.get("query", {}).get("pages", {}).values()), {}).get("revisions", [])
    if not revisions or revisions[0].get("revid") != WIKTIONARY_REVISION_ID:
        raise ValueError("Wiktionary API did not return the pinned revision")
    wikitext = revisions[0].get("slots", {}).get("main", {}).get("*", "")
    if "Because]] of the fact that" not in wikitext or "To the [[extent]] that" not in wikitext:
        raise ValueError("Pinned Wiktionary entry no longer contains the expected glosses")
    return data, raw


def canonical_pos(value: str) -> str:
    return POS_MAP.get(value.lower(), value.lower())


def parse_translation(value: str, fallback_pos: str = "") -> tuple[str, str] | None:
    """Return the first concise CJK gloss and its part-of-speech marker."""
    for line in re.split(r"\\n|\r?\n", value):
        line = line.strip()
        if not line:
            continue
        match = POS_PREFIX.match(line)
        pos = canonical_pos(match.group(1)) if match else fallback_pos or "unknown"
        gloss = POS_PREFIX.sub("", line, count=1).strip(" ,，;；/、\t") if match else line
        # Ignore dictionary-domain-only lines, while preserving their words if
        # a normal gloss is also present later in the row.
        if not CJK.search(gloss):
            continue
        gloss = re.sub(r"\s+", " ", gloss)
        gloss = re.sub(r"\[[^\]]+\]\s*", "", gloss).strip(" ,，;；/、\t")
        if gloss:
            return gloss[:80], pos
    return None


def concise_meaning(value: str) -> str:
    value = re.sub(r"\s+", " ", value).strip()
    parts = re.split(r"[;；]", value, maxsplit=1)
    return parts[0].strip(" ,，/、")[:80]


def normalized_meaning(value: str) -> str:
    return re.sub(r"[\s，,。；;：:、/（）()\[\]【】]", "", value).lower()


def content_chars(value: str) -> set[str]:
    return {character for character in CJK.findall(value) if character not in IGNORED_CHARS}


def overlap_ratio(left: str, right: str) -> float:
    a = content_chars(left)
    b = content_chars(right)
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def stable_order(seed: str, candidates: list[tuple[str, dict]]) -> list[tuple[str, dict]]:
    return sorted(candidates, key=lambda item: hashlib.sha256((seed + "\0" + item[0]).encode()).hexdigest())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-csv", type=Path, help="Use a local copy of the pinned ECDICT CSV")
    args = parser.parse_args()

    _, wiktionary_snapshot = fetch_pinned_wiktionary_revision()
    with tempfile.TemporaryDirectory(prefix="naiwa-quiz-source-") as temp_name:
        temp_dir = Path(temp_name)
        if args.source_csv:
            csv_path = args.source_csv.resolve()
            license_path = None
            csv_hash = sha256_file(csv_path)
            if csv_hash != ECdict_CSV_SHA256:
                raise ValueError(f"Unexpected ECDICT SHA-256: {csv_hash}")
            license_bytes = None
        else:
            csv_path, license_bytes = fetch_pinned_source(temp_dir)
            csv_hash = sha256_file(csv_path)

        vocabularies = {
            category: json.loads((ROOT / f"{category}_words.json").read_text(encoding="utf-8"))
            for category in ("cet4", "cet6", "ielts")
        }
        targets = set().union(*(set(words) for words in vocabularies.values()))
        cet4 = vocabularies["cet4"]
        existing_bank = json.loads((ROOT / "quiz_bank.json").read_text(encoding="utf-8"))
        missing = targets - set(existing_bank)

        source_entries: dict[str, dict] = {}
        with csv_path.open(encoding="utf-8-sig", newline="") as source:
            for row in csv.DictReader(source):
                word = (row.get("word") or "").strip().lower()
                if word not in targets or word in source_entries:
                    continue
                english_pos = POS_PREFIX.match(row.get("definition") or "")
                fallback_pos = canonical_pos(english_pos.group(1)) if english_pos else ""
                parsed = parse_translation(row.get("translation") or "", fallback_pos)
                if not parsed:
                    continue
                gloss, pos = parsed
                source_entries[word] = {
                    "meaning": gloss,
                    "pos": pos,
                    "definition": (row.get("definition") or "").strip()[:240],
                }

        candidate_entries: dict[str, dict] = {}
        for word in targets:
            source = source_entries.get(word)
            if word in cet4 and cet4[word].strip():
                candidate_entries[word] = {
                    "meaning": concise_meaning(cet4[word]),
                    "pos": source["pos"] if source else "",
                    "dataset": "CET4 vocabulary already bundled with the project",
                }
            elif source:
                candidate_entries[word] = {**source, "dataset": "ECDICT"}

        extras: dict[str, dict] = {}
        fallback_pos = 0
        weak_overlap = 0
        for word in sorted(missing - {MANUAL_PHRASE["word"]}):
            correct_source = source_entries.get(word)
            if not correct_source:
                raise ValueError(f"No reusable Chinese meaning for missing question: {word}")
            correct = correct_source["meaning"]
            pos = correct_source["pos"]
            pool = [
                (candidate_word, candidate)
                for candidate_word, candidate in candidate_entries.items()
                if candidate_word != word and candidate["meaning"] and
                candidate["pos"] == pos and
                normalized_meaning(candidate["meaning"]) != normalized_meaning(correct)
            ]
            ordered = stable_order(word, pool)
            choices: list[tuple[str, dict]] = []
            for candidate_word, candidate in ordered:
                if overlap_ratio(correct, candidate["meaning"]) >= 0.50:
                    continue
                if any(normalized_meaning(candidate["meaning"]) == normalized_meaning(item[1]["meaning"]) for item in choices):
                    continue
                choices.append((candidate_word, candidate))
                if len(choices) == 3:
                    break
            if len(choices) < 3:
                # If source POS metadata is sparse, allow other POS only after
                # exhausting the same-POS pool; record that exception.
                fallback_pos += 1
                fallback_pool = [
                    (candidate_word, candidate)
                    for candidate_word, candidate in stable_order(word + "-fallback", list(candidate_entries.items()))
                    if candidate_word != word and candidate["meaning"] and
                    normalized_meaning(candidate["meaning"]) != normalized_meaning(correct) and
                    all(candidate_word != item[0] for item in choices)
                ]
                for candidate_word, candidate in fallback_pool:
                    if overlap_ratio(correct, candidate["meaning"]) >= 0.40:
                        continue
                    if any(normalized_meaning(candidate["meaning"]) == normalized_meaning(item[1]["meaning"]) for item in choices):
                        continue
                    choices.append((candidate_word, candidate))
                    if len(choices) == 3:
                        break
            if len(choices) != 3:
                raise ValueError(f"Could not generate three distinct distractors for {word}")
            if any(overlap_ratio(correct, item[1]["meaning"]) >= 0.40 for item in choices):
                weak_overlap += 1
            extras[word] = {
                "correct": correct,
                "distractors": [item[1]["meaning"] for item in choices],
                "distractorWords": [item[0] for item in choices],
                "partOfSpeech": pos,
                "meaningSource": "ecdict",
                "sourceWord": word,
                "distractorRule": "same part of speech; distinct glosses; low shared Chinese content-character ratio",
                "reviewStatus": "automatically generated; not human-reviewed",
            }

        phrase_pool = [
            (candidate_word, candidate)
            for candidate_word, candidate in candidate_entries.items()
            if candidate_word != MANUAL_PHRASE["word"] and candidate["pos"] == MANUAL_PHRASE["pos"]
        ]
        phrase_choices: list[tuple[str, dict]] = []
        for candidate_word, candidate in stable_order(MANUAL_PHRASE["word"], phrase_pool):
            if normalized_meaning(candidate["meaning"]) == normalized_meaning(MANUAL_PHRASE["correct"]):
                continue
            if overlap_ratio(MANUAL_PHRASE["correct"], candidate["meaning"]) >= 0.50:
                continue
            if any(normalized_meaning(candidate["meaning"]) == normalized_meaning(item[1]["meaning"]) for item in phrase_choices):
                continue
            phrase_choices.append((candidate_word, candidate))
            if len(phrase_choices) == 3:
                break
        if len(phrase_choices) != 3:
            raise ValueError("Could not generate three conjunction distractors for the repaired phrase")
        extras[MANUAL_PHRASE["word"]] = {
            "correct": MANUAL_PHRASE["correct"],
            "distractors": [item[1]["meaning"] for item in phrase_choices],
            "distractorWords": [item[0] for item in phrase_choices],
            "partOfSpeech": MANUAL_PHRASE["pos"],
            "meaningSource": MANUAL_PHRASE["meaningSource"],
            "sourceWord": "inasmuch as",
            "distractorRule": "same part of speech; distinct glosses; low shared Chinese content-character ratio",
            "reviewStatus": "compatibility correction; distractors automatically generated; not human-reviewed",
        }

        # Every question is exactly one answer plus three unique distractors.
        for word, item in extras.items():
            options = [item["correct"], *item["distractors"]]
            normalized = [normalized_meaning(option) for option in options]
            if len(options) != 4 or any(not option for option in options) or len(set(normalized)) != 4:
                raise ValueError(f"Invalid four-choice question: {word}")

        expected_extra = missing
        if set(extras) != expected_extra:
            raise ValueError(f"Question coverage mismatch: missing={sorted(expected_extra-set(extras))[:20]}, extra={sorted(set(extras)-expected_extra)[:20]}")

        output_path = ROOT / "quiz_extras.json"
        output_bytes = (json.dumps(extras, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
        output_path.write_bytes(output_bytes)
        if license_bytes is not None:
            license_dir = ROOT / "licenses"
            license_dir.mkdir(exist_ok=True)
            (license_dir / "ecdict-LICENSE.txt").write_bytes(license_bytes)

        category_counts = {}
        for category, words in vocabularies.items():
            covered = set(words) & (set(existing_bank) | set(extras))
            category_counts[category] = {"total": len(words), "covered": len(covered), "missing": len(set(words) - covered)}
            if len(covered) != len(words):
                raise ValueError(f"Question coverage incomplete for {category}: {category_counts[category]}")

        metadata = {
            "schema_version": 1,
            "retrieved_on": date.today().isoformat(),
            "overall_question_coverage": {
                "unique_vocabulary_heads": len(targets),
                "question_count": len(existing_bank) + len(extras),
                "by_vocabulary": category_counts,
                "missing_items": [],
            },
            "upstream_quiz_bank": {
                "source_url": f"https://github.com/JETGO-BLUE/naiwa-cet4/blob/ea6f10676e923d3a3a5d3bd4e848942319bda170/quiz_bank.json",
                "source_commit": "ea6f10676e923d3a3a5d3bd4e848942319bda170",
                "retrieved_on": date.today().isoformat(),
                "file": "quiz_bank.json",
                "sha256": sha256_file(ROOT / "quiz_bank.json"),
                "coverage_count": len(existing_bank),
                "license": "MIT repository license; retained unchanged",
                "license_url": "https://github.com/JETGO-BLUE/naiwa-cet4/blob/ea6f10676e923d3a3a5d3bd4e848942319bda170/LICENSE",
                "license_file": "LICENSE",
                "license_source_sha256": "28dc702df2bc1232120917d755a735e567ceaa62f7940f911338e1b56ce00311",
                "license_file_sha256": sha256_file(ROOT / "LICENSE"),
                "attribution": "JETGO-BLUE / upstream naiwa-cet4 contributors; source file retained unchanged",
            "missing_items": [],
                "changes": "保留上游四级题库原文件；运行时通过 cet4_words.json 生成选项。",
                "known_duplicate_gloss_rows": ["cigar", "mysterious"],
                "runtime_repair_count": 2,
                "runtime_repair": "上游这两条题目中两个干扰词释义相同；保留原文件，运行时确定性地替换重复释义，并优先选择同词性的 CET4 释义。",
            },
            "ecdict": {
                "source_url": ECdict_URL,
                "repository": "https://github.com/skywind3000/ECDICT",
                "source_commit": ECdict_COMMIT,
                "retrieved_on": date.today().isoformat(),
                "source_file": "ecdict.csv",
                "source_sha256": csv_hash,
                "license": "MIT (repository license declaration)",
                "license_url": ECdict_LICENSE_URL,
                "license_file_sha256": ECdict_LICENSE_SHA256,
                "attribution": "Linwei (Copyright 2025; see the included ECDICT LICENSE)",
                "license_scope_note": "ECDICT 仓库对本仓库声明 MIT，但 README 描述其为多来源汇编，未给每行记录上游出处；本项目依据仓库声明复用并保留此溯源限制。",
                "readme_url": f"https://github.com/skywind3000/ECDICT/blob/{ECdict_COMMIT}/README.md",
                "output_file": "quiz_extras.json",
                "output_sha256": hashlib.sha256(output_bytes).hexdigest(),
                "coverage_count": len(extras) - 1,
                "generated_question_count": len(extras) - 1,
                "missing_items": ["inasmuchas：ECDICT 未提供该历史词头，使用下方 Wiktionary 短语来源修正"],
                "provenance_note": "ECDICT README describes a multi-source compilation; source is pinned and the declared MIT notice is included, but individual historical upstream origins are not recorded per row.",
                "changes": "仅为已有四级题库未覆盖的词取中文 translation 字段首条带词性的中文释义；按词性从三词库并集中选取三个释义，去重并以共享汉字比例限制表面相似；题目由脚本整理生成，未经逐题人工复核。",
                "distractor_quality": {
                    "generated_questions": len(extras) - 1,
                    "part_of_speech_fallbacks": fallback_pos,
                    "high_overlap_questions": weak_overlap,
                    "structural_validation": "四项齐全、释义非空且规范化后不重复；不等同于人工语义审校。",
                },
            },
            "inasmuchas_compatibility": {
                "legacy_headword": "inasmuchas",
                "caption_phrase": "inasmuch as",
                "meaning": MANUAL_PHRASE["correct"],
                "source_revision": WIKTIONARY_REVISION_ID,
                "coverage_count": 1,
                "source_url": WIKTIONARY_PHRASE_URL,
                "source_snapshot_url": WIKTIONARY_API_URL,
                "source_snapshot_sha256": hashlib.sha256(wiktionary_snapshot).hexdigest(),
                "retrieved_on": date.today().isoformat(),
                "attribution": "English Wiktionary contributors, page ‘inasmuch as’, revision 91768332",
                "license": "CC-BY-SA-4.0",
                "license_url": WIKTIONARY_LICENSE_URL,
                "license_file": "licenses/CC-BY-SA-4.0.txt",
                "license_file_sha256": WIKTIONARY_LICENSE_SHA256,
                "translation_note": "据英文释义 ‘Because of the fact that; since’ 整理中文译义；保留字幕历史词头并将标准短语映射到它。",
                "missing_items": [],
            },
        }
        (ROOT / "quiz-sources.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"generated_questions": len(extras), "coverage": category_counts, "part_of_speech_fallbacks": fallback_pos, "high_overlap_questions": weak_overlap, "quiz_extras_sha256": hashlib.sha256(output_bytes).hexdigest()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
