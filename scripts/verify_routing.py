#!/usr/bin/env python3
"""Verify the Cloudflare Pages routing contract for authored URLs.

Cloudflare Pages redirects /x.html to /x (and /dir/index.html to /dir/). This
serves the repository through an equivalent local rung: every final route must
answer 200 with no Location header, every .html request must 308 to the final
extensionless URL, and each page's canonical, hreflang and og:url must name the
final URL. No CDN configuration is read or changed.
"""

from __future__ import annotations

import json
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.etree import ElementTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import site_routes  # noqa: E402

ROOT = site_routes.ROOT
ORIGIN = site_routes.ORIGIN
NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9"

CANONICAL = re.compile(r'<link href="([^"]+)" rel="canonical"/>')
ALTERNATE = re.compile(r'<link href="([^"]+)" hreflang="[^"]+" rel="alternate"/>')
OG_URL = re.compile(r'<meta content="([^"]+)" property="og:url"/>')
HREF = re.compile(r'(?:href|src)="([^"]+)"')
MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
    ".ico": "image/x-icon", ".png": "image/png", ".webmanifest": "application/manifest+json",
    ".txt": "text/plain; charset=utf-8", ".xml": "application/xml",
}


class PagesRung(BaseHTTPRequestHandler):
    """The documented Pages HTML behaviour, without a CDN control plane."""

    root = ROOT

    def log_message(self, *args):  # keep the proof output clean
        pass

    def do_HEAD(self):
        self.respond(head=True)

    def do_GET(self):
        self.respond(head=False)

    def respond(self, head: bool) -> None:
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)

        if path in site_routes.ROUTES:
            self.send_file(self.root / site_routes.ROUTES[path], head)
            return

        if path.endswith("/index.html"):
            final = path[: -len("index.html")]
        elif path.endswith(".html"):
            final = path[: -len(".html")]
        else:
            final = None
        if final is not None:
            if final in site_routes.ROUTES:
                self.send_response(308)
                self.send_header("Location", final)
                self.end_headers()
                return
            self.not_found(head)
            return

        candidate = (self.root / path.lstrip("/")).resolve()
        if candidate.is_relative_to(self.root.resolve()) and candidate.is_file() and candidate.suffix != ".html":
            self.send_file(candidate, head)
            return
        self.not_found(head)

    def send_file(self, target: Path, head: bool) -> None:
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def not_found(self, head: bool) -> None:
        body = (self.root / "404.html").read_bytes()
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        if not head:
            self.wfile.write(body)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch(base: str, path: str) -> tuple[int, dict[str, str], bytes]:
    opener = urllib.request.build_opener(NoRedirect)
    try:
        response = opener.open(base + path, timeout=10)
        return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


def main() -> int:
    errors: list[str] = []
    checks = 0
    cache: dict[str, tuple[int, dict[str, str], bytes]] = {}

    def check(condition: bool, message: str) -> None:
        nonlocal checks
        checks += 1
        if not condition:
            errors.append(message)

    def get(base: str, path: str) -> tuple[int, dict[str, str], bytes]:
        if path not in cache:
            cache[path] = fetch(base, path)
        return cache[path]

    try:
        sitemap = ElementTree.parse(ROOT / "sitemap.xml").getroot()
        locations = [
            (node.findtext(f"{{{NAMESPACE}}}loc") or "").strip()
            for node in sitemap.findall(f"{{{NAMESPACE}}}url")
        ]
    except (ElementTree.ParseError, OSError) as exc:
        print(f"Routing verification failed:\n- invalid sitemap.xml: {exc}")
        return 1

    server = ThreadingHTTPServer(("127.0.0.1", 0), PagesRung)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        # Every sitemap URL is already final: 200, no redirect, self-canonical.
        for loc in locations:
            check(loc.startswith(ORIGIN + "/") or loc == ORIGIN, f"sitemap URL is not canonical: {loc}")
            path = "/" if loc == ORIGIN else loc[len(ORIGIN):]
            status, headers, body = get(base, path)
            check(status == 200, f"{path}: expected 200 from Pages rung, got {status}")
            check("Location" not in headers, f"{path}: final sitemap URL still redirects to {headers.get('Location')}")
            html = body.decode("utf-8", "replace")
            canonical = CANONICAL.search(html)
            check(bool(canonical) and canonical.group(1) == loc,
                  f"{path}: canonical {canonical.group(1) if canonical else None!r} != final URL {loc}")
            og = OG_URL.search(html)
            check(bool(og) and og.group(1) == loc,
                  f"{path}: og:url {og.group(1) if og else None!r} != final URL {loc}")
            for alternate in ALTERNATE.findall(html):
                check(not alternate.endswith(".html"), f"{path}: hreflang points at a redirecting .html URL: {alternate}")
                alternate_path = alternate[len(ORIGIN):] if alternate.startswith(ORIGIN) else ""
                status, headers, _ = get(base, alternate_path or "/")
                check(status == 200 and "Location" not in headers,
                      f"{path}: hreflang alternate is not final: {alternate} ({status})")
            check(".html" not in html.split("<body", 1)[0],
                  f"{path}: <head> still authors a .html URL")

        # Every internal href/src on every route resolves to a final 200 URL.
        for route, relative in site_routes.ROUTES.items():
            html = (ROOT / relative).read_text(encoding="utf-8")
            markup = re.sub(r"<script.*?</script>", "", html, flags=re.DOTALL | re.IGNORECASE)
            for raw in set(HREF.findall(markup)):
                if raw.startswith(("#", "mailto:", "tel:", "data:", "javascript:")):
                    continue
                target = urllib.parse.urlsplit(urllib.parse.urljoin(ORIGIN + route, raw))
                if target.netloc != urllib.parse.urlsplit(ORIGIN).netloc:
                    continue
                path = target.path or "/"
                status, headers, _ = get(base, path)
                check(status == 200, f"{route}: internal link {raw} -> {path} returned {status}")
                check("Location" not in headers, f"{route}: internal link {raw} redirects to {headers.get('Location')}")
                check(not path.endswith(".html"), f"{route}: internal link {raw} still ends in .html")

        # The provider's .html -> extensionless redirect is what this fixes.
        samples = [route for route in site_routes.ROUTES if route.startswith("/guides/") and route.count("/") == 2][:3]
        for route in samples:
            status, headers, _ = get(base, route + ".html")
            check(status == 308, f"{route}.html: expected Pages 308, got {status}")
            check(headers.get("Location") == route,
                  f"{route}.html: expected Location {route}, got {headers.get('Location')}")
        status, headers, _ = get(base, "/index.html")
        check(status == 308 and headers.get("Location") == "/",
              f"/index.html: expected 308 -> /, got {status} -> {headers.get('Location')}")
        status, headers, _ = get(base, "/guides/index.html")
        check(status == 308 and headers.get("Location") == "/guides/",
              f"/guides/index.html: expected 308 -> /guides/, got {status} -> {headers.get('Location')}")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    if errors:
        print("Routing verification failed:")
        for error in errors:
            print(f"- {error}")
        return 1
    print(json.dumps({
        "status": "pass",
        "final_routes": len(locations),
        "checks": checks,
        "pages_rung": "200 final routes, no Location; .html -> extensionless 308",
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
