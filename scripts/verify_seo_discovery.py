#!/usr/bin/env python3
"""Verify the discovery contract: robots.txt, llms.txt, llms-full.txt, sitemap.xml.

Usage: python3 scripts/verify_seo_discovery.py

Exit 0 = every contract below holds, 1 = at least one violation.

Contract (single change point: AI_CRAWLERS):
- robots.txt: one `*` group and one AI group; the AI group names every UA in
  AI_CRAWLERS and repeats the `*` group rules verbatim (RFC 9309: named groups
  do not inherit `*`); both groups explicitly allow /llms.txt and /llms-full.txt;
  no rule blocks render assets (/_next, *.js, *.css, *.json$); exactly one
  absolute Sitemap line; no Crawl-delay.
- llms.txt (llmstxt.org): single H1 first, blockquote summary, H2 file lists,
  `## Optional` last when present, 5-40 absolute canonical links and every link
  points at a real route or an existing in-page anchor.
- llms-full.txt: same H1 first, non-trivial body, no HTML, links resolve too.
- sitemap.xml: parses, canonical host only, only routes that exist on the page.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://compressimageto20kb.online"
HOST = "compressimageto20kb.online"
SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9"

# Single source of truth for the AI crawler group (ADR-B1): revert = delete this group.
AI_CRAWLERS = [
    "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User",
    "anthropic-ai", "Claude-Web", "PerplexityBot", "Perplexity-User", "Google-Extended", "GoogleOther",
    "Google-CloudVertexBot", "Applebot", "Applebot-Extended", "Meta-ExternalAgent", "Meta-ExternalFetcher",
    "Meta-WebIndexer", "FacebookBot", "Amazonbot", "CCBot", "Bytespider", "DuckAssistBot",
    "MistralAI-User", "cohere-ai", "cohere-training-data-crawler", "YouBot", "AI2Bot", "Diffbot",
    "Timpibot", "omgili", "Gemini-Deep-Research", "Google-NotebookLM", "GoogleAgent-URLContext",
    "DeepSeekBot", "ChatGLM-Spider", "DoubaoBot", "Kimi-SearchBot", "Kimi-User", "KimiBot", "QwenBot",
    "TongyiBot", "YiyanBot", "ERNIEBot", "PanguBot", "MistralAI-Index", "Amzn-SearchBot", "Bravebot",
    "PhindBot",
]

PRIVATE_PATHS = ["/cdn-cgi/"]
LLMS_PATHS = ["/llms.txt", "/llms-full.txt"]


def parse_robots(text: str) -> tuple[list[dict], list[str]]:
    """Group robots.txt directives; a new group starts on User-agent after a rule."""
    groups: list[dict] = []
    current: dict | None = None
    seen_rule = False
    sitemaps: list[str] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, value = (part.strip() for part in line.split(":", 1))
        key = key.lower()
        if key == "user-agent":
            if current is None or seen_rule:
                current = {"agents": [], "allow": [], "disallow": []}
                groups.append(current)
                seen_rule = False
            current["agents"].append(value)
        elif key in ("allow", "disallow") and current is not None:
            seen_rule = True
            current[key].append(value)
        elif key == "sitemap":
            sitemaps.append(value)
    return groups, sitemaps


def main() -> int:
    errors: list[str] = []

    def check(condition: bool, message: str) -> None:
        if not condition:
            errors.append(message)

    def read(name: str) -> str:
        try:
            return (ROOT / name).read_text(encoding="utf-8")
        except OSError as exc:
            errors.append(f"missing {name}: {exc}")
            return ""

    index = read("index.html")
    page_ids = set(re.findall(r'id="([A-Za-z][\w-]*)"', index))
    robots_text = read("robots.txt")
    groups, sitemaps = parse_robots(robots_text)

    star = next((g for g in groups if "*" in g["agents"]), None)
    ai_groups = [g for g in groups if any(ua in AI_CRAWLERS for ua in g["agents"])]
    check(star is not None, "robots.txt has no User-agent: * group")
    check(len(ai_groups) == 1, f"expected exactly one AI group, found {len(ai_groups)}")

    if star is not None and len(ai_groups) == 1:
        ai = ai_groups[0]
        named = [ua for ua in ai["agents"] if ua in AI_CRAWLERS]
        unknown = [ua for ua in ai["agents"] if ua not in AI_CRAWLERS]
        check(named == AI_CRAWLERS, f"AI group UA list differs from AI_CRAWLERS (missing={[u for u in AI_CRAWLERS if u not in named]}, extra={unknown})")
        check(
            sorted(set(ai["disallow"])) == sorted(set(star["disallow"]))
            and sorted(set(ai["allow"])) == sorted(set(star["allow"])),
            "AI group rules must repeat the * group verbatim (RFC 9309)",
        )
        check(sorted(set(star["disallow"])) == sorted(set(PRIVATE_PATHS)), f"* Disallow list should be exactly {PRIVATE_PATHS}, got {star['disallow']}")
        for path in LLMS_PATHS:
            check(path in star["allow"] and path in ai["allow"], f"{path} is not explicitly allowed in every group")
        blocked = [r for g in (star, ai) for r in g["disallow"] if any(path.startswith(r.rstrip("*$")) for path in LLMS_PATHS)]
        check(not blocked, f"llms files matched by a Disallow rule: {blocked}")
    for group in groups:
        for rule in group["disallow"]:
            check(not rule.startswith("/_next"), f"Disallow {rule} blocks render assets (/_next)")
            check(not re.search(r"\.(js|css)(\$)?$", rule), f"Disallow {rule} blocks CSS/JS")
            check(not rule.endswith(".json$"), f"Disallow {rule} blocks JSON (manifest/structured data)")
    check(sitemaps == [f"{ORIGIN}/sitemap.xml"], f"robots.txt must declare exactly {ORIGIN}/sitemap.xml, got {sitemaps!r}")
    check("crawl-delay" not in robots_text.lower(), "robots.txt must not set Crawl-delay")

    def link_targets(body: str, label: str) -> list[str]:
        links = re.findall(r"\[[^\]]+\]\((https?://[^)\s]+)\)", body)
        check(5 <= len(links) <= 40, f"{label}: expected 5-40 links, found {len(links)}")
        for url in links:
            check(url.startswith(f"{ORIGIN}/") or url == ORIGIN, f"{label}: link is not an absolute canonical URL: {url}")
            parsed = re.match(rf"^{re.escape(ORIGIN)}/(?:#([\w-]+))?$", url)
            check(parsed is not None, f"{label}: link points outside the single live route: {url}")
            if parsed and parsed.group(1):
                anchor = parsed.group(1)
                check(anchor in page_ids, f"{label}: anchor #{anchor} does not exist in index.html")
            check("?utm_" not in url and "?" not in url, f"{label}: tracking or query parameter in link: {url}")
        return links

    llms = read("llms.txt")
    llms_lines = [line for line in llms.splitlines()]
    first = next((line for line in llms_lines if line.strip()), "")
    check(first.startswith("# ") and len(first) > 3, f"llms.txt first line must be the H1, got {first[:60]!r}")
    check(sum(1 for line in llms_lines if line.startswith("# ")) == 1, "llms.txt must contain exactly one H1")
    check(any(line.startswith("> ") for line in llms_lines[:15]), "llms.txt is missing its blockquote summary")
    headings = [line[3:].strip() for line in llms_lines if line.startswith("## ")]
    check(len(headings) >= 2, f"llms.txt needs at least two H2 file lists, got {headings}")
    check("Optional" not in headings or headings[-1] == "Optional", "llms.txt `## Optional` must be the last section")
    check("<" not in llms, "llms.txt must not contain HTML tags")
    link_targets(llms, "llms.txt")

    full = read("llms-full.txt")
    full_first = next((line for line in full.splitlines() if line.strip()), "")
    check(full_first == first, f"llms-full.txt H1 must match llms.txt, got {full_first[:60]!r}")
    check(any(line.startswith("> ") for line in full.splitlines()[:15]), "llms-full.txt is missing its blockquote summary")
    check(len(full) > 800, f"llms-full.txt is too thin ({len(full)} chars)")
    check("<" not in full, "llms-full.txt must not contain HTML tags")
    link_targets(full, "llms-full.txt")

    try:
        tree = ElementTree.parse(ROOT / "sitemap.xml").getroot()
        locs = [(node.findtext(f"{{{SITEMAP_NS}}}loc") or "").strip() for node in tree.findall(f"{{{SITEMAP_NS}}}url")]
    except (ElementTree.ParseError, OSError) as exc:
        locs = []
        errors.append(f"invalid sitemap.xml: {exc}")
    check(locs == [f"{ORIGIN}/"], f"sitemap.xml must list only the canonical homepage, got {locs!r}")

    if errors:
        print("SEO discovery verification failed:")
        for error in errors:
            print(f"- {error}")
        return 1
    print(f"SEO discovery verification passed: robots groups parity, {len(AI_CRAWLERS)} AI crawlers, llms.txt + llms-full.txt links, canonical sitemap")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
