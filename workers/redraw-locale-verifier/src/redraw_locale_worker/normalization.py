import re
import unicodedata

import jiwer

NEGATION_TOKENS = {"no", "not", "never", "none", "cannot", "can't", "dont", "don't", "didnt", "didn't", "wont", "won't"}
NUMBER_WORDS = {
    "zero": "0",
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
    "ten": "10",
    "eleven": "11",
    "twelve": "12",
    "thirteen": "13",
    "fourteen": "14",
    "fifteen": "15",
    "sixteen": "16",
    "seventeen": "17",
    "eighteen": "18",
    "nineteen": "19",
    "twenty": "20",
    "thirty": "30",
    "forty": "40",
    "fifty": "50",
    "sixty": "60",
    "seventy": "70",
    "eighty": "80",
    "ninety": "90",
    "hundred": "100",
}


def score_text(approved_text, transcript_text):
    approved = _coerce_text(approved_text)
    transcript = _coerce_text(transcript_text)
    if not approved.strip():
        return {
            "word_error_rate": 1,
            "character_error_rate": 1,
            "critical_tokens_match": False,
            "critical_tokens": {"approved": [], "observed": [], "missing": []},
        }

    normalized_approved = normalize_english_text(approved)
    normalized_transcript = normalize_english_text(transcript)
    approved_critical = _critical_tokens(approved)
    observed_critical = _critical_tokens(transcript)
    observed_match_keys = {_match_key(token) for token in observed_critical}
    observed_match_keys.update(normalize_english_text(transcript).split())
    missing = sorted(token for token in approved_critical if _match_key(token) not in observed_match_keys)
    return {
        "word_error_rate": float(jiwer.wer(normalized_approved, normalized_transcript)),
        "character_error_rate": float(jiwer.cer(normalized_approved, normalized_transcript)),
        "critical_tokens_match": not missing,
        "critical_tokens": {
            "approved": sorted(approved_critical),
            "observed": sorted(observed_critical),
            "missing": missing,
        },
    }


def normalize_english_text(value):
    normalized = unicodedata.normalize("NFKC", _coerce_text(value)).casefold()
    normalized = normalized.replace("'", "")
    normalized = re.sub(r"[^\w\s]", " ", normalized, flags=re.ASCII)
    tokens = [_normalize_number_token(token) for token in normalized.split()]
    return " ".join(tokens)


def _critical_tokens(value):
    tokens = set()
    for raw in re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?|\d+", _coerce_text(value)):
        folded = raw.casefold()
        compact = folded.replace("'", "")
        if raw.isdigit():
            tokens.add(raw)
        elif folded in NEGATION_TOKENS or compact in NEGATION_TOKENS:
            tokens.add(compact)
        elif raw[:1].isupper() and not raw.isupper():
            tokens.add(raw)
    return tokens


def _normalize_number_token(token):
    return NUMBER_WORDS.get(token, token)


def _match_key(token):
    return str(token).casefold().replace("'", "")


def _coerce_text(value):
    if value is None:
        return ""
    return str(value)
