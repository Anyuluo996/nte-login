from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from .schemas import Credential, LoginStatus, StatusResponse
from .sdk.laohu import LaohuDevice
from .sdk.wanmei import WanmeiIdClient
from .sdk.wanmei_model import WanmeiAreaCode, WanmeiLoginPage, WanmeiRole
from .settings import settings
from .utils.cache import TimedCache
from .utils.logger import logger


@dataclass(slots=True, kw_only=True)
class WanmeiLoginState:
    client: WanmeiIdClient
    login_page: WanmeiLoginPage
    area_codes: list[WanmeiAreaCode]
    roles: list[WanmeiRole] | None = None
    logon: str | None = None


@dataclass(slots=True, kw_only=True)
class LoginSession:
    auth: str
    user_id: str
    bot_id: str
    group_id: str | None
    device: LaohuDevice
    status: LoginStatus = "pending"
    msg: str = ""
    credential: Credential | None = None
    wanmei: WanmeiLoginState | None = None
    listeners: list[asyncio.Queue[StatusResponse]] = field(default_factory=list)

    def snapshot(self) -> StatusResponse:
        return StatusResponse(status=self.status, msg=self.msg, credential=self.credential)

    def add_listener(self) -> asyncio.Queue[StatusResponse]:
        """SSE / WS 订阅者注册一条队列；当前快照立刻塞进去，避免错过已 push 的终态。"""
        queue: asyncio.Queue[StatusResponse] = asyncio.Queue(maxsize=8)
        queue.put_nowait(self.snapshot())
        self.listeners.append(queue)
        return queue

    def remove_listener(self, queue: asyncio.Queue[StatusResponse]) -> None:
        try:
            self.listeners.remove(queue)
        except ValueError:
            pass


_SESSIONS: TimedCache = TimedCache(timeout_s=settings.session_ttl_s, maxsize=4096)


def create_session(auth: str, user_id: str, bot_id: str, group_id: str | None) -> LoginSession:
    existing: LoginSession | None = _SESSIONS.get(auth)
    if existing is not None:
        return existing

    session = LoginSession(
        auth=auth,
        user_id=user_id,
        bot_id=bot_id,
        group_id=group_id,
        device=LaohuDevice(),
    )
    _SESSIONS.set(auth, session)
    logger.info(f"[NTE-LOGIN] 新会话 auth={auth} user_id={user_id} bot_id={bot_id}")
    return session


def get_session(auth: str) -> LoginSession | None:
    return _SESSIONS.get(auth)


def drop_session(auth: str) -> None:
    _SESSIONS.pop(auth)


def publish(
    session: LoginSession,
    status: LoginStatus,
    msg: str = "",
    credential: Credential | None = None,
) -> None:
    """更新会话状态并广播给所有 listener。终态（success/failed/expired）触发后 listener 应自行退出循环。"""
    session.status = status
    session.msg = msg
    session.credential = credential
    snap = session.snapshot()
    for queue in list(session.listeners):
        try:
            queue.put_nowait(snap)
        except asyncio.QueueFull:
            logger.warning(f"[NTE-LOGIN] listener 队列已满 auth={session.auth}，丢弃事件")
