#!/usr/bin/env python3
"""Validate quiz coverage, question shape, provenance records, and pinned hashes."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POS_RE = r"(?:vt|vi|adj|adv|prep|conj|pron|num|det|aux|abbr|int|ad|n|v|a)"
POS_SPLIT = re.compile(r"(?<!\S)(?=" + POS_RE + r"\.)", re.I)
POS_HEAD = re.compile(r"^(" + POS_RE + r"(?:&" + POS_RE + r")?\.)\s*", re.I)
OBSCURE = re.compile(r"【|\(archaic\)|\(dated\)|\(obsolete\)|\(rare\)|古[语旧]|废[语词]", re.I)


def fail(message: str) -> None:
    raise SystemExit(f"quiz validation failed: {message}")


def read_json(name: str):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def sha256(name: str) -> str:
    return hashlib.sha256((ROOT / name).read_bytes()).hexdigest()


def normalized(value: str) -> str:
    return re.sub(r"[\s，,。；;：:、/（）()\[\]【】]", "", value).lower()


def runtime_meaning(value: str) -> str:
    """Mirror the service-worker's two-common-senses display projection."""
    segments = POS_SPLIT.split(value or "")
    kept = []
    for segment in segments:
        segment = segment.strip()
        if not segment:
            continue
        head = POS_HEAD.match(segment)
        tag = head.group(1) if head else ""
        body = segment[head.end():] if head else segment
        senses = []
        for sense in re.split(r"[；;]", body):
            sense = sense.strip()
            if not sense or OBSCURE.search(sense):
                continue
            senses.append(sense)
            if len(senses) == 2:
                break
        if senses:
            kept.append((tag + " " if tag else "") + "；".join(senses))
    return " ".join(kept)


vocabularies = {category: read_json(f"{category}_words.json") for category in ("cet4", "cet6", "ielts")}
bank = read_json("quiz_bank.json")
extras = read_json("quiz_extras.json")
sources = read_json("quiz-sources.json")
license_ecdict = ROOT / "licenses/ecdict-LICENSE.txt"
license_cc = ROOT / "licenses/CC-BY-SA-4.0.txt"

if len(vocabularies["cet4"]) != 4590 or len(vocabularies["cet6"]) != 2219 or len(vocabularies["ielts"]) != 1000:
    fail("vocabulary snapshot counts changed")
union = set().union(*(set(items) for items in vocabularies.values()))
if len(union) != 6043:
    fail(f"unexpected vocabulary union size: {len(union)}")
if len(bank) != 4590 or set(bank) != set(vocabularies["cet4"]):
    fail("upstream quiz bank does not exactly cover the CET4 vocabulary")
meaning_index = {}
for category in ("cet4", "cet6", "ielts"):
    for word, meaning in vocabularies[category].items():
        meaning_index.setdefault(word, meaning)
duplicate_gloss_rows = []
for word, distractors in bank.items():
    if not isinstance(distractors, list) or len(distractors) != 3:
        fail(f"upstream question does not have three distractor words: {word}")
    if len(set(distractors)) != 3 or any(candidate not in union or candidate == word for candidate in distractors):
        fail(f"upstream distractor word source is invalid: {word}")
    options = [runtime_meaning(meaning_index.get(candidate, "")) or meaning_index.get(candidate, "")
               for candidate in [word, *distractors]]
    if any(not option.strip() for option in options):
        fail(f"upstream question has a missing answer or option gloss: {word}")
    if len({normalized(option) for option in options}) != 4:
        duplicate_gloss_rows.append(word)
known_duplicates = sources["upstream_quiz_bank"].get("known_duplicate_gloss_rows", [])
if duplicate_gloss_rows != known_duplicates or sources["upstream_quiz_bank"].get("runtime_repair_count") != len(known_duplicates):
    fail(f"upstream duplicate-gloss metadata changed: {duplicate_gloss_rows}")

expected_extras = union - set(bank)
if set(extras) != expected_extras:
    fail(f"extra questions mismatch: expected {len(expected_extras)}, got {len(extras)}")
for category, words in vocabularies.items():
    covered = set(words) & (set(bank) | set(extras))
    coverage = sources["overall_question_coverage"]["by_vocabulary"][category]
    if len(covered) != len(words) or coverage != {"total": len(words), "covered": len(words), "missing": 0}:
        fail(f"incomplete or stale {category} coverage: {coverage}")
overall = sources["overall_question_coverage"]
if overall.get("unique_vocabulary_heads") != len(union) or overall.get("question_count") != len(union) or overall.get("missing_items") != []:
    fail("overall question coverage metadata is stale")

if sha256("quiz_bank.json") != sources["upstream_quiz_bank"]["sha256"]:
    fail("upstream quiz bank checksum mismatch")
if sha256("LICENSE") != sources["upstream_quiz_bank"].get("license_file_sha256"):
    fail("upstream quiz license notice is missing or changed")
if sources["upstream_quiz_bank"].get("license_source_sha256") != "28dc702df2bc1232120917d755a735e567ceaa62f7940f911338e1b56ce00311":
    fail("upstream repository license source checksum is stale")
if sha256("quiz_extras.json") != sources["ecdict"]["output_sha256"]:
    fail("generated quiz checksum mismatch")
if not license_ecdict.is_file() or hashlib.sha256(license_ecdict.read_bytes()).hexdigest() != sources["ecdict"]["license_file_sha256"]:
    fail("ECDICT license notice missing or changed")
if not license_cc.is_file():
    fail("CC BY-SA license text missing")
if hashlib.sha256(license_cc.read_bytes()).hexdigest() != sources["inasmuchas_compatibility"].get("license_file_sha256", ""):
    fail("CC BY-SA license checksum missing or changed")

required_source_fields = ("source_url", "retrieved_on", "license", "missing_items", "license_url", "attribution")
for source_key in ("upstream_quiz_bank", "ecdict", "inasmuchas_compatibility"):
    source = sources[source_key]
    if any(field not in source for field in required_source_fields) or any(
        not source[field] for field in required_source_fields if field != "missing_items"
    ):
        fail(f"source provenance incomplete: {source_key}")

for word, item in extras.items():
    options = [item.get("correct", ""), *item.get("distractors", [])]
    if len(options) != 4 or any(not isinstance(option, str) or not option.strip() for option in options):
        fail(f"question must contain one answer and three non-empty distractors: {word}")
    if len({normalized(option) for option in options}) != 4:
        fail(f"question contains duplicate or equivalent options: {word}")
    distractor_words = item.get("distractorWords")
    if not isinstance(distractor_words, list) or len(distractor_words) != 3:
        fail(f"question does not identify three source distractor words: {word}")
    if len(set(distractor_words)) != 3 or any(candidate not in union or candidate == word for candidate in distractor_words):
        fail(f"question distractor provenance is invalid: {word}")
    if not item.get("meaningSource") or not item.get("reviewStatus"):
        fail(f"question source or review status missing: {word}")
    if word == "inasmuchas":
        if item.get("sourceWord") != "inasmuch as" or item.get("meaningSource", {}).get("dataset") != "English Wiktionary":
            fail("inasmuchas compatibility source does not point to the source phrase")
    elif item.get("meaningSource") != "ecdict":
        fail(f"unexpected meaning source for generated question: {word}")

if sources["ecdict"]["coverage_count"] != len(expected_extras) - 1:
    fail("ECDICT coverage count is stale")
if not sources["ecdict"].get("license_scope_note") or not sources["ecdict"].get("readme_url"):
    fail("ECDICT multi-source provenance limitation is not recorded")
if sources["inasmuchas_compatibility"].get("source_revision") != 91768332:
    fail("Wiktionary revision is not pinned")
if sources["inasmuchas_compatibility"].get("coverage_count") != 1:
    fail("Wiktionary compatibility coverage is stale")
if sources["inasmuchas_compatibility"].get("source_snapshot_sha256") != "8b2d11955cc46163c87841293da822d1795ee44e0b3d8d3b4e1e7e8a15c8b034":
    fail("Wiktionary source snapshot checksum is stale")

print("quiz coverage and structure verified: 6,043 unique heads; CET4 4,590/4,590; CET6 2,219/2,219; IELTS 1,000/1,000; 1,453 extra questions")
