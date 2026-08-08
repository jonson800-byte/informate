# -*- coding: utf-8 -*-
"""
Informate 合规服务 单元测试（T8）
=================================
覆盖（>=10 用例）：
1. general 修正：根治→改善、100% 有效→效果因人而异、绝对化用语（全网最低）
2. general 语境敏感："第一条"不误伤、"全国第一"命中修正
3. medical 拦截：无痛无痕 / 治愈率 / 前后对比（文本）
4. 生图前置检查：前后对比提示词 → blocked（FR-306/307）
5. 正常通过：合规文案 passed
6. 规则包选择：仅 general 时 medical 词不拦截
7. FR-209 提示：GET 缺省文案 + PUT 可配置 + 超长校验

运行：cd services/compliance && ../.venv/bin/python -m pytest tests/ -v
"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# 使测试可直接 import 服务模块（services/compliance 目录）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from main import DEFAULT_HINT, app  # noqa: E402

client = TestClient(app)

ALL_PACKS = ["general", "medical"]


def _check_text(text, packs=ALL_PACKS):
    return client.post("/check", json={"text": text, "rule_packs": packs}).json()


def _check_image(prompt, packs=ALL_PACKS):
    return client.post("/check", json={"image_prompt": prompt, "rule_packs": packs}).json()


# ============================================================
# 1. general 修正
# ============================================================
def test_general_fix_根治():
    """『根治』应自动修正为『改善』（任务示例映射）。"""
    r = _check_text("本方案可根治脱发问题")
    assert r["passed"] is True
    assert r["blocked"] is False
    assert any(f["keyword"] == "根治" and f["after"] == "改善" for f in r["fixes"])
    assert "改善" in r["fixed_text"] and "根治" not in r["fixed_text"]


def test_general_fix_100有效():
    """『100% 有效』应自动修正为『效果因人而异』（任务示例映射）。"""
    r = _check_text("我们的产品 100% 有效")
    assert r["passed"] is True
    assert any(f["after"] == "效果因人而异" for f in r["fixes"])
    assert "效果因人而异" in r["fixed_text"]


def test_general_fix_绝对化用语():
    """绝对化用语『全网最低』自动修正为『实惠』。"""
    r = _check_text("全网最低价，快来抢")
    assert r["passed"] is True
    assert any(f["keyword"] == "全网最低" and f["after"] == "实惠" for f in r["fixes"])
    assert "全网最低" not in r["fixed_text"]


# ============================================================
# 2. general 语境敏感（M1 T6 修复经验）
# ============================================================
def test_general_语境_第一条不误伤():
    """清单体『第一条』不误伤（语境豁免）。"""
    r = _check_text("请查看第一条规则")
    assert r["passed"] is True
    assert r["fixes"] == []
    assert r["fixed_text"] == "请查看第一条规则"


def test_general_语境_全国第一命中():
    """『全国第一』带绝对化前缀 → 命中并修正为『全国领先』。"""
    r = _check_text("我们是全国第一品牌")
    assert r["passed"] is True
    assert r["fixes"]  # 有修正
    assert "全国领先" in r["fixed_text"]


# ============================================================
# 3. medical 拦截（文本）
# ============================================================
def test_medical_拦截_无痛无痕():
    """医美红线『无痛无痕』→ 拦截，不做自动改写。"""
    r = _check_text("无痛无痕除皱，安全放心")
    assert r["passed"] is False
    assert r["blocked"] is True
    assert r["fixes"] == []
    assert r["reason"] and "无痛无痕" in r["reason"]


def test_medical_拦截_治愈率():
    """数字承诺『治愈率 98%』→ 拦截（执法指南负面清单）。"""
    r = _check_text("本机构植发治愈率 98%")
    assert r["passed"] is False
    assert r["blocked"] is True
    assert "治愈率" in r["reason"]


def test_medical_拦截_前后对比文本():
    """文本含『术前术后对比』→ 拦截。"""
    r = _check_text("展示患者术前术后对比效果")
    assert r["blocked"] is True
    assert "对比照" in r["reason"]  # 依据文案：『术前/术后对比照』（执法指南禁令）


def test_medical_拦截_贬低同行正则():
    """句式『比XX机构技术好』（正则规则）→ 拦截。"""
    r = _check_text("我们比对面机构技术好")
    assert r["blocked"] is True
    assert "贬低" in r["reason"]


def test_medical_语境_术前术后科普不误伤():
    """『术前术后注意事项』（科普语境）不误伤，正常通过。"""
    r = _check_text("请阅读术前术后注意事项")
    assert r["passed"] is True
    assert r["blocked"] is False


# ============================================================
# 4. 生图前置检查（FR-306/307）
# ============================================================
def test_image_prompt_前后对比拦截():
    """生图提示词含『前后对比』→ 拦截并说明，不产生扣费。"""
    r = _check_image("医美海报，展示前后对比效果")
    assert r["passed"] is False
    assert r["blocked"] is True
    assert r["fixes"] == []
    assert r["reason"] and "FR-306" in r["reason"]
    assert r["mode"] == "image_prompt"


def test_image_prompt_医疗效果承诺拦截():
    """生图提示词含医疗效果承诺（永久脱毛/一次见效）→ 拦截。"""
    r = _check_image("宣传图：永久脱毛，一次见效")
    assert r["blocked"] is True


def test_image_prompt_正常通过():
    """合规生图提示词正常通过。"""
    r = _check_image("简洁医美机构门头设计，莫兰迪色调")
    assert r["passed"] is True
    assert r["blocked"] is False


# ============================================================
# 5. 正常通过
# ============================================================
def test_正常通过():
    """合规文案：无违规词 → passed，无修正，无拦截。"""
    text = "我们提供专业的医美咨询服务，效果因人而异，需面诊评估"
    r = _check_text(text)
    assert r["passed"] is True
    assert r["blocked"] is False
    assert r["fixes"] == []
    assert r["fixed_text"] == text


# ============================================================
# 6. 规则包选择
# ============================================================
def test_rule_pack_选择_仅general不拦截medical():
    """仅启用 general 时，medical 词『无痛无痕』不被拦截。"""
    r = _check_text("无痛无痕除皱", packs=["general"])
    assert r["passed"] is True
    assert r["blocked"] is False


def test_rule_pack_选择_仅medical生效():
    """仅启用 medical 时『无痛无痕』被拦截。"""
    r = _check_text("无痛无痕除皱", packs=["medical"])
    assert r["blocked"] is True


def test_rule_pack_非法包名():
    """未实现的规则包（education）→ 400 明确报错。"""
    resp = client.post("/check", json={"text": "测试", "rule_packs": ["education"]})
    assert resp.status_code == 400
    assert "education" in resp.json()["detail"]


def test_缺text与image_prompt_422():
    """text 与 image_prompt 都缺失 → 422。"""
    resp = client.post("/check", json={})
    assert resp.status_code == 422


# ============================================================
# 7. FR-209 发布审查提示
# ============================================================
def test_hint_缺省文案():
    """GET /hint 返回缺省提示文案。"""
    r = client.get("/hint").json()
    assert r["enabled"] is True
    assert r["configurable"] is True
    assert r["text"] == DEFAULT_HINT
    assert "《医疗广告审查证明》" in r["text"]


def test_hint_后台可配置():
    """PUT /hint 更新提示文案（后台可配置变量），GET 返回新值；恢复缺省。"""
    custom = "需取得广告审查证明并经人工审核后方可投放"
    try:
        r = client.put("/hint", json={"text": custom})
        assert r.status_code == 200
        assert r.json()["text"] == custom
        assert client.get("/hint").json()["text"] == custom
    finally:
        # 恢复缺省，避免污染持久化配置
        client.put("/hint", json={"text": DEFAULT_HINT})
    assert client.get("/hint").json()["text"] == DEFAULT_HINT


def test_hint_超长拒绝():
    """提示文案超 200 字 → 422（对齐场景包 Schema maxLength 200）。"""
    resp = client.put("/hint", json={"text": "长" * 201})
    assert resp.status_code == 422


def test_h4_行业领先不死循环():
    """H4 回归：行业领先应为合规表述（不再是身份映射），不得被拦截"""
    from engine import check_text
    r = check_text("我们是行业领先机构", ["general"])
    assert r["blocked"] is False, f"行业领先不应被拦截: {r}"
    assert "行业前列" in r.get("fixed_text", ""), f"应修正为行业前列: {r}"


def test_m3_恢复期对比漏检():
    """M3 回归：术前术后恢复期对比效果（safe 后接 viol）应拦截"""
    from engine import check_text
    r = check_text("展示术前术后恢复期对比效果", ["general", "medical"])
    assert r["blocked"] is True, f"术前术后恢复期对比应拦截: {r}"


def test_m4_生图不误伤正常术语():
    """M4 回归：生图前置只查 block 红线，最佳/首选不拦截"""
    from engine import check_image_prompt
    r = check_image_prompt("最佳角度拍摄的产品特写", ["general", "medical"])
    assert r["blocked"] is False, f"正常摄影术语不应拦截: {r}"
    r2 = check_image_prompt("术前术后对比图", ["general", "medical"])
    assert r2["blocked"] is True, f"生图医美红线应拦截: {r2}"
