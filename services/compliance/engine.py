# -*- coding: utf-8 -*-
"""
Informate 合规引擎（T8）
========================
能力：
1. AC 自动机多关键词匹配（纯 Python 实现，零外部依赖，对齐 M1 toolgood_words 引擎能力）
2. 正则规则（贬低同行"比XX机构好"等句式的兜底）
3. 语境敏感规则（"第一"不误伤"第一条/第一次"、"术前术后"不误伤科普——M1 T6 修复经验）
4. 自动修正（fix 模式：命中词按位置替换为合规表述，如 根治→改善、100% 有效→效果因人而异）
5. 拦截（block 模式：医美红线命中即 blocked，不做自动改写，需人工审核）
6. 生图前置检查（image_prompt：违禁提示词拦截并说明，不产生扣费——FR-306/307）

设计对齐：
- 位置感知修复（M1 T7）：命中记录 start/end，倒序替换避免 str.replace 误伤豁免语境
- 重叠去重（M1）：区间重叠保留最长命中词（如"全国第一"包含"第一"→ 只报"全国第一"）
- 多轮修正（M1 fix_and_recheck）：修正→复查，残留违规 → 拦截人工
"""
from __future__ import annotations

import json
import re
from collections import deque
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from rule_packs import FIXES, PACK_VERSIONS, RULE_PACKS

MAX_FIX_ROUNDS = 3  # 自动修正最大轮次（对齐 M1 fix_and_recheck 的 max_rounds=2 语义，略放宽）


# ============================================================
# AC 自动机（多关键词同时扫描）
# ============================================================
class ACAutomaton:
    """AC 自动机：一次扫描返回全部关键词命中（含起止位置，半开区间 [start, end)）。"""

    def __init__(self, keywords: List[str]):
        self._trie: List[Dict[str, int]] = [{}]
        self._fail: List[int] = [0]
        self._out: List[List[str]] = [[]]
        for kw in keywords:
            self._insert(kw)
        self._build_fail()

    def _insert(self, kw: str) -> None:
        node = 0
        for ch in kw:
            nxt = self._trie[node].get(ch)
            if nxt is None:
                nxt = len(self._trie)
                self._trie[node][ch] = nxt
                self._trie.append({})
                self._fail.append(0)
                self._out.append([])
            node = nxt
        self._out[node].append(kw)

    def _build_fail(self) -> None:
        """BFS 构建失败指针；fail 节点命中词并入 out（最长后缀语义）。"""
        q: deque = deque()
        for ch, nxt in self._trie[0].items():
            self._fail[nxt] = 0
            q.append(nxt)
        while q:
            r = q.popleft()
            for ch, u in self._trie[r].items():
                q.append(u)
                f = self._fail[r]
                while f and ch not in self._trie[f]:
                    f = self._fail[f]
                self._fail[u] = self._trie[f].get(ch, 0)
                if self._out[self._fail[u]]:
                    self._out[u] = self._out[u] + self._out[self._fail[u]]

    def find_all(self, text: str) -> List[Tuple[int, int, str]]:
        """返回 [(start, end, keyword)]，半开区间，含重叠命中。"""
        hits: List[Tuple[int, int, str]] = []
        node = 0
        for i, ch in enumerate(text):
            while node and ch not in self._trie[node]:
                node = self._fail[node]
            node = self._trie[node].get(ch, 0)
            for kw in self._out[node]:
                hits.append((i - len(kw) + 1, i + 1, kw))
        return hits


# ============================================================
# 规则加载与归一化
# ============================================================
def _load_pack_overrides() -> Dict[str, List[Dict[str, Any]]]:
    """可选 JSON 外挂规则包：data/compliance_rules/<pack>.json。

    文件含 "rules" 数组时整体替换内置包（后台可配置规则内容，对齐 M1 compliance_rules 外挂点）。
    """
    overrides: Dict[str, List[Dict[str, Any]]] = {}
    rules_dir = Path(__file__).resolve().parent / "data" / "compliance_rules"
    if rules_dir.is_dir():
        for p in sorted(rules_dir.glob("*.json")):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(data, dict) and isinstance(data.get("rules"), list):
                    overrides[p.stem] = data["rules"]
            except Exception:
                pass  # 外挂包解析失败不阻塞，使用内置包
    return overrides


_OVERRIDES = _load_pack_overrides()


def _resolve_packs(pack_names: List[str]) -> List[Dict[str, Any]]:
    """按名称解析规则包（支持 JSON 外挂覆盖），并归一化规则字段。"""
    packs: List[Dict[str, Any]] = []
    for name in pack_names:
        rules = _OVERRIDES.get(name, RULE_PACKS[name])
        packs.extend(rules)
    return packs


# ============================================================
# 语境敏感判定（M1 T6：解决"第一"误伤清单体；本服务同样用于"术前术后"科普豁免）
# ============================================================
def _contextual_hit(text: str, start: int, end: int, ctx: Dict[str, Any]) -> bool:
    """命中词区间 [start, end)；判定优先级：
      1. 后缀豁免（清单体"第一条/第二点/第一次"、科普"注意事项/护理"）→ 不命中（除非有绝对化前缀）
      2. 后缀违规（"第一品牌/第一推荐"、术前术后+对比）→ 命中
      3. 绝对化前缀（"全国第一/行业第一"）→ 命中
      4. 其余裸词 → 不命中
    """
    after = text[end:end + ctx.get("suffix_window", 3)]
    before = text[max(0, start - ctx.get("prefix_window", 6)):start]
    prefix_abs = ctx.get("prefix_abs", [])

    # 1. 豁免后缀：先判断，避免"第一条/术前术后注意事项"误伤
    for safe in ctx.get("suffix_safe", []):
        if after.startswith(safe):
            # M3 修复（Codex 批次 B）：safe 命中后继续扫描后续文本是否有违规后缀——
            # 如"术前术后恢复期对比效果"：先见"恢复期"(safe)，后面还有"对比"(viol)，应拦截。
            # 扫描长度取最长违规后缀 2 倍 + safe 长度，覆盖窗口截断导致的漏检
            _max_viol = max((len(v) for v in ctx.get("suffix_violating", [])), default=0)
            _scan = text[end + len(safe): end + len(safe) + max(8, _max_viol * 2 + 2)]
            if any(v in _scan for v in ctx.get("suffix_violating", [])):
                return True
            if any(p in before for p in prefix_abs):
                return True
            return False
    # 2. 违规后缀
    for viol in ctx.get("suffix_violating", []):
        if after.startswith(viol):
            return True
    # 3. 绝对化前缀
    if any(p in before for p in prefix_abs):
        return True
    return False


# ============================================================
# 命中查找（AC 关键词 + 正则）+ 重叠去重
# ============================================================
_MATCHER_CACHE: Dict[Tuple[str, ...], Tuple[ACAutomaton, Dict[str, Dict[str, Any]]]] = {}


def _get_matcher(pack_names: List[str]):
    """规则相同则复用 AC 自动机（构建成本低但高频调用时值得缓存）。"""
    key = tuple(sorted(pack_names))
    cached = _MATCHER_CACHE.get(key)
    if cached is not None:
        return cached
    packs = _resolve_packs(list(key))
    keywords, meta, regex_rules = [], {}, []
    for rule in packs:
        for p in rule.get("patterns", []):
            keywords.append(p)
            # 逐词 fix：规则级 fix 优先，否则查 FIXES 表，未收录 → None（删除）
            meta[p] = dict(rule, fix=rule.get("fix") if rule.get("fix") is not None else FIXES.get(p))
        if rule.get("regex"):
            regex_rules.append(rule)
    ac = ACAutomaton(keywords)
    _MATCHER_CACHE[key] = (ac, meta, regex_rules, key)
    return _MATCHER_CACHE[key]


def _find_hits(text: str, pack_names: List[str], modes: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """返回命中列表：[{keyword, start, end, category, mode, fix, suggestion, reason}]。

    去重（对齐 M1）：区间重叠时保留最长命中词，避免修复时重叠替换错位。
    ``modes``：可选过滤（如生图前置只查 block 红线，M4 修复）。
    """
    ac, meta, regex_rules, _ = _get_matcher(pack_names)
    if modes is not None:
        meta = {k: v for k, v in meta.items() if v.get("mode") in modes}
        regex_rules = [r for r in regex_rules if r.get("mode") in modes]
    raw: List[Dict[str, Any]] = []
    for s, e, kw in ac.find_all(text):
        rule = meta.get(kw)
        if rule is None:
            continue  # M4：词被 mode 过滤（如生图只查 block），不处理
        if rule.get("context") and not _contextual_hit(text, s, e, rule["context"]):
            continue
        raw.append({
            "keyword": kw, "start": s, "end": e,
            "category": rule.get("category", "未分类"),
            "mode": rule.get("mode", "fix"),
            "fix": rule.get("fix"),
            "suggestion": rule.get("suggestion", ""),
            "reason": rule.get("reason", ""),
        })
    for rule in regex_rules:
        for m in re.finditer(rule["regex"], text):
            raw.append({
                "keyword": m.group(0), "start": m.start(), "end": m.end(),
                "category": rule.get("category", "未分类"),
                "mode": rule.get("mode", "fix"),
                "fix": rule.get("fix"),
                "suggestion": rule.get("suggestion", ""),
                "reason": rule.get("reason", ""),
            })
    # 重叠去重：按 (start, 词长降序) 排序，区间重叠时保留更长词
    raw.sort(key=lambda h: (h["start"], -(h["end"] - h["start"])))
    deduped: List[Dict[str, Any]] = []
    last_end = -1
    for h in raw:
        if h["start"] >= last_end:
            deduped.append(h)
            last_end = h["end"]
    return deduped


def _build_reason(hits: List[Dict[str, Any]], image: bool = False) -> str:
    """汇总拦截原因（去重，含法规依据与处理指引）。"""
    seen: List[str] = []
    for h in hits:
        r = h["reason"] or f"{h['category']}：{h['suggestion'] or '需人工审核'}"
        if r not in seen:
            seen.append(r)
    base = "；".join(seen)
    if image:
        return base + "（违禁提示词已拦截，未产生扣费，FR-306）"
    return base + "（命中合规红线，需人工审核后处理）"


# ============================================================
# 对外检查接口
# ============================================================
def check_text(text: str, pack_names: List[str]) -> Dict[str, Any]:
    """文本合规检查 + 自动修正（FR-204）。

    逻辑（对齐 M1 fix_and_recheck 判定权威）：
      1. 命中 block 规则（医美红线）→ 整体拦截：passed=False / blocked=True，不做部分修正
      2. 命中 fix 规则 → 按位置倒序替换为合规表述，记录 fixes[]
      3. 修正后复查（最多 MAX_FIX_ROUNDS 轮），残留违规 → 拦截人工
    """
    current = text
    all_fixes: List[Dict[str, Any]] = []
    for _ in range(MAX_FIX_ROUNDS):
        hits = _find_hits(current, pack_names)
        if not hits:
            return {"passed": True, "fixes": all_fixes, "fixed_text": current,
                    "blocked": False, "reason": None}
        if any(h["mode"] == "block" for h in hits):
            # 拦截优先：不做部分修正（整体不通过，人工处理）
            return {"passed": False, "fixes": [], "fixed_text": None,
                    "blocked": True, "reason": _build_reason(hits)}
        # fix 模式：倒序替换（位置基于 current，倒序保证替换安全）
        next_text = current
        round_hits = 0
        for h in sorted(hits, key=lambda x: x["start"], reverse=True):
            before = current[h["start"]:h["end"]]
            after = h["fix"] if h["fix"] is not None else ""
            next_text = next_text[:h["start"]] + after + next_text[h["end"]:]
            all_fixes.append({
                "keyword": h["keyword"], "category": h["category"],
                "before": before, "after": after,
                "start": h["start"], "end": h["end"],
            })
            round_hits += 1
        # H4 修复（Codex 批次 B）：本轮无实际变化（身份映射/替换后仍命中）→ 停止，避免死循环
        if next_text == current:
            return {"passed": False, "fixes": all_fixes, "fixed_text": current,
                    "blocked": True,
                    "reason": "自动修正无进展（存在无法自动替换的违规表述），需人工审核处理"}
        current = next_text
    # 多轮修正后仍有残留 → 拦截人工
    residual = _find_hits(current, pack_names)
    if residual:
        return {"passed": False, "fixes": all_fixes, "fixed_text": current,
                "blocked": True,
                "reason": "多次自动修正后仍存在违规表述，需人工审核处理"}
    return {"passed": True, "fixes": all_fixes, "fixed_text": current,
            "blocked": False, "reason": None}


def check_image_prompt(prompt: str, pack_names: List[str]) -> Dict[str, Any]:
    """生图前置合规检查（FR-306/307）：违禁提示词拦截并说明，不产生扣费。

    与文本不同：提示词不做自动改写（改写会改变用户生成意图），命中即整体拦截。
    """
    hits = _find_hits(prompt, pack_names, modes=["block"])  # M4：生图只查 block 红线（medical），general fix 词不拦截
    if hits:
        return {"passed": False, "fixes": [], "fixed_text": None,
                "blocked": True, "reason": _build_reason(hits, image=True)}
    return {"passed": True, "fixes": [], "fixed_text": None,
            "blocked": False, "reason": None}


def ruleset_version_of(pack_names: List[str]) -> str:
    """规则包版本号（版本锁定防漂移，M11 对齐）。"""
    return "+".join(f"{p}-{PACK_VERSIONS[p]}" for p in sorted(pack_names))
