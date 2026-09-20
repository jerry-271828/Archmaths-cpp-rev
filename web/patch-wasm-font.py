#!/usr/bin/env python3
"""Patch the Qt 6.5 wasm build of ArchMaths: replace the embedded
DejaVuSans.ttf resource with our own subset font (same family name
"DejaVu Sans", but covering Simplified Chinese and math symbols).

Why this exists: Qt 6.5's wasm platform plugin only loads fonts
synchronously from the embedded resources (":/fonts/..."). Its
Local Font Access path is asynchronous AND never invalidates the
font fallback cache, so any font registered after startup is never
picked up for text that was already shaping as boxes. Replacing the
embedded font sidesteps both problems.

The font data lives in the wasm data section, split across many
segments. Segments never cover zero-filled regions, so writing a new
font back requires appending a few small segments that fill the holes.

Usage:
    python3 web/patch-wasm-font.py <path-to-ArchMaths.wasm> <path-to-new-font.ttf>

The new font must:
  - carry the internal family name "DejaVu Sans"
  - be at most 757076 bytes (the size of the embedded DejaVuSans.ttf)
"""
import struct
import sys


def uleb_decode(buf, p):
    r = 0
    s = 0
    while True:
        b = buf[p]
        p += 1
        r |= (b & 0x7F) << s
        if not (b & 0x80):
            break
        s += 7
    return r, p


def uleb(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        out.append(b | 0x80 if v else b)
        if not v:
            break
    return bytes(out)


def sleb(v):
    # signed LEB128, as required for i32.const immediates
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if (v == 0 and not (b & 0x40)) or (v == -1 and (b & 0x40)):
            out.append(b)
            break
        out.append(b | 0x80)
    return bytes(out)


def find_data_section(data):
    p = 8  # skip wasm magic + version
    while p < len(data):
        sec_id = data[p]
        hdr = p
        p += 1
        sec_len, q = uleb_decode(data, p)
        if sec_id == 11:
            return hdr, q, sec_len
        p = q + sec_len
    raise RuntimeError("no data section found")


def parse_segments(data, body_off):
    p = body_off
    count, p = uleb_decode(data, p)
    segs = []
    for _ in range(count):
        flags, p = uleb_decode(data, p)
        if flags != 0:
            raise RuntimeError("passive data segments not supported")
        if data[p] != 0x41:  # i32.const
            raise RuntimeError("unexpected offset expression")
        p += 1
        addr, p = uleb_decode(data, p)
        if data[p] != 0x0B:  # end
            raise RuntimeError("unexpected offset expression")
        p += 1
        size, p = uleb_decode(data, p)
        segs.append((addr, p, size))  # (memory address, payload file offset, size)
        p += size
    return count, segs


def main():
    wasm_path, font_path = sys.argv[1], sys.argv[2]
    data = bytearray(open(wasm_path, "rb").read())
    font = open(font_path, "rb").read()

    hdr, body, body_size = find_data_section(data)
    count, segs = parse_segments(data, body)

    # Build the initial memory image so we can locate the embedded font.
    mem_hi = max(a + s for a, _, s in segs)
    mem = bytearray(mem_hi)
    for a, off, s in segs:
        mem[a:a+s] = data[off:off+s]

    # Locate the embedded DejaVuSans.ttf by its table directory.
    anchor, slot_size = open_font_anchor(mem)
    if bytes(mem[anchor:anchor+4]) != b"\x00\x01\x00\x00":
        raise RuntimeError("anchor does not look like a TTF header")
    if len(font) > slot_size:
        raise RuntimeError(f"new font is {len(font)} bytes, slot is {slot_size}")
    payload = font + b"\0" * (slot_size - len(font))

    # 1) Overwrite, in place, the payload bytes of every segment that
    #    overlaps the slot.
    covered = bytearray(slot_size)
    for a, foff, s in segs:
        lo = max(a, anchor)
        hi = min(a + s, anchor + slot_size)
        if lo < hi:
            data[foff + (lo - a): foff + (hi - a)] = payload[lo - anchor: hi - anchor]
            covered[lo - anchor: hi - anchor] = b"\x01" * (hi - lo)

    # 2) Segments never cover zero runs of the original font, so append
    #    small new segments for the holes our font has data in.
    new_seg_blobs = []
    i = 0
    while i < slot_size:
        if covered[i]:
            i += 1
            continue
        j = i
        while j < slot_size and not covered[j]:
            j += 1
        blob = payload[i:j]
        new_seg_blobs.append(
            uleb(0) + b"\x41" + sleb(anchor + i) + b"\x0B" + uleb(len(blob)) + blob)
        i = j

    # 3) Rewrite the data section header with the new segment count.
    old_body = bytes(data[body: body + body_size])
    cnt_len = len(uleb(count))
    new_body = uleb(count + len(new_seg_blobs)) + old_body[cnt_len:] + b"".join(new_seg_blobs)
    new_section = b"\x0B" + uleb(len(new_body)) + new_body
    out = data[:hdr] + new_section + data[body + body_size:]
    open(wasm_path, "wb").write(out)
    print(f"patched {wasm_path}: font slot at memory {hex(anchor)}, "
          f"{len(new_seg_blobs)} hole-filling segments added")


def open_font_anchor(mem):
    """Find the embedded DejaVuSans.ttf inside the memory image.

    The font is identified by its table directory: 20 known sfnt tables in a
    fixed order, followed by the name table containing "DejaVu Sans".
    """
    sig = "DejaVu Sans".encode("utf-16-be")
    mem = bytes(mem)
    pos = mem.find(sig)
    while pos >= 0:
        # Scan backwards for the sfnt header whose table range contains the name.
        for cand in range(pos - 4, max(0, pos - 800000), -4):
            if mem[cand:cand+4] != b"\x00\x01\x00\x00":
                continue
            num = struct.unpack(">H", mem[cand+4:cand+6])[0]
            if not (5 <= num <= 64):
                continue
            sr, es, rsh = struct.unpack(">HHH", mem[cand+6:cand+12])
            p2 = 1
            while p2 * 2 <= num:
                p2 *= 2
            if sr != p2 * 16 or es != (p2.bit_length() - 1) or rsh != num * 16 - p2 * 16:
                continue
            end = 0
            ok = True
            for i in range(num):
                off = cand + 12 + i * 16
                toff, tlen = struct.unpack(">II", mem[off+8:off+16])
                if toff % 4 or tlen == 0 or tlen > 20000000:
                    ok = False
                    break
                end = max(end, toff + tlen)
            if ok and cand <= pos < cand + end:
                return cand, end
        pos = mem.find(sig, pos + 1)
    raise RuntimeError("embedded DejaVuSans.ttf header not found")


if __name__ == "__main__":
    main()
