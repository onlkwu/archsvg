"""应用入口。

下面这段是文档里的示例，不是真实依赖——
如果解析器不剥掉 docstring，就会凭空造出 auth 和 legacy 两条边：

    from app.auth import login
    import legacy_thing
"""

from .api.routes import build_routes
from .core.format import format_date

__all__ = ["main"]


def main():
    return build_routes(format_date())
