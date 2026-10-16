"""路由装配层。"""

from app.core.models import User
from . import helpers


def build_routes(date):
    return [helpers.to_json(User(name="a")), date]
