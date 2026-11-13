#!/usr/bin/env python3
"""Verify the bilingual guide contract.

- 10 English and 10 Simplified Chinese guides with identical slugs
- at least 1000 English prose words per guide, excluding tools, tables,
  navigation, related links and CTA blocks
- at least 1000 Han characters per Chinese guide under the same exclusions
- every guide embeds a working tool and loads /guides/tools.js
- unique titles and descriptions across the guide set
"""

import html
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import site_routes  # noqa: E402

ROOT = site_routes.ROOT
ARTICLE = re.compile(r'<article class="article".*?</article>', re.DOTALL)
WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9'-]*")
HAN = re.compile(r"[\u4e00-\u9fff]")


def prose(markup: str) -> str:
    text = ARTICLE.search(markup).group(0) if ARTICLE.search(markup) else ""
    text = re.sub(r'<div class="gtool".*?(?=<script|<h2|<p)', "", text, flags=re.DOTALL)
    text = re.sub(r"<table.*?</table>", "", text, flags=re.DOTALL)
    text = re.sub(r'<div class="related".*?</div>', "", text, flags=re.DOTALL)
    text = re.sub(r'<div class="cta-band".*?</div>', "", text, flags=re.DOTALL)
    text = re.sub(r"<script.*?</script>", "", text, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    return html.unescape(text)


def meta(markup: str, pattern: str) -> str:
    match = re.search(pattern, markup, re.IGNORECASE | re.DOTALL)
    return match.group(1).strip() if match else ""


def main() -> int:
    errors: list[str] = []
    en_files = sorted(p for p in (ROOT / "guides").glob("*.html") if p.name != "index.html")
    zh_files = sorted(p for p in (ROOT / "zh/guides").glob("*.html") if p.name != "index.html")

    if len(en_files) != 10:
        errors.append(f"expected 10 English guides, found {len(en_files)}")
    if len(zh_files) != 10:
        errors.append(f"expected 10 Chinese guides, found {len(zh_files)}")
    if {p.name for p in en_files} != {p.name for p in zh_files}:
        errors.append("English and Chinese guide slugs do not pair")

    titles: dict[str, str] = {}
    descriptions: dict[str, str] = {}
    counts: dict[str, dict[str, int]] = {}

    for path, language in [(p, "en") for p in en_files] + [(p, "zh") for p in zh_files]:
        markup = path.read_text(encoding="utf-8")
        text = prose(markup)
        words = len(WORD.findall(text))
        han = len(HAN.findall(text))
        key = f"{'zh' if language == 'zh' else 'en'}/{path.name}"
        counts[key] = {"words": words, "han": han}

        if language == "en" and words < 1000:
            errors.append(f"{key}: {words} English prose words, need at least 1000")
        if language == "zh" and han < 1000:
            errors.append(f"{key}: {han} Han characters, need at least 1000")
        if "data-tool=" not in markup:
            errors.append(f"{key}: no embedded tool")
        if "/guides/tools.js" not in markup:
            errors.append(f"{key}: tools.js is not loaded")
        if len(re.findall(r"<h2[\s>]", markup, re.IGNORECASE)) < 5:
            errors.append(f"{key}: fewer than five H2 sections")
        title = meta(markup, r"<title>(.*?)</title>")
        description = meta(markup, r'<meta content="([^"]*)" name="description"')
        if title in titles:
            errors.append(f"duplicate title: {key} and {titles[title]}")
        if description in descriptions:
            errors.append(f"duplicate description: {key} and {descriptions[description]}")
        titles[title] = key
        descriptions[description] = key

    if errors:
        print("Guide verification failed:")
        for error in errors:
            print(f"- {error}")
        return 1
    print(json.dumps({"status": "pass", "en_guides": len(en_files), "zh_guides": len(zh_files), "counts": counts}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
