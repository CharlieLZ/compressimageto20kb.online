#!/usr/bin/env python3
"""Verify the multi-route indexability contract.

Checks:
- sitemap.xml lists exactly the routes that exist as static files
- the homepage keeps its approved title, description and H1
- every route has a self-canonical, indexable robots tag and one H1
- bilingual guides declare matching en / zh-Hans / x-default alternates
- structured data references are absolute and JSON-LD parses
- robots.txt declares exactly one sitemap and the 404 stays noindex
"""

import json
import re
import sys
from pathlib import Path
from xml.etree import ElementTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import site_routes  # noqa: E402

ROOT = site_routes.ROOT
ORIGIN = site_routes.ORIGIN
NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9"

HOME_TITLE = "Compress JPG to 20KB Online Free | PixelPress JPG Compressor"
HOME_DESCRIPTION = (
    "Compress JPG to 20KB online with PixelPress. Free browser-based JPG compressor "
    "with target-size presets, no login, no payment, and local image processing."
)
HOME_H1 = "Compress JPG to 20KB Online"


def absolute_reference_errors(node: object, path: str = "json-ld") -> list[str]:
    """Every @id / url / item in the JSON-LD graph must be absolute on this origin."""
    errors: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ("@id", "url", "item") and isinstance(value, str):
                if not value.startswith(f"{ORIGIN}/"):
                    errors.append(f"{path}.{key} must be absolute on {ORIGIN}, got {value!r}")
            else:
                errors.extend(absolute_reference_errors(value, f"{path}.{key}"))
    elif isinstance(node, list):
        for position, value in enumerate(node):
            errors.extend(absolute_reference_errors(value, f"{path}[{position}]"))
    return errors


def head_value(html: str, pattern: str) -> str:
    match = re.search(pattern, html, re.IGNORECASE | re.DOTALL)
    return match.group(1) if match else ""


def main() -> int:
    errors: list[str] = []

    def check(condition: bool, message: str) -> None:
        if not condition:
            errors.append(message)

    def read(path: str) -> str:
        try:
            return (ROOT / path).read_text(encoding="utf-8")
        except OSError as exc:
            errors.append(f"missing {path}: {exc}")
            return ""

    index = read("index.html")
    robots = read("robots.txt")
    not_found = read("404.html")
    expected = site_routes.expected_sitemap_urls()

    try:
        sitemap = ElementTree.parse(ROOT / "sitemap.xml").getroot()
        locations = [
            (node.findtext(f"{{{NAMESPACE}}}loc") or "").strip()
            for node in sitemap.findall(f"{{{NAMESPACE}}}url")
        ]
    except (ElementTree.ParseError, OSError) as exc:
        errors.append(f"invalid sitemap.xml: {exc}")
        locations = []

    check(len(locations) == len(set(locations)), "sitemap.xml contains duplicate URLs")
    check(set(locations) == set(expected),
          f"sitemap URLs differ from existing routes (missing={sorted(set(expected) - set(locations))}, extra={sorted(set(locations) - set(expected))})")

    # Homepage product invariants.
    check(re.search(rf"<title>{re.escape(HOME_TITLE)}</title>", index) is not None,
          "homepage title changed from the approved value")
    check(f'content="{HOME_DESCRIPTION}" name="description"' in index,
          "homepage meta description changed from the approved value")
    check(re.search(rf"<h1[^>]*>{re.escape(HOME_H1)}</h1>", index) is not None,
          "homepage H1 changed from the approved value")
    check(f'<link href="{ORIGIN}/" rel="canonical"/>' in index,
          "homepage is missing its absolute self-canonical")
    check('content="index,follow' in index, "homepage is not explicitly indexable")
    check(f'<meta content="{ORIGIN}/" property="og:url"/>' in index,
          "homepage og:url must be the absolute canonical homepage URL")
    declarations = [line.strip() for line in robots.splitlines() if line.lower().startswith("sitemap:")]
    check(declarations == [f"Sitemap: {ORIGIN}/sitemap.xml"],
          f"robots.txt expected exactly one sitemap declaration, got {declarations!r}")

    if not_found:
        check('<meta name="robots" content="noindex,follow">' in not_found,
              "404.html must be noindex,follow")
        check('href="/"' in not_found, "404.html must link back to the homepage")
        check('rel="canonical"' not in not_found,
              "404.html must not canonicalize missing URLs to the homepage")

    for route, relative in site_routes.ROUTES.items():
        path = ROOT / relative
        if not path.is_file():
            errors.append(f"route {route} maps to missing file {relative}")
            continue
        html = path.read_text(encoding="utf-8")
        expected_url = f"{ORIGIN}{route}"
        label = relative

        check(f'<link href="{expected_url}" rel="canonical"/>' in html,
              f"{label}: missing self-canonical {expected_url}")
        check('content="index,follow' in html, f"{label}: not explicitly indexable")
        check(len(re.findall(r"<h1[\s>]", html, re.IGNORECASE)) == 1,
              f"{label}: expected exactly one H1")
        check(len(head_value(html, r"<title>(.*?)</title>").strip()) >= 10,
              f"{label}: title is missing or too short")
        description = head_value(html, r'<meta content="([^"]*)" name="description"')
        check(50 <= len(description) <= 220, f"{label}: description length {len(description)} outside 50-220")

        for block in re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.DOTALL):
            try:
                errors.extend(f"{label}: {error}" for error in absolute_reference_errors(json.loads(block)))
            except json.JSONDecodeError as exc:
                errors.append(f"{label}: invalid JSON-LD: {exc}")

        if relative != "index.html":
            language = head_value(html, r'<html lang="([^"]+)"')
            if relative in ("guides/index.html", "zh/guides/index.html"):
                pair = "/zh/guides/" if relative == "guides/index.html" else "/guides/"
            elif relative.startswith("zh/"):
                check(language == "zh-Hans", f"{label}: language must be zh-Hans, got {language!r}")
                pair = "/guides/" + relative.removeprefix("zh/guides/")
            else:
                check(language == "en", f"{label}: language must be en, got {language!r}")
                pair = "/zh/guides/" + relative.removeprefix("guides/")
            pair_url = f"{ORIGIN}{pair}"
            check(f'hreflang="zh-Hans"' in html and f'hreflang="en"' in html and 'hreflang="x-default"' in html,
                  f"{label}: missing bilingual hreflang alternates")
            check(f'href="{pair_url}"' in html, f"{label}: missing alternate to {pair_url}")
            pair_file = site_routes.ROUTES.get(pair)
            check(bool(pair_file) and (ROOT / pair_file).is_file(), f"{label}: alternate route {pair} has no file")

    if errors:
        print("Sitemap verification failed:")
        for error in errors:
            print(f"- {error}")
        return 1
    print(f"Sitemap verification passed: {len(expected)} canonical routes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
