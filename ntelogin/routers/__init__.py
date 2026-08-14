from __future__ import annotations

from fastapi import APIRouter

from . import auth, health, page, transport_http, transport_sse, transport_ws, wanmei

router = APIRouter()
router.include_router(health.router)
router.include_router(page.router)
router.include_router(auth.router)
router.include_router(transport_http.router)
router.include_router(transport_sse.router)
router.include_router(transport_ws.router)
router.include_router(wanmei.router)
