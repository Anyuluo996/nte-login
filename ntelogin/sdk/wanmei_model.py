from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field, RootModel, ValidationError

from .base import SdkError


class WanmeiError(SdkError):
    pass


class _WanmeiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")


_Result = TypeVar("_Result")


class WanmeiResponse(_WanmeiModel):
    code: int
    message: str


class WanmeiResultResponse(WanmeiResponse, Generic[_Result]):
    result: _Result


class WanmeiAreaCode(_WanmeiModel):
    area_code_id: int = Field(alias="areaCodeId")
    area_code: int = Field(alias="areaCode")
    area_name: str = Field(alias="areaName")


@dataclass(frozen=True, slots=True, kw_only=True)
class WanmeiLoginPage:
    public_key: str
    jsession_id: str


class WanmeiRole(_WanmeiModel):
    role_id: str = Field(alias="roleId")
    role_name: str = Field(alias="roleName")


class WanmeiRoleList(RootModel[list[WanmeiRole]]):
    pass


_Model = TypeVar("_Model", bound=BaseModel)


def parse_wanmei(model: type[_Model], data: Any, message: str) -> _Model:
    try:
        return model.model_validate(data)
    except ValidationError as error:
        raise WanmeiError(f"{message}: {error}", {"response": data}) from error
