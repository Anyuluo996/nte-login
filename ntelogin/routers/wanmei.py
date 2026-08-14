from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field
from starlette.responses import JSONResponse

from ..sdk.wanmei_model import WanmeiError
from ..service import (
    perform_wanmei_login,
    prepare_wanmei_login,
    select_wanmei_role,
    send_wanmei_sms,
)
from ..state import LoginSession, get_session
from ..utils.logger import logger

router = APIRouter()


class _WanmeiPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    auth: str


class _WanmeiSmsPayload(_WanmeiPayload):
    area_code_id: int = Field(alias="areaCodeId")
    phone: str
    cap_ticket: str = Field(alias="capTicket")
    sec_code: str = Field(alias="secCode")


class _WanmeiLoginPayload(_WanmeiSmsPayload):
    sms_code: str = Field(alias="smsCode")


class _WanmeiRolePayload(_WanmeiPayload):
    role_id: str = Field(alias="roleId")


def _error(message: str) -> JSONResponse:
    return JSONResponse({"ok": False, "message": message}, status_code=400)


def _session(auth: str) -> LoginSession:
    session = get_session(auth)
    if session is None:
        raise WanmeiError("完美登录链接已失效")
    return session


@router.post("/nte/wanmei/prepare")
async def wanmei_prepare(payload: _WanmeiPayload) -> JSONResponse:
    try:
        state = await prepare_wanmei_login(_session(payload.auth))
        cap_ticket = await state.client.refresh_cap_ticket()
    except WanmeiError as error:
        logger.warning(f"[NTE-LOGIN] 完美登录页初始化失败 auth={payload.auth}: {error.message}")
        return _error(error.message)
    return JSONResponse(
        {
            "ok": True,
            "areaCodes": [item.model_dump(by_alias=True) for item in state.area_codes],
            "capTicket": cap_ticket,
        }
    )


@router.post("/nte/wanmei/sendSmsCode")
async def wanmei_send_sms(payload: _WanmeiSmsPayload) -> JSONResponse:
    try:
        await send_wanmei_sms(
            _session(payload.auth),
            area_code_id=payload.area_code_id,
            phone=payload.phone,
            cap_ticket=payload.cap_ticket,
            sec_code=payload.sec_code,
        )
    except WanmeiError as error:
        logger.warning(f"[NTE-LOGIN] 完美短信发送失败 auth={payload.auth}: {error.message}")
        return _error(error.message)
    return JSONResponse({"ok": True})


@router.post("/nte/wanmei/login")
async def wanmei_login(payload: _WanmeiLoginPayload) -> JSONResponse:
    try:
        roles = await perform_wanmei_login(
            _session(payload.auth),
            area_code_id=payload.area_code_id,
            phone=payload.phone,
            sms_code=payload.sms_code,
            cap_ticket=payload.cap_ticket,
            sec_code=payload.sec_code,
        )
    except WanmeiError as error:
        logger.warning(f"[NTE-LOGIN] 完美登录失败 auth={payload.auth}: {error.message}")
        return _error(error.message)
    return JSONResponse(
        {
            "ok": True,
            "roles": [role.model_dump(by_alias=True) for role in roles],
        }
    )


@router.post("/nte/wanmei/selectRole")
async def wanmei_select_role(payload: _WanmeiRolePayload) -> JSONResponse:
    try:
        select_wanmei_role(_session(payload.auth), payload.role_id)
    except WanmeiError as error:
        return _error(error.message)
    return JSONResponse({"ok": True})
