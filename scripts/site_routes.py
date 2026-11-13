"""Single source of truth for the public routes that must exist as static files.

Both discovery verifiers import this so a new page cannot be added to the code
without being reflected in sitemap.xml, and a sitemap URL cannot point at a
missing file.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://compressimageto20kb.online"

# URL path -> repository-relative file path. Directory URLs map to index.html.
ROUTES: dict[str, str] = {
    "/": "index.html",
    "/guides/": "guides/index.html",
    "/zh/guides/": "zh/guides/index.html",
}

for directory, prefix in (("guides", "/guides/"), ("zh/guides", "/zh/guides/")):
    for path in sorted((ROOT / directory).glob("*.html")):
        if path.name == "index.html":
            continue
        ROUTES[f"{prefix}{path.name}"] = f"{directory}/{path.name}"


def absolute(path: str) -> str:
    return ORIGIN + path


def expected_sitemap_urls() -> list[str]:
    return [absolute(path) for path in ROUTES]


def resolves(url: str) -> bool:
    """True when an absolute URL on this origin maps to an existing route."""
    if not url.startswith(ORIGIN + "/"):
        return False
    path = url[len(ORIGIN):]
    target = ROUTES.get(path)
    return bool(target) and (ROOT / target).is_file()
