#!/usr/bin/env python3
"""Verify the one-page site's indexability contract."""

from pathlib import Path
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://compressimageto20kb.online"
NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9"


def main() -> int:
    errors: list[str] = []
    index = (ROOT / "index.html").read_text(encoding="utf-8")
    robots = (ROOT / "robots.txt").read_text(encoding="utf-8")
    expected_url = f"{ORIGIN}/"
    expected_sitemap = f"Sitemap: {ORIGIN}/sitemap.xml"

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
    declarations = [line.strip() for line in robots.splitlines() if line.lower().startswith("sitemap:")]
    if declarations != [expected_sitemap]:
        errors.append(f"robots.txt expected exactly {expected_sitemap!r}, got {declarations!r}")

    if errors:
        print("Sitemap verification failed:")
        for error in errors:
            print(f"- {error}")
        return 1
    print("Sitemap verification passed: 1 canonical URL")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
