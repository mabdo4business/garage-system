#!/usr/bin/env python3
"""Export docs/roadmap.md and docs/decisions.md as JSON row files for the roadmap dashboard.

Usage:
  python3 export_roadmap.py --roadmap docs/roadmap.md --decisions docs/decisions.md --out <dir> [--source-time ISO]

Writes stories.json, decisions.json, position.json, housekeeping.json and changelog.json into <dir>.
Standard library only. Reads the Markdown tables by their header names, so new rows and new
stories are picked up without changing this script.
"""
import argparse
import datetime as dt
import json
import os
import re

STATUS = {
    "done": "Done",
    "done (unmerged)": "Committed",
    "in progress": "In progress",
    "blocked": "Blocked",
    "not started": "Not started",
    "proposed": "Proposed",
}


def clean(text):
    """Plain text for display: drop Markdown code ticks, bold and links."""
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = text.replace("`", "").replace("**", "")
    return text.strip()


def cells(line):
    parts = line.strip().strip("|").split("|")
    return [p.strip() for p in parts]


def tables(lines):
    """Yield (headings, header, rows, start_line) for each pipe table, with the headings above it."""
    headings = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            level = len(m.group(1))
            headings = {k: v for k, v in headings.items() if k < level}
            headings[level] = m.group(2).strip()
            i += 1
            continue
        if line.startswith("|") and i + 1 < len(lines) and re.match(r"^\|\s*:?-{3,}", lines[i + 1]):
            header = cells(line)
            rows = []
            j = i + 2
            while j < len(lines) and lines[j].startswith("|"):
                row = cells(lines[j])
                if len(row) < len(header):
                    row += [""] * (len(header) - len(row))
                rows.append(dict(zip(header, row)))
                j += 1
            yield dict(headings), header, rows
            i = j
            continue
        i += 1


def group_of(headings):
    h2 = headings.get(2, "")
    h3 = headings.get(3, "")
    if h2.startswith("Track A"):
        m = re.match(r"Increment (\d+)", h3)
        if m:
            n = int(m.group(1))
            return "A", f"Increment {n}", n, clean(h3.split("—", 1)[1].split("·")[0]) if "—" in h3 else ""
    if h2.startswith("Track B"):
        return "B", "Website", 10, "Public website"
    if h2.startswith("Track C") and h3.startswith("Phase C2"):
        return "C", "Portal", 11, "Customer portal (PWA)"
    if h2.startswith("Track D"):
        return "D", "Mobile app", 12, "Native mobile app"
    return None


def parse_stories(text):
    lines = text.splitlines()
    stories = []
    order = 0
    for headings, header, rows in tables(lines):
        if "ID" not in header or "Status" not in header:
            continue
        g = group_of(headings)
        if not g:
            continue
        track, group, group_order, group_name = g
        for r in rows:
            sid = clean(r.get("ID", ""))
            if not sid:
                continue
            raw = clean(r.get("Status", "")).lower()
            order += 1
            stories.append({
                "id": sid,
                "story": clean(r.get("Story", "")),
                "track": track,
                "group": group,
                "group_name": group_name,
                "group_order": group_order,
                "order": order,
                "size": clean(r.get("Size", "")),
                "needs": clean(r.get("Needs", "")).replace("—", "").strip(),
                "status": STATUS.get(raw, raw.capitalize() or "Not started"),
                "branch": clean(r.get("Branch", "")),
                "updated": clean(r.get("Updated", "")),
                "notes": clean(r.get("Notes", r.get("Scope", ""))),
                "split": False,
            })
    ids = {s["id"] for s in stories}
    for s in stories:
        # A story split into parts (I1-05 -> I1-05a, I1-05b) is counted through its parts only.
        s["split"] = any(o != s["id"] and re.fullmatch(re.escape(s["id"]) + r"[a-z]", o) for o in ids)
    return stories


def parse_decisions(text):
    out = []
    for headings, header, rows in tables(text.splitlines()):
        h2 = headings.get(2, "")
        if h2.startswith("Decided"):
            kind = "Decided"
        elif h2.startswith("Open"):
            kind = "Open"
        elif h2.startswith("Professional"):
            kind = "Verification"
        else:
            continue
        for r in rows:
            did = clean(r.get("ID", ""))
            if not did:
                continue
            if kind == "Decided":
                out.append({"id": did, "status": kind, "text": clean(r.get("Decision", "")),
                            "needed_before": "", "recommended": "", "date": clean(r.get("Date", "")),
                            "who": clean(r.get("Source", ""))})
            elif kind == "Open":
                out.append({"id": did, "status": kind, "text": clean(r.get("Question", "")),
                            "needed_before": clean(r.get("Needed before", "")),
                            "recommended": clean(r.get("Recommended default", "")), "date": "", "who": ""})
            else:
                out.append({"id": did, "status": kind, "text": clean(r.get("Who", "")),
                            "needed_before": clean(r.get("Blocks", "")), "recommended": "", "date": "", "who": ""})
    return out


def section(text, title):
    m = re.search(r"^##+ " + re.escape(title) + r".*?$(.*?)(?=^##? |\Z)", text, re.M | re.S)
    return m.group(1) if m else ""


def parse_position(text, source_time):
    body = section(text, "Current position")
    fields = {}
    for line in body.splitlines():
        if not line.startswith("- **"):
            continue
        for label, value in re.findall(r"\*\*([^*]+?):\*\*\s*(.*?)(?=\s*·\s*\*\*|$)", line):
            fields[label.strip().lower()] = clean(value)
    return [{
        "wave": fields.get("wave", ""),
        "increment": fields.get("increment", ""),
        "active_story": fields.get("active story", ""),
        "next_story": fields.get("next story", ""),
        "next_decision": fields.get("next decision needed", ""),
        "roadmap_saved_at": source_time,
        "exported_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
    }]


def parse_housekeeping(text):
    body = section(text, "Housekeeping")
    items = []
    for n, m in enumerate(re.finditer(r"^- \[( |x|X)\] (.*)$", body, re.M), 1):
        items.append({"n": n, "item": clean(m.group(2)), "done": m.group(1).lower() == "x"})
    return items


def parse_changelog(text):
    rows = []
    for headings, header, trs in tables(text.splitlines()):
        if headings.get(2, "").startswith("Change log"):
            for n, r in enumerate(trs, 1):
                rows.append({"n": n, "date": clean(r.get("Date", "")), "change": clean(r.get("Change", ""))})
    rows.sort(key=lambda r: (r["date"], r["n"]), reverse=True)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--roadmap", required=True)
    ap.add_argument("--decisions", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--source-time", default="", help="when roadmap.md was last saved (ISO 8601)")
    a = ap.parse_args()
    with open(a.roadmap, encoding="utf-8") as f:
        roadmap = f.read()
    with open(a.decisions, encoding="utf-8") as f:
        decisions = f.read()
    source_time = a.source_time or dt.datetime.fromtimestamp(
        os.path.getmtime(a.roadmap), dt.timezone.utc).replace(microsecond=0).isoformat()
    os.makedirs(a.out, exist_ok=True)
    outputs = {
        "stories.json": parse_stories(roadmap),
        "decisions.json": parse_decisions(decisions),
        "position.json": parse_position(roadmap, source_time),
        "housekeeping.json": parse_housekeeping(roadmap),
        "changelog.json": parse_changelog(roadmap),
    }
    for name, rows in outputs.items():
        if not rows:
            raise SystemExit(f"{name}: no rows found — the roadmap layout may have changed")
        with open(os.path.join(a.out, name), "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=1)
        print(f"{name}: {len(rows)} rows")


if __name__ == "__main__":
    main()
