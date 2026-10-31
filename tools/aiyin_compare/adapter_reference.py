# -*- coding: utf-8 -*-
"""参考侧 adapter —— 读取自研方案（CardLayout/cardCorrectMl）经 bench_regress.py 落盘的 PNG 裁图。

输入：bench_regress.py --dump 生成的目录，形如
      <dumps_dir>/model__身份证正面/000_42108119890413556X.jpg.png
文件名格式：{idx:03d}_{safe(原图名)}.png，idx 为该图内卡序号（0 起）。

输出：{ (dir_tag, 原图名, idx): png_path }，供 harness 与官方侧按 (原图名, idx) 配对。
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List, Tuple


def _safe(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", name)[:120]


def load_reference(dumps_dir: Path, mode: str = "model") -> Dict[Tuple[str, str, int], Path]:
    """mode: model / cv。返回 {(dir_tag, orig_name, idx): Path}。"""
    ref: Dict[Tuple[str, str, int], Path] = {}
    for d in sorted(dumps_dir.iterdir()):
        m = re.match(rf"^{re.escape(mode)}__(.+)$", d.name)
        if not m or not d.is_dir():
            continue
        dir_tag = m.group(1)
        for f in sorted(d.iterdir()):
            if not f.name.lower().endswith(".png"):
                continue
            # 000_name.png
            mm = re.match(r"^(\d{3})_(.+)\.png$", f.name)
            if not mm:
                continue
            idx = int(mm.group(1))
            orig_name = mm.group(2)               # 原图名（含扩展名）
            ref[(dir_tag, orig_name, idx)] = f
    return ref


def ref_for_dir(ref: Dict[Tuple[str, str, int], Path], dir_tag: str, orig_name: str) -> List[Tuple[int, Path]]:
    """返回某图在该目录下的所有参考裁图 [(idx, path)]，按 idx 升序。"""
    items = [(k[2], ref[k]) for k in ref if k[0] == dir_tag and k[1] == orig_name]
    return sorted(items)


def list_dir_tags(dumps_dir: Path, mode: str = "model") -> List[str]:
    tags = []
    for d in sorted(dumps_dir.iterdir()):
        m = re.match(rf"^{re.escape(mode)}__(.+)$", d.name)
        if m and d.is_dir():
            tags.append(m.group(1))
    return tags
