"""Rebuild the standalone offline HTML from the complete editable source files."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
html = (ROOT / "interface.html").read_text(encoding="utf-8")
for marker, filename in (
    ("__ENGINE__", "analyzer_engine.js"),
    ("__VIEWER__", "viewer.js"),
    ("__APP__", "app.js"),
):
    html = html.replace(marker, (ROOT / filename).read_text(encoding="utf-8"))
(ROOT / "STL_Strength_Analyzer.html").write_text(html, encoding="utf-8")
print("Built STL_Strength_Analyzer.html")
