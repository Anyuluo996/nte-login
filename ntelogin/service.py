from __future__ import annotations

from .constants import LAOHU_APP_ID, LAOHU_APP_KEY
from .schemas import LaohuCredential, LoginResultModel, WanmeiCredential
from .sdk.laohu import LaohuClient, LaohuError
from .sdk.wanmei import WanmeiIdClient, WanmeiKfClient
from .sdk.wanmei_model import WanmeiError, WanmeiRole
from .state import LoginSession, WanmeiLoginState, publish
from .utils.logger import logger

SMS_SENT = "验证码已发送"
SMS_SEND_FAILED = "验证码发送失败，请稍后再试"
SMS_LOGIN_FAILED = "验证码错误或已过期，请重新获取"
SUCCESS = "登录成功"


async def send_sms(session: LoginSession, mobile: str) -> LoginResultModel:
    client = LaohuClient(LAOHU_APP_ID, LAOHU_APP_KEY, device=session.device)
    try:
        await client.send_sms_code(mobile)
    except LaohuError as err:
        logger.warning(f"[NTE-LOGIN] sms 下发失败 auth={session.auth}: {err.message}")
        return LoginResultModel(ok=False, msg=SMS_SEND_FAILED)
    return LoginResultModel(ok=True, msg=SMS_SENT)


async def perform_login(session: LoginSession, mobile: str, code: str) -> LoginResultModel:
    client = LaohuClient(LAOHU_APP_ID, LAOHU_APP_KEY, device=session.device)
    try:
        account = await client.login_by_sms(mobile, code)
    except LaohuError as err:
        logger.warning(f"[NTE-LOGIN] 老虎短信登录失败 auth={session.auth}: {err.message}")
        return LoginResultModel(ok=False, msg=SMS_LOGIN_FAILED)

    cred = LaohuCredential(laohu_token=account.token, laohu_user_id=str(account.user_id))
    publish(session, "success", msg=SUCCESS, credential=cred)
    logger.info(f"[NTE-LOGIN] 登录成功 auth={session.auth} laohu_user_id={account.user_id}")
    return LoginResultModel(ok=True, msg=SUCCESS)


async def prepare_wanmei_login(session: LoginSession) -> WanmeiLoginState:
    state = session.wanmei
    if state is not None:
        return state
    client = WanmeiIdClient()
    state = WanmeiLoginState(
        client=client,
        login_page=await client.login_page(),
        area_codes=await client.area_codes(),
    )
    session.wanmei = state
    return state


async def send_wanmei_sms(
    session: LoginSession,
    *,
    area_code_id: int,
    phone: str,
    cap_ticket: str,
    sec_code: str,
) -> None:
    state = _wanmei_state(session)
    await state.client.send_sms(
        area_code_id=area_code_id,
        phone=phone,
        cap_ticket=cap_ticket,
        sec_code=sec_code,
    )


async def perform_wanmei_login(
    session: LoginSession,
    *,
    area_code_id: int,
    phone: str,
    sms_code: str,
    cap_ticket: str,
    sec_code: str,
) -> list[WanmeiRole]:
    state = _wanmei_state(session)
    logon = await state.client.login_by_sms(
        login_page=state.login_page,
        area_code_id=area_code_id,
        phone=phone,
        sms_code=sms_code,
        cap_ticket=cap_ticket,
        sec_code=sec_code,
    )
    roles = await WanmeiKfClient(logon).roles()
    if not roles:
        raise WanmeiError("完美世界客服未返回异环角色")
    if len(roles) == 1:
        _finish_wanmei_login(session, roles[0], logon)
    else:
        state.roles = roles
        state.logon = logon
    return roles


def select_wanmei_role(session: LoginSession, role_id: str) -> None:
    state = _wanmei_state(session)
    if state.roles is None or state.logon is None:
        raise WanmeiError("完美登录角色列表已失效")
    role = next((item for item in state.roles if item.role_id == role_id), None)
    if role is None:
        raise WanmeiError("所选角色不在本次完美世界登录结果中")
    _finish_wanmei_login(session, role, state.logon)


def _wanmei_state(session: LoginSession) -> WanmeiLoginState:
    if session.wanmei is None:
        raise WanmeiError("完美登录链接已失效")
    return session.wanmei


def _finish_wanmei_login(session: LoginSession, role: WanmeiRole, logon: str) -> None:
    credential = WanmeiCredential(
        logon=logon,
        role_id=role.role_id,
        role_name=role.role_name,
    )
    session.wanmei = None
    publish(session, "success", msg=SUCCESS, credential=credential)
    logger.info(f"[NTE-LOGIN] 完美登录成功 auth={session.auth} role_id={role.role_id}")
