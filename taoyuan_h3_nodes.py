"""桃源 MiniMax H3 素材装载 —— 节点定义（ComfyUI V3 / comfy_api.latest.io）。

三个节点：
  * 丨桃源专用-Minimax h3素材装载  TaoyuanMiniMaxH3Loader  主力节点，18 个固定输出 + 报告
  * 丨桃源专用-H3素材校验          TaoyuanMiniMaxH3Check   只出报告，不接线
  * 丨桃源专用-H3提示词标签        TaoyuanMiniMaxH3Tags    按放行顺序吐 <Picture n> 骨架
"""

import os
import sys

_DIR = os.path.dirname(os.path.abspath(__file__))
if _DIR not in sys.path:
    sys.path.insert(0, _DIR)

from comfy_api.latest import ComfyExtension, io  # noqa: E402

from taoyuan_h3_media import (  # noqa: E402
    AUDIO_CAP,
    FPS_DEFAULT,
    IMAGE_CAP,
    OUT_TOTAL,
    PAIRED_AUDIO_CAP,
    VIDEO_CAP,
    _scalar,
    _iter_values,
    dump_report,
    run_collect,
)

from taoyuan_h3_preview import build_bundle, put as put_preview, register_routes  # noqa: E402

MODE_OMNI = "全模态参考"
MODE_FL = "首尾帧"
MODE_T2V = "文生视频"
MODES = [MODE_OMNI, MODE_FL, MODE_T2V]

CATEGORY = "桃源/视频"


def attach_preview(report, outs):
    """把放行的素材压成可播放的预览，token 写回报告；失败不影响主流程。"""
    try:
        if not any(out is not None for out in outs):
            report["preview"] = {}
            return
        bundle = build_bundle(outs, fps=report.get("fps") or float(FPS_DEFAULT))
        if not bundle:
            report["preview"] = {}
            return
        report["preview"] = {"token": put_preview(bundle), "fps": bundle["fps"]}
        register_routes()  # 万一加载顺序不对，这里再兜一次
    except Exception:
        report["preview"] = {}


def _media_groups(video=True, audio=True):
    """四组 autogrow 输入。首尾帧模式不需要视频/音频组。"""
    groups = [
        io.Autogrow.Input(
            "images",
            template=io.Autogrow.TemplatePrefix(
                input=io.Image.Input("image"),
                prefix="image_",
                min=0,
                max=IMAGE_CAP,
            ),
            display_name="图像",
            optional=True,
            tooltip="一个 batch 会按列表展开成多张参考图；也可以接多条线，按槽位号先后排序。",
        ),
    ]
    if video:
        groups.append(io.Autogrow.Input(
            "videos",
            template=io.Autogrow.TemplatePrefix(
                input=io.Image.Input("video"),
                prefix="video_",
                min=0,
                max=VIDEO_CAP,
            ),
            display_name="视频",
            optional=True,
            tooltip="注意：这里收的是帧序列（IMAGE 批次），一段视频一个 batch，不再拆帧。",
        ))
    if audio:
        groups.append(io.Autogrow.Input(
            "audios",
            template=io.Autogrow.TemplatePrefix(
                input=io.Audio.Input("audio"),
                prefix="audio_",
                min=0,
                max=AUDIO_CAP,
            ),
            display_name="独立音频",
            optional=True,
            tooltip="独立参考音色，对应官方 ref_audios。",
        ))
        groups.append(io.Autogrow.Input(
            "video_audios",
            template=io.Autogrow.TemplatePrefix(
                input=io.Audio.Input("video_audio"),
                prefix="video_audio_",
                min=0,
                max=PAIRED_AUDIO_CAP,
            ),
            display_name="配套音频",
            optional=True,
            tooltip="给同号参考视频配音轨，对应官方 ref_video_audios；必须以 video_audio_N 与 video_N 对齐。",
        ))
    return groups


def _media_outputs():
    outs = [io.Image.Output(display_name=f"参考图{i + 1}") for i in range(IMAGE_CAP)]
    outs += [io.Image.Output(display_name=f"参考视频{i + 1}") for i in range(VIDEO_CAP)]
    outs += [io.Audio.Output(display_name=f"独立音频{i + 1}") for i in range(AUDIO_CAP)]
    outs += [io.Audio.Output(display_name=f"配套音频{i + 1}") for i in range(PAIRED_AUDIO_CAP)]
    return outs


def _threshold_inputs():
    return [
        io.Float.Input("audio_min", default=2.0, min=0.0, max=60.0, step=0.1,
                       display_name="音频最短时长(秒)",
                       tooltip="短于这个时长的音频不参与自动连线。"),
        io.Float.Input("video_min", default=2.0, min=0.0, max=60.0, step=0.1,
                       display_name="视频最短时长(秒)",
                       tooltip="短于这个时长的参考视频不参与自动连线。"),
        io.Float.Input("video_max", default=15.0, min=0.1, max=120.0, step=0.1,
                       display_name="视频最长时长(秒)",
                       tooltip="长于这个时长的参考视频不参与自动连线。"),
        io.Float.Input("video_fps", default=float(FPS_DEFAULT), min=1.0, max=120.0, step=0.1,
                       display_name="素材帧率",
                       tooltip="用来把帧数换算成秒。H3 输出固定 24fps，素材若来自 30fps 的源请填 30。"),
    ]


def _empty_report(mode, text):
    return {
        "version": 1,
        "mode": mode,
        "fps": FPS_DEFAULT,
        "thresholds": {},
        "items": {"images": [], "videos": [], "audios": [], "video_audios": []},
        "blocked": [],
        "warnings": [text] if text else [],
        "counts": {"images": 0, "videos": 0, "audios": 0, "video_audios": 0},
    }


def build_tags(report) -> str:
    """按实际放行顺序给出 H3 提示词标签骨架。"""
    lines = []
    pics = report.get("items", {}).get("images") or []
    vids = report.get("items", {}).get("videos") or []
    auds = report.get("items", {}).get("audios") or []
    if pics:
        lines.append("参考图：" + " ".join(f"<Picture {i + 1}>" for i in range(len(pics))))
    paired = 0
    vparts = []
    for index, item in enumerate(vids):
        if item.get("paired_audio"):
            paired += 1
            vparts.append(f"<Video {index + 1}>（音轨 <Audio {paired}>）")
        else:
            vparts.append(f"<Video {index + 1}>")
    if vparts:
        lines.append("参考视频：" + " ".join(vparts))
    if auds:
        first = paired + 1
        lines.append("参考音频：" + " ".join(
            f"<Audio {first + i}>" for i in range(len(auds))))
    return "\n".join(lines)


class TaoyuanMiniMaxH3Loader(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TaoyuanMiniMaxH3Loader",
            display_name="丨桃源专用-Minimax h3素材装载",
            category=CATEGORY,
            description=(
                "把图像 / 视频 / 音频素材按槽位先后整理，逐条测量时长，"
                "不合格的条目跳过并让后面的往前补位，然后由前端按输出槽顺序"
                "自动连到官方 MiniMax H3 节点。"
            ),
            inputs=_media_groups() + [
                io.Combo.Input("mode", options=MODES, default=MODE_OMNI,
                               display_name="生成模式",
                               tooltip="全模态参考 → MiniMaxH3ReferenceToVideo；首尾帧 → MiniMaxH3ImageToVideo；文生视频不需要素材。"),
            ] + _threshold_inputs() + [
                io.Boolean.Input("auto_wire", default=True, display_name="自动连线",
                                 label_on="开", label_off="关",
                                 tooltip="关掉之后只测量、不碰画布上的连线。"),
            ],
            # 上游给列表时，ComfyUI 默认会把本节点按列表长度拆成多次调用，
            # 每次只喂一条，最后 merge 出来的输出还是错的。声明成 INPUT_IS_LIST
            # 让本节点只跑一次、自己把列表摊平，批次与列表才能真正统一。
            is_input_list=True,
            outputs=_media_outputs() + [
                io.String.Output(display_name="提示词标签"),
                io.String.Output(display_name="报告JSON"),
            ],
        )

    @classmethod
    def execute(cls, mode=MODE_OMNI, audio_min=2.0,
                video_min=2.0, video_max=15.0, video_fps=float(FPS_DEFAULT),
                auto_wire=True, images=None, videos=None, audios=None,
                video_audios=None) -> io.NodeOutput:
        mode = _scalar(mode, MODE_OMNI)
        if mode == MODE_T2V:
            outs = (None,) * OUT_TOTAL
            report = _empty_report(mode, "文生视频模式：不使用任何素材")
            text = "文生视频模式：不使用任何素材"
        elif mode == MODE_FL:
            outs, report, text = run_collect(
                images=images, image_limit=2,
                fps=video_fps, audio_min=audio_min,
                video_min=video_min, video_max=video_max,
            )
            report["mode"] = mode
            if report["counts"]["images"] or list(_iter_values(images)):
                report["warnings"].append("首尾帧模式只用前 2 张图（首帧 / 末帧），视频和音频已忽略")
            text = "首尾帧模式\n" + text
        else:
            outs, report, text = run_collect(
                images=images, videos=videos, audios=audios,
                video_audios=video_audios,
                fps=video_fps, audio_min=audio_min,
                video_min=video_min, video_max=video_max,
            )
            report["mode"] = mode

        attach_preview(report, outs)
        payload = dump_report(report)
        tags = build_tags(report)
        return io.NodeOutput(*outs, tags, payload, ui={
            "report": [payload],
            "tags": [tags],
            "text": [text],
        })

class TaoyuanMiniMaxH3Check(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TaoyuanMiniMaxH3Check",
            display_name="丨桃源专用-H3素材校验",
            category=CATEGORY,
            description="只测量、只报告，不接线。把它丢进画布就能看到每条素材的时长与放行结论。",
            is_output_node=True,
            is_input_list=True,
            inputs=_media_groups() + _threshold_inputs(),
            outputs=[
                io.String.Output(display_name="报告JSON"),
                io.String.Output(display_name="摘要"),
            ],
        )

    @classmethod
    def execute(cls, audio_min=2.0, video_min=2.0, video_max=15.0,
                video_fps=float(FPS_DEFAULT), images=None, videos=None,
                audios=None, video_audios=None) -> io.NodeOutput:
        _outs, report, text = run_collect(
            images=images, videos=videos, audios=audios,
            video_audios=video_audios,
            fps=video_fps, audio_min=audio_min,
            video_min=video_min, video_max=video_max,
        )
        report["mode"] = "校验"
        payload = dump_report(report)
        return io.NodeOutput(payload, text, ui={
            "report": [payload],
            "text": [text],
        })


class TaoyuanMiniMaxH3Tags(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TaoyuanMiniMaxH3Tags",
            display_name="丨桃源专用-H3提示词标签",
            category=CATEGORY,
            description="按实际放行顺序生成 <Picture 1> / <Video 1> / <Audio 1> 骨架，贴进提示词就不会和连线顺序错位。",
            is_input_list=True,
            inputs=_media_groups() + _threshold_inputs(),
            outputs=[
                io.String.Output(display_name="标签"),
                io.String.Output(display_name="摘要"),
            ],
        )

    @classmethod
    def execute(cls, audio_min=2.0, video_min=2.0, video_max=15.0,
                video_fps=float(FPS_DEFAULT), images=None, videos=None,
                audios=None, video_audios=None) -> io.NodeOutput:
        _outs, report, text = run_collect(
            images=images, videos=videos, audios=audios,
            video_audios=video_audios,
            fps=video_fps, audio_min=audio_min,
            video_min=video_min, video_max=video_max,
        )
        tags = build_tags(report)
        report["mode"] = "标签"
        return io.NodeOutput(tags, text, ui={
            "report": [dump_report(report)],
            "tags": [tags],
            "text": [text],
        })


class TaoyuanMiniMaxH3Extension(ComfyExtension):
    async def get_node_list(self):
        return [TaoyuanMiniMaxH3Loader, TaoyuanMiniMaxH3Check, TaoyuanMiniMaxH3Tags]


async def comfy_entrypoint() -> TaoyuanMiniMaxH3Extension:
    try:
        register_routes()
    except Exception:
        pass
    return TaoyuanMiniMaxH3Extension()
