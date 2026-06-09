"""
VRF selection sidecar — wraps the deterministic Toshiba VRF engine behind HTTP.

The engine (engine.py / vrf_data.py / build_boq.py) is UNCHANGED from the skill.
This file only exposes build() over an authenticated endpoint and streams back
the xlsx plus the JSON summary the engine already returns.

Endpoints
  GET  /health                 -> {"ok": true}
  POST /select                 -> xlsx bytes; summary returned in X-Summary header (JSON)

Auth
  Every request must send  X-API-Key: <VRF_API_KEY>  matching the env var.
  Only the Node bot knows this key. Internal Render traffic only.
"""

import json
import os
import tempfile
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from typing import List, Optional

# engine/ is on the path (see Dockerfile / start command WORKDIR)
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "engine"))
from build_boq import build  # noqa: E402

API_KEY = os.environ.get("VRF_API_KEY", "")

app = FastAPI(title="VRF Selection Sidecar", version="1.0.0")


class Row(BaseModel):
    tag: Optional[str] = None
    system: Optional[str] = "S1"
    room: Optional[str] = ""
    type: Optional[str] = None          # free text; engine normalizes it
    required_kw: float
    qty: int = 1


class SelectRequest(BaseModel):
    project: str = "VRF Project"
    discount: Optional[float] = None    # None -> engine default (0.25)
    rows: List[Row] = Field(..., min_items=1)


def _check_key(provided: Optional[str]):
    if not API_KEY:
        # Fail closed: if the server has no key set, refuse everything.
        raise HTTPException(status_code=500, detail="server missing VRF_API_KEY")
    if provided != API_KEY:
        raise HTTPException(status_code=401, detail="bad or missing X-API-Key")


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/select")
def select(req: SelectRequest, x_api_key: Optional[str] = Header(default=None)):
    _check_key(x_api_key)

    # Build the input.json shape the engine expects.
    payload = {
        "project": req.project,
        "rows": [r.model_dump() for r in req.rows],
    }
    if req.discount is not None:
        payload["discount"] = req.discount

    out_dir = tempfile.gettempdir()
    safe = "".join(c if c.isalnum() else "_" for c in req.project)[:40] or "VRF"
    out_path = os.path.join(out_dir, f"{safe}_{uuid.uuid4().hex[:8]}_VRF_BOQ.xlsx")

    try:
        # No price list passed -> blank-price BOQ (privacy preserving).
        summary = build(payload, out_path, req.discount, None)
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

    # Engine summary travels in a header so the body can be the file itself.
    headers = {"X-Summary": json.dumps(summary)}
    return FileResponse(
        out_path,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=os.path.basename(out_path),
        headers=headers,
    )
