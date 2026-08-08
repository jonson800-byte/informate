#!/usr/bin/env python3
"""
Informate T12 种子知识入库脚本（方案 B：后端直管 Hindsight API）
============================================================
从 Obsidian KB（~/Desktop/Informate KB/industries/医美/）解析知识条目，
批量写入 Hindsight bank informate-industry_医美（带 sub_industry 标记）。

用法: venv/bin/python seed_knowledge_to_hindsight.py [--dry-run] [--limit N]
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

KB = Path.home() / "Desktop/Informate KB/industries/医美"
BANK_ID = "informate-industry_医美"
API = f"http://localhost:9177/v1/default/banks/{urllib.parse.quote(BANK_ID, safe='')}/memories"
BATCH = 40  # 每批条目数（控制 LLM 提取成本与超时）
DRY_RUN = "--dry-run" in sys.argv
LIMIT = None
for a in sys.argv:
    if a.startswith("--limit="):
        LIMIT = int(a.split("=")[1])

def parse_terms(text: str) -> list[str]:
    """解析术语文件：'1. **名词**：定义。场景：用法'"""
    items = []
    for m in re.finditer(r"^\d+\. \*\*(.+?)\*\*[：:]\s*(.+)$", text, re.M):
        items.append(f"术语：**{m.group(1)}**：{m.group(2).strip()}")
    return items

def parse_faq(text: str) -> list[str]:
    """解析 FAQ 文件：'1. **Q：问题**' + '   A：回答'"""
    items = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        m = re.match(r"^\d+\. \*\*Q[：:]\s*(.+?)\*\*$", lines[i].strip())
        if m:
            q = m.group(1).strip()
            ans = ""
            j = i + 1
            while j < len(lines) and (lines[j].strip().startswith("A[：:]") or lines[j].strip().startswith("A:")):
                ans += lines[j].strip().lstrip("A:：").strip() + " "
                j += 1
            items.append(f"FAQ 问题：{q}\n参考回答：{ans.strip()}")
            i = j
        else:
            i += 1
    return items

def parse_sop(text: str) -> list[str]:
    """解析 SOP 文件：'## N. 标题' 块"""
    items = []
    blocks = re.split(r"^## \d+\.\s*", text, flags=re.M)
    for b in blocks[1:]:
        title, _, body = b.partition("\n")
        items.append(f"SOP：{title.strip()}\n{body.strip()[:600]}")
    return items

def collect() -> list[tuple[str, str, str]]:
    """返回 [(content, sub_industry, type)]"""
    entries = []
    for subdir in ["通用", "植发", "口腔", "皮肤", "整形", "光电"]:
        sub = subdir if subdir != "通用" else ""
        base = KB / subdir
        if not base.exists():
            continue
        for fname, parser, tname in [
            ("术语.md", parse_terms, "terms"),
            ("FAQ.md", parse_faq, "faq"),
            ("SOP.md", parse_sop, "sop"),
        ]:
            fp = base / fname
            if fp.exists():
                for item in parser(fp.read_text(encoding="utf-8")):
                    entries.append((item, sub, tname))
    return entries

def push_batch(items: list[dict]) -> bool:
    body = json.dumps({"items": items}).encode()
    req = urllib.request.Request(API, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read())
            return data.get("success", False)
    except Exception as e:
        print(f"  ❌ 批次失败: {e}")
        return False

def main():
    entries = collect()
    print(f"解析到 {len(entries)} 条知识条目")
    if LIMIT:
        entries = entries[:LIMIT]
        print(f"（--limit={LIMIT}，截断）")
    if DRY_RUN:
        for c, sub, t in entries[:5]:
            print(f"  样例 [{sub or '通用'}/{t}]: {c[:50]}...")
        print(f"DRY RUN：共 {len(entries)} 条，未写入")
        return

    total = len(entries)
    ok = 0
    for start in range(0, total, BATCH):
        batch = entries[start : start + BATCH]
        items = [
            {
                "content": c,
                "context": f"医美种子知识-{t}",
                "tags": ["informate", "medical", f"sub_industry:{sub}" if sub else "sub_industry:通用", t],
            }
            for c, sub, t in batch
        ]
        if push_batch(items):
            ok += len(batch)
            print(f"  ✅ {start+1}-{start+len(batch)}/{total} 写入成功")
        else:
            print(f"  ⚠️ {start+1}-{start+len(batch)} 失败，重试一次")
            time.sleep(2)
            if push_batch(items):
                ok += len(batch)
                print(f"  ✅ 重试成功 {start+1}-{start+len(batch)}")
        time.sleep(0.5)
    print(f"\n完成：{ok}/{total} 条入库 informate-industry_医美")

if __name__ == "__main__":
    main()
