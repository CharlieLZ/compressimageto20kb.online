#!/usr/bin/env python3
"""Verify the one-page site's indexability contract."""

import json
import re
from pathlib import Path
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://compressimageto20kb.online"
NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9"


def absolute_reference_errors(node: object, path: str = "json-ld") -> list[str]:
    """Every @id / url / item in the JSON-LD graph must be an absolute URL on this origin."""
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


def main() -> int:
    errors: list[str] = []
    index = (ROOT / "index.html").read_text(encoding="utf-8")
    robots = (ROOT / "robots.txt").read_text(encoding="utf-8")
    not_found_path = ROOT / "404.html"
    expected_url = f"{ORIGIN}/"
    expected_sitemap = f"Sitemap: {ORIGIN}/sitemap.xml"

    try:
        not_found = not_found_path.read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"missing top-level 404.html: {exc}")
        not_found = ""

    try:
        sitemap = ElementTree.parse(ROOT / "sitemap.xml").getroot()
        locations = [
            (node.findtext(f"{{{NAMESPACE}}}loc") or "").strip()
            for node in sitemap.findall(f"{{{NAMESPACE}}}url")
        ]
    except (ElementTree.ParseError, OSError) as exc:
        errors.append(f"invalid sitemap.xml: {exc}")
        locations = []

    if locations != [expected_url]:
        errors.append(f"sitemap must contain only the canonical homepage, got {locations!r}")
    if f'<link href="{expected_url}" rel="canonical"/>' not in index:
        errors.append("homepage is missing its absolute self-canonical")
    if 'content="index,follow' not in index:
        errors.append("homepage is not explicitly indexable")
    if f'<meta content="{expected_url}" property="og:url"/>' not in index:
        errors.append("og:url must be the absolute canonical homepage URL")
    blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', index, re.DOTALL)
    if not blocks:
        errors.append("homepage has no JSON-LD block")
    for block in blocks:
        try:
            errors.extend(absolute_reference_errors(json.loads(block)))
        except json.JSONDecodeError as exc:
            errors.append(f"invalid JSON-LD: {exc}")
    declarations = [line.strip() for line in robots.splitlines() if line.lower().startswith("sitemap:")]
    if declarations != [expected_sitemap]:
        errors.append(f"robots.txt expected exactly {expected_sitemap!r}, got {declarations!r}")
    if not_found:
        if '<meta name="robots" content="noindex,follow">' not in not_found:
            errors.append("404.html must be noindex,follow")
        if 'href="/"' not in not_found:
            errors.append("404.html must link back to the homepage")
        if 'rel="canonical"' in not_found:
            errors.append("404.html must not canonicalize missing URLs to the homepage")

    if errors:
        print("Sitemap verification failed:")
        for error in errors:
            print(f"- {error}")
        return 1
    print("Sitemap verification passed: 1 canonical URL")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
