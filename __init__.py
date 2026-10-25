"""丨桃源专用-Minimax h3素材装载

ComfyUI 自定义节点入口。ComfyUI 用 spec_from_file_location 加载本目录，
相对 import 不可靠，所以这里把插件目录塞进 sys.path，再按带前缀的
模块名导入，避免和 ComfyUI 自身的 `nodes` 等模块撞名。
"""

import os
import sys

_DIR = os.path.dirname(os.path.abspath(__file__))
if _DIR not in sys.path:
    sys.path.insert(0, _DIR)

from taoyuan_h3_nodes import TaoyuanMiniMaxH3Extension, comfy_entrypoint  # noqa: E402,F401

WEB_DIRECTORY = "./web"

__all__ = ["comfy_entrypoint", "TaoyuanMiniMaxH3Extension", "WEB_DIRECTORY"]
