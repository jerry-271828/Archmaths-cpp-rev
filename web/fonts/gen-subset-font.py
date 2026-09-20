#!/usr/bin/env python3
"""Generate web/fonts/DejaVuSans-subset.ttf, the replacement font that
web/patch-wasm-font.py writes into ArchMaths.wasm.

The font is a merge of:
  - HarmonyOS Sans SC (from a HarmonyOS system's /system/fonts), subset to
    the characters the app uses plus as many GB2312 level-1 hanzi as fit
  - Noto Sans Symbols 2, for the few symbols the main font lacks (⏸ ▶ 👁)

Its internal family name is "DejaVu Sans" so Qt's wasm font database treats
it as the drop-in replacement for the embedded DejaVuSans.ttf resource.

Requires: fontTools (pip install fonttools), and the two source fonts.
Usage:
    python3 web/fonts/gen-subset-font.py \
        [/system/fonts/HarmonyOS_Sans_SC.ttf] \
        [/system/fonts/NotoSansSymbols2-Regular.ttf]
"""
import os
import sys

from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.merge import Merger

MAX_SIZE = 757076  # size of the embedded DejaVuSans.ttf slot in the wasm
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
OUT = os.path.join(os.path.dirname(__file__), "DejaVuSans-subset.ttf")

MAIN_FONT = sys.argv[1] if len(sys.argv) > 1 else "/system/fonts/HarmonyOS_Sans_SC.ttf"
SYMBOLS_FONT = sys.argv[2] if len(sys.argv) > 2 else "/system/fonts/NotoSansSymbols2-Regular.ttf"


def source_chars():
    """Every non-ASCII character literally used in the app sources."""
    chars = set()
    for sub in ("src", "include"):
        for dirpath, _, files in os.walk(os.path.join(ROOT, sub)):
            for f in files:
                if f.endswith((".cpp", ".h", ".hpp", ".ui")):
                    with open(os.path.join(dirpath, f), encoding="utf-8", errors="ignore") as fh:
                        chars |= {c for c in fh.read() if ord(c) > 0x7F}
    return chars


def rng(a, b):
    return {chr(c) for c in range(a, b + 1)}


BASE = (
    set(chr(c) for c in range(0x20, 0x7F))          # ASCII
    | source_chars()
    | rng(0x0391, 0x03C9)   # Greek
    | rng(0x2070, 0x209C)   # super/subscripts
    | rng(0x2190, 0x21FF)   # arrows
    | rng(0x2200, 0x22FF)   # math operators
    | rng(0x3000, 0x303F)   # CJK punctuation
    | rng(0xFF00, 0xFF65)   # fullwidth forms
    | {"⏸", "▶", "👁", "…", "—", "–", "“", "”", "‘", "’", "《", "》"}
)

LEVEL1 = []  # GB2312 level-1 hanzi, in encoding order
for hi in range(0xB0, 0xD8):
    for lo in range(0xA1, 0xFF):
        try:
            LEVEL1.append(bytes([hi, lo]).decode("gb2312"))
        except UnicodeDecodeError:
            pass


def build(n):
    text = "".join(sorted(BASE | set(LEVEL1[:n])))

    def make_subset(src, dst):
        opts = subset.Options()
        opts.name_IDs = [1, 2, 4, 6]
        opts.name_legacy = False
        opts.name_languages = [0x409]
        opts.hinting = False
        opts.layout_features = []
        opts.glyph_names = False
        opts.drop_tables += ["DSIG", "GSUB", "GDEF", "fvar", "gvar",
                             "STAT", "avar", "cvar", "HVAR", "MVAR"]
        font = TTFont(src, lazy=True)
        ss = subset.Subsetter(options=opts)
        ss.populate(text=text)
        ss.subset(font)
        font.save(dst)
        font.close()

    main_ttf = OUT + ".main.tmp"
    sym_ttf = OUT + ".sym.tmp"
    make_subset(MAIN_FONT, main_ttf)
    make_subset(SYMBOLS_FONT, sym_ttf)
    merged = Merger().merge([main_ttf, sym_ttf])
    os.unlink(main_ttf)
    os.unlink(sym_ttf)

    name = merged["name"]
    name.removeNames()
    for nid, val in ((1, "DejaVu Sans"), (2, "Regular"),
                     (4, "DejaVu Sans"), (6, "DejaVuSans")):
        name.setName(val, nid, 3, 1, 0x409)
        name.setName(val, nid, 1, 0, 0)
    merged.save(OUT)
    return os.path.getsize(OUT)


def main():
    lo, hi, best = 0, len(LEVEL1), 0
    while lo <= hi:
        mid = (lo + hi) // 2
        size = build(mid)
        print(f"n={mid} -> {size} bytes")
        if size <= MAX_SIZE:
            best = mid
            lo = mid + 1
        else:
            hi = mid - 1
    size = build(best)
    print(f"wrote {OUT}: {size} bytes, {best} level-1 hanzi + {len(BASE)} base chars")


if __name__ == "__main__":
    main()
