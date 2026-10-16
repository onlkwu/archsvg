"""日期格式化。"""

import datetime


def format_date(d=None):
    return (d or datetime.date.today()).isoformat()
