"""领域模型。

这里演示"单行三引号"的写法，解析器不应该被它影响：
"""

import json
from dataclasses import dataclass


@dataclass
class User:
    name: str = ""

    def to_json(self):
        return json.dumps({"name": self.name})
