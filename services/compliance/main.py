# -*- coding: utf-8 -*-
"""
Informate 合规服务 API（T8）
============================
端口：9100
端点：
- POST /check   文本合规检查/自动修正（FR-204）或 生图提示词前置检查（FR-306/307）
- GET  /hint    FR-209 医美文案发布审查提示（后台可配置：env PUBLISH_REVIEW_HINT 启动覆盖
                + PUT /hint 运行时持久化到 data/publish_hint.json）
- PUT  /hint    更新提示文案（maxLength 200，对齐场景包 Schema publish_review_hint.text）
- GET  /health  健康检查
- GET  /        服务信息

运行：uvicorn main:app --host 0.0.0.0 --port 9100（或 python main.py）
"""
import json
import os
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

import engine
from rule_packs import PACK_VERSIONS, SUPPORTED_PACKS

APP_VERSION = "0.1.0"
SERVICE_NAME = "informate-compliance"
# FR-209 缺省提示文案（场景包 Schema publish_review_hint.text 缺省值）
DEFAULT_HINT = "需人工审核且取得《医疗广告审查证明》后方可投放"
MAX_INPUT_LEN = 20000  # 输入长度保护

app = FastAPI(
    title="Informate 合规服务",
    description="医美内容合规检查/自动修正/拦截（FR-204/306/307）+ FR-209 发布审查提示（T8）",
    version=APP_VERSION,
)

# ---------- FR-209 提示文案存储（后台可配置变量：env 启动覆盖 + PUT 持久化） ----------
HINT_FILE = Path(__file__).resolve().parent / "data" / "publish_hint.json"


def _load_hint() -> tuple:
    """读取提示文案：env（启动覆盖）> 持久化文件 > 缺省值。返回 (text, source)。"""
    env = os.environ.get("PUBLISH_REVIEW_HINT")
    if env:
        return env, "env"
    if HINT_FILE.exists():
        try:
            data = json.loads(HINT_FILE.read_text(encoding="utf-8"))
            return data.get("text", DEFAULT_HINT), "file"
        except Exception:
            pass  # 文件损坏回退缺省值
    return DEFAULT_HINT, "default"


# ============================================================
# 请求/响应模型
# ============================================================
class CheckRequest(BaseModel):
    """POST /check 请求体：{text | image_prompt, rule_packs}，text 与 image_prompt 二选一。"""

    model_config = ConfigDict(extra="forbid")
    text: Optional[str] = None
    image_prompt: Optional[str] = None
    rule_packs: Optional[List[str]] = None  # 缺省启用全部已实现规则包（general+medical）


class FixRecord(BaseModel):
    """自动修正记录（diff 回写可审计，D-3 对齐）。"""

    keyword: str
    category: str
    before: str
    after: str
    start: int
    end: int


class CheckResponse(BaseModel):
    """POST /check 响应：{passed, fixes[], fixed_text, blocked, reason, ...}。"""

    passed: bool
    fixes: List[FixRecord]
    fixed_text: Optional[str] = None
    blocked: bool
    reason: Optional[str] = None
    rule_packs: List[str]
    ruleset_version: str
    mode: str  # "text" | "image_prompt"


class HintUpdate(BaseModel):
    """PUT /hint 请求体：提示文案（1~200 字）。"""

    model_config = ConfigDict(extra="forbid")
    text: str = Field(..., min_length=1, max_length=200)


class HintResponse(BaseModel):
    """GET/PUT /hint 响应。"""

    enabled: bool
    text: str
    source: str  # env | file | default
    configurable: bool


# ============================================================
# 路由
# ============================================================
@app.get("/")
def root() -> dict:
    """服务信息与端点列表。"""
    return {
        "service": SERVICE_NAME,
        "version": APP_VERSION,
        "endpoints": {
            "POST /check": "文本合规检查/修正 或 生图提示词前置检查",
            "GET /hint": "FR-209 发布审查提示",
            "PUT /hint": "更新发布审查提示（后台可配置）",
            "GET /health": "健康检查",
        },
        "rule_packs": {p: PACK_VERSIONS[p] for p in SUPPORTED_PACKS},
        "default_hint": DEFAULT_HINT,
    }


@app.get("/health")
def health() -> dict:
    """健康检查。"""
    return {"status": "ok", "service": SERVICE_NAME, "version": APP_VERSION}


@app.post("/check", response_model=CheckResponse)
def check(req: CheckRequest) -> CheckResponse:
    """合规检查（FR-204 文本 / FR-306·307 生图提示词）。

    - text：general 命中自动修正（fixes[] + fixed_text）；medical 红线命中拦截（blocked + reason）
    - image_prompt：任一规则命中即拦截并说明，不产生扣费
    """
    if (req.text is None) == (req.image_prompt is None):
        raise HTTPException(status_code=422, detail="text 与 image_prompt 必须二选一")
    content = req.text if req.text is not None else req.image_prompt
    if len(content) > MAX_INPUT_LEN:
        raise HTTPException(status_code=422,
                            detail=f"输入长度超过上限 {MAX_INPUT_LEN} 字符")
    packs = req.rule_packs or SUPPORTED_PACKS
    unknown = [p for p in packs if p not in SUPPORTED_PACKS]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的规则包：{unknown}；当前已实现：{SUPPORTED_PACKS}（"
                   f"education/finance/food_health 为后续迭代）",
        )
    packs = sorted(set(packs))
    ruleset_version = engine.ruleset_version_of(packs)
    if req.image_prompt is not None:
        result = engine.check_image_prompt(req.image_prompt, packs)
        result["mode"] = "image_prompt"
    else:
        result = engine.check_text(req.text, packs)
        result["mode"] = "text"
    result["rule_packs"] = packs
    result["ruleset_version"] = ruleset_version
    return CheckResponse(**result)


@app.get("/hint", response_model=HintResponse)
def get_hint() -> HintResponse:
    """FR-209：返回发布审查提示文案（后台可配置）。"""
    text, source = _load_hint()
    return HintResponse(enabled=True, text=text, source=source, configurable=True)


@app.put("/hint", response_model=HintResponse)
def put_hint(body: HintUpdate) -> HintResponse:
    """FR-209：更新发布审查提示文案（持久化到 data/publish_hint.json）。"""
    HINT_FILE.parent.mkdir(parents=True, exist_ok=True)
    HINT_FILE.write_text(
        json.dumps({"text": body.text}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return HintResponse(enabled=True, text=body.text, source="file", configurable=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=9100)
