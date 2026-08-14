from __future__ import annotations

import json
import re
import secrets
import time
from base64 import b64encode
from html import unescape
from typing import Any, TypeVar

import httpx
from Crypto.Cipher import PKCS1_OAEP
from Crypto.Hash import SHA1
from Crypto.PublicKey import RSA

from ..constants import (
    WANMEI_ID_BASE_URL,
    WANMEI_KF_BASE_URL,
    WANMEI_KF_GAME_ID,
    WANMEI_LOGIN_RETURN_URL,
    WANMEI_USER_AGENT,
)
from .base import BaseSdkClient
from .wanmei_model import (
    WanmeiAreaCode,
    WanmeiError,
    WanmeiLoginPage,
    WanmeiResponse,
    WanmeiResultResponse,
    WanmeiRole,
    WanmeiRoleList,
    parse_wanmei,
)

_PUBLIC_KEY_RE = re.compile(r'id="publicKey"[^>]*value="([^"]+)"')
_JSESSION_ID_RE = re.compile(r'id="jsessionId"[^>]*value="([^"]+)"')
_ResponseModel = TypeVar("_ResponseModel", bound=WanmeiResponse)


class _WanmeiClient(BaseSdkClient):
    USER_AGENT = WANMEI_USER_AGENT
    error_cls = WanmeiError


class WanmeiIdClient(_WanmeiClient):
    BASE_URL = WANMEI_ID_BASE_URL
    cookie_jar: httpx.Cookies

    def __init__(self) -> None:
        self.cookie_jar = httpx.Cookies()

    def _default_headers(self) -> dict[str, str]:
        return {
            "User-Agent": self.USER_AGENT,
            "Accept": "*/*",
            "X-Requested-With": "XMLHttpRequest",
        }

    async def login_page(self) -> WanmeiLoginPage:
        response = await self._request_raw(
            "/login",
            query={"location": WANMEI_LOGIN_RETURN_URL},
            headers={"Accept": "text/html,application/xhtml+xml"},
        )
        public_key = _PUBLIC_KEY_RE.search(response.text)
        jsession_id = _JSESSION_ID_RE.search(response.text)
        if public_key is None or jsession_id is None:
            raise WanmeiError("完美世界登录页格式错误")
        return WanmeiLoginPage(
            public_key=unescape(public_key.group(1)),
            jsession_id=jsession_id.group(1),
        )

    async def area_codes(self) -> list[WanmeiAreaCode]:
        payload = await self._json_form(
            "/areaCode/list",
            {},
            WanmeiResultResponse[list[WanmeiAreaCode]],
        )
        return payload.result

    async def refresh_cap_ticket(self) -> str:
        payload = await self._json_form(
            "/user/security/getCapTicket",
            {"t": str(int(time.time() * 1000))},
            WanmeiResultResponse[str],
        )
        return payload.result

    async def send_sms(
        self,
        *,
        area_code_id: int,
        phone: str,
        cap_ticket: str,
        sec_code: str,
    ) -> None:
        await self._json_form(
            "/checkPhoneWithNationAreaId",
            {"nationAreaId": str(area_code_id), "phoneNumber": phone},
            WanmeiResponse,
        )
        await self._json_form(
            "/sendPhoneCaptchaForSlidCaptcha",
            {
                "nationAreaId": str(area_code_id),
                "phone": phone,
                "capTicket": cap_ticket,
                "secCode": sec_code,
            },
            WanmeiResponse,
        )

    async def login_by_sms(
        self,
        *,
        login_page: WanmeiLoginPage,
        area_code_id: int,
        phone: str,
        sms_code: str,
        cap_ticket: str,
        sec_code: str,
    ) -> str:
        await self._json_form(
            "/setDeviceInfo",
            {
                "jsessionId": login_page.jsession_id,
                "deviceId": f"NTEUID-{secrets.token_hex(8)}",
                "deviceModel": "NTEUID Web Login",
                "deviceSys": "Web",
            },
            WanmeiResponse,
        )
        await self._json_form(
            "/checkPhoneCaptcha",
            {"phone": phone, "phoneCaptcha": sms_code},
            WanmeiResponse,
        )
        await self._json_form(
            "/shortMessageLogon",
            {
                "phoneNumber": _rsa_oaep_encrypt(login_page.public_key, phone),
                "newCaptcha": _rsa_oaep_encrypt(login_page.public_key, sms_code),
                "nationAreaId": str(area_code_id),
                "capTicket": cap_ticket,
                "secCode": sec_code,
                "location": WANMEI_LOGIN_RETURN_URL,
                "state": login_page.jsession_id,
            },
            WanmeiResponse,
        )
        logon = self.cookie_jar.get("logon")
        if logon is None:
            raise WanmeiError("完美世界短信登录响应缺少 logon Cookie")
        return logon

    async def _json_form(
        self,
        path: str,
        body: dict[str, Any],
        model: type[_ResponseModel],
    ) -> _ResponseModel:
        response = await self._request_raw(path, method="POST", body=body)
        try:
            data = response.json()
        except json.JSONDecodeError as error:
            raise WanmeiError(f"[{path}] 响应格式错误", {"response": response.text}) from error
        payload = parse_wanmei(model, data, f"[{path}] 响应格式错误")
        if payload.code != 0:
            raise WanmeiError(payload.message, data)
        return payload


class WanmeiKfClient(_WanmeiClient):
    BASE_URL = WANMEI_KF_BASE_URL
    cookie_jar: httpx.Cookies

    def __init__(self, logon: str) -> None:
        self.cookie_jar = httpx.Cookies()
        self.cookie_jar.set("logon", logon, domain="kf.wanmei.com", path="/")

    def _default_headers(self) -> dict[str, str]:
        return {
            "User-Agent": self.USER_AGENT,
            "Accept": "*/*",
            "Referer": WANMEI_LOGIN_RETURN_URL,
            "X-Requested-With": "XMLHttpRequest",
        }

    async def roles(self) -> list[WanmeiRole]:
        response = await self._request_raw(
            "/laohuSelfService/searchActiveGameRoles",
            query={"gameId": WANMEI_KF_GAME_ID},
        )
        try:
            data = response.json()
        except json.JSONDecodeError as error:
            raise WanmeiError("客服角色列表格式错误", {"response": response.text}) from error
        return parse_wanmei(WanmeiRoleList, data, "客服角色列表格式错误").root


def _rsa_oaep_encrypt(public_key: str, value: str) -> str:
    key = RSA.import_key(public_key)
    cipher = PKCS1_OAEP.new(key, hashAlgo=SHA1)
    return b64encode(cipher.encrypt(value.encode())).decode()
