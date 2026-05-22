#!/usr/bin/env python3
"""Parse saved Disney deck-plan HTML files into a single rooms.json."""
from __future__ import annotations
import html as html_lib
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
THEMES_FILE = RAW_DIR / "themes.html"
OUT_FILE = ROOT / "rooms.json"

ROOM_CATEGORIES = {"suite", "verandah", "outside", "oceanview", "inside", "concierge"}
ROOM_FLAGS = {"connecting-rooms", "accessible-rooms", "navigators-verandah"}
KEEP_SVG_CLASSES = ROOM_CATEGORIES | ROOM_FLAGS | {
    "room", "venue", "venueLabel", "inaccessible",
}

RE_MAIN_SVG = re.compile(
    r'<svg[^>]*viewBox="0 0 588 ([\d.]+)"[^>]*>([\s\S]*?)</svg>'
)
RE_SELECTED_DECK = re.compile(
    r'class="menu-item ng-scope[^"]*selected"\s+aria-selected="true"[^>]*>\s*'
    r'<a ui-sref="\{ deck : deck-(\d+) \}"'
)
RE_CANONICAL_SHIP = re.compile(
    r'rel="canonical"\s+href="[^"]*/ships/deck-plans/([a-z]+)'
)
RE_ROOM = re.compile(
    r'<(rect|path|polygon)\s+id="room-(\d+)"\s+([^>]*?)(?:/>|></(?:rect|path|polygon)>)'
)
RE_ATTR = re.compile(r'([\w-]+)="([^"]*)"')
RE_NG = re.compile(
    r'\s+(?:ng-class|ng-mouseenter|ng-mouseleave|ng-click|ng-show|ng-if|'
    r'ng-attr-[\w-]+|popover|popover-trigger|groupid)="[^"]*"'
)
RE_CLASS = re.compile(r'class="([^"]*)"')


def parse_attrs(s: str) -> dict[str, str]:
    return {k: html_lib.unescape(v) for k, v in RE_ATTR.findall(s)}


def parse_rooms(svg_inner: str) -> list[dict]:
    rooms = []
    for tag, room_id, attrs_str in RE_ROOM.findall(svg_inner):
        attrs = parse_attrs(attrs_str)
        room: dict = {"id": room_id, "shape": tag}
        if tag == "rect":
            room["x"] = float(attrs["x"])
            room["y"] = float(attrs["y"])
            room["w"] = float(attrs["width"])
            room["h"] = float(attrs["height"])
        elif tag == "polygon":
            pts_str = attrs.get("points", "").strip()
            room["points"] = pts_str
            xs, ys = [], []
            for pair in re.findall(r'(-?[\d.]+)[,\s]+(-?[\d.]+)', pts_str):
                xs.append(float(pair[0]))
                ys.append(float(pair[1]))
            if xs and ys:
                room["x"] = min(xs)
                room["y"] = min(ys)
                room["w"] = max(xs) - min(xs)
                room["h"] = max(ys) - min(ys)
        else:
            room["d"] = attrs.get("d", "")
        classes = (attrs.get("class") or "").split()
        room["categories"] = [c for c in classes if c in ROOM_CATEGORIES]
        room["flags"] = [c for c in classes if c in ROOM_FLAGS]
        rooms.append(room)
    return rooms


def strip_angular(svg_full: str) -> str:
    svg_full = RE_NG.sub("", svg_full)
    def keep_classes(m: re.Match) -> str:
        kept = [c for c in m.group(1).split()
                if c in KEEP_SVG_CLASSES or re.fullmatch(r"st\d+", c)]
        return f'class="{" ".join(kept)}"'
    return RE_CLASS.sub(keep_classes, svg_full)


def detect_selected_deck(html: str) -> int | None:
    m = RE_SELECTED_DECK.search(html)
    return int(m.group(1)) if m else None


def detect_ship(html: str) -> str:
    m = RE_CANONICAL_SHIP.search(html)
    return m.group(1) if m else "unknown"


RE_TABLE = re.compile(r'<table[^>]*>(.*?)</table>', re.DOTALL)
RE_TR = re.compile(r'<tr[^>]*>(.*?)</tr>', re.DOTALL)
RE_TD = re.compile(r'<t[dh][^>]*>(.*?)</t[dh]>', re.DOTALL)
RE_TAG = re.compile(r'<[^>]+>')

def parse_themes(html_path: Path) -> dict[str, dict]:
    """Parse the blog page tables → roomId -> {theme, categoryCode}."""
    if not html_path.exists():
        return {}
    html = html_path.read_text(encoding="utf-8")
    out: dict[str, dict] = {}
    for table_html in RE_TABLE.findall(html):
        for row_html in RE_TR.findall(table_html):
            cells = [
                html_lib.unescape(RE_TAG.sub("", c)).strip()
                for c in RE_TD.findall(row_html)
            ]
            if len(cells) < 3:
                continue
            room_id, theme, cat_code = cells[0], cells[1], cells[2]
            if not re.fullmatch(r"\d{4,5}", room_id):
                continue
            out[room_id] = {"theme": theme, "categoryCode": cat_code}
    return out


def extract_svg(html: str) -> tuple[str, str, int, float] | None:
    m = RE_MAIN_SVG.search(html)
    if not m:
        return None
    full = m.group(0)
    inner = m.group(2)
    vb_h = float(m.group(1))
    return full, inner, 588, vb_h


def main() -> int:
    files = sorted(
        (p for p in RAW_DIR.iterdir() if re.fullmatch(r"deck-\d+\.html", p.name)),
        key=lambda p: int(re.search(r"\d+", p.name).group()),
    )
    if not files:
        print(f"no deck-N.html files in {RAW_DIR}", file=sys.stderr)
        return 1

    themes = parse_themes(THEMES_FILE)
    if themes:
        print(f"loaded themes for {len(themes)} rooms from {THEMES_FILE.name}")
    else:
        print(f"(no themes file at {THEMES_FILE}; per-room theme/category code will be blank)")

    ship = None
    decks: list[dict] = []
    seen_decks: set[int] = set()
    theme_hits = 0
    for f in files:
        html = f.read_text(encoding="utf-8")
        file_deck = int(re.search(r"\d+", f.name).group())
        ship_in_file = detect_ship(html)
        if ship is None:
            ship = ship_in_file
        elif ship != ship_in_file:
            print(f"! {f.name}: ship mismatch ({ship_in_file} vs {ship})")
        selected = detect_selected_deck(html)
        if selected and selected != file_deck:
            print(f"! {f.name}: file named deck-{file_deck} but HTML "
                  f"selected deck is {selected}; using HTML value")
        deck_num = selected or file_deck
        if deck_num in seen_decks:
            print(f"! {f.name}: duplicate of deck {deck_num} already loaded, skipping")
            continue
        svg = extract_svg(html)
        if not svg:
            print(f"! {f.name}: no main SVG found, skipping")
            continue
        seen_decks.add(deck_num)
        svg_full, svg_inner, vbw, vbh = svg
        # Quick peek: if there are no rooms in this SVG, skip entirely
        # (service decks like Deck 8 have only the ship outline).
        if not RE_ROOM.search(svg_inner):
            print(f"  deck-{deck_num}: no rooms in SVG, skipping")
            continue
        rooms = parse_rooms(svg_inner)
        # Merge in theme + categoryCode from the blog data
        for r in rooms:
            t = themes.get(r["id"])
            if t:
                r["theme"] = t["theme"]
                r["categoryCode"] = t["categoryCode"]
                theme_hits += 1
        cat_counts: dict[str, int] = {}
        for r in rooms:
            for c in r["categories"]:
                cat_counts[c] = cat_counts.get(c, 0) + 1
        rect_n = sum(1 for r in rooms if r["shape"] == "rect")
        path_n = sum(1 for r in rooms if r["shape"] == "path")
        print(f"deck-{deck_num}: {len(rooms)} rooms "
              f"({rect_n} rect + {path_n} path), "
              f"viewBox {vbw}x{vbh}, categories: {cat_counts}")
        decks.append({
            "deck": deck_num,
            "viewBoxW": vbw,
            "viewBoxH": vbh,
            "svg": strip_angular(svg_full),
            "rooms": rooms,
        })

    decks.sort(key=lambda d: d["deck"])
    total_rooms = sum(len(d["rooms"]) for d in decks)
    all_cats: dict[str, int] = {}
    for d in decks:
        for r in d["rooms"]:
            for c in r["categories"]:
                all_cats[c] = all_cats.get(c, 0) + 1
    print(f"---\nship: {ship}, decks: {len(decks)}, total rooms: {total_rooms}")
    print(f"categories total: {all_cats}")
    if themes:
        print(f"theme matches: {theme_hits}/{total_rooms}")

    OUT_FILE.write_text(json.dumps({"ship": ship, "decks": decks}, indent=2))
    print(f"wrote {OUT_FILE} ({OUT_FILE.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
