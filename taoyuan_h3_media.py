"""桃源 H3 素材装载 —— 素材展开 / 时长测量 / 屏蔽重排 的共用逻辑。

三个节点（素材装载、素材校验、提示词标签）共用这里的判定口径，保证
同一份素材在哪个节点里判定结果都一致。

注意：官方 MiniMaxH3ReferenceToVideo 的 execute 对 None 槽是 continue，
所以「不合格条目直接不占槽位、后面的往前补」不会让 <Picture i> 编号断裂。
"""

from __future__ import annotations

import json
import re

FPS_DEFAULT = 24
IMAGE_CAP = 9
VIDEO_CAP = 3
AUDIO_CAP = 3
PAIRED_AUDIO_CAP = 3

# 官方 MiniMaxH3ReferenceToVideo 对参考视频的硬下限（nodes_minimax_h3.py:329）
VIDEO_MIN_FRAMES = 5

OUT_IMAGE_BASE = 0
OUT_VIDEO_BASE = OUT_IMAGE_BASE + IMAGE_CAP      # 9
OUT_AUDIO_BASE = OUT_VIDEO_BASE + VIDEO_CAP      # 12
OUT_PAIRED_BASE = OUT_AUDIO_BASE + AUDIO_CAP     # 15
OUT_TOTAL = OUT_PAIRED_BASE + PAIRED_AUDIO_CAP   # 18


def _slot_number(name):
    m = re.search(r"(\d+)$", str(name or ""))
    return int(m.group(1)) if m else 1 << 30


def _ordered(group):
    """autogrow 收到的 dict 展开成按槽位号排好的 [(槽名, 值)]。

    不依赖 dict 插入顺序：官方节点用 .values() 迭代，我们这边自己按尾部
    数字排序，保证「槽位号优先」这条规则不被序列化顺序带偏。
    """
    if not group:
        return []
    if not isinstance(group, dict):
        # 极少见：有的版本会把整组塞成列表，这里按序号兜底
        return [(str(i), v) for i, v in enumerate(group) if v is not None]
    items = [(k, v) for k, v in group.items() if v is not None]
    items.sort(key=lambda kv: _slot_number(kv[0]))
    return items


def _as_frames(value):
    """把 IMAGE 张量规整成 [B,H,W,C]；认不出返回 None。"""
    if value is None or not hasattr(value, "dim"):
        return None
    try:
        if value.dim() == 3:
            value = value.unsqueeze(0)
        if value.dim() != 4:
            return None
        if value.shape[0] < 1:
            return None
    except Exception:
        return None
    return value


def audio_duration(audio):
    """AUDIO = {"waveform": [B,C,L], "sample_rate": int} → (秒, 采样率)。"""
    if not isinstance(audio, dict):
        return 0.0, 0
    wav = audio.get("waveform")
    try:
        sr = int(audio.get("sample_rate") or 0)
    except Exception:
        sr = 0
    if wav is None or sr <= 0 or not hasattr(wav, "shape"):
        return 0.0, sr
    try:
        return float(wav.shape[-1]) / float(sr), sr
    except Exception:
        return 0.0, sr


def _scalar(value, default=None):
    """INPUT_IS_LIST 下连标量也可能被包成 [x]，这里拆一层。

    普通数字、字符串原样返回；单元素列表取第一个非 None 值。
    """
    if isinstance(value, (list, tuple)):
        for item in value:
            if item is not None:
                return item
        return default
    return default if value is None else value


def _iter_values(value):
    """把一个槽位收到的值摊平成若干条独立素材。

    ComfyUI 的「列表输出」到下游是 python list；「批量」是同一个张量里多一维。
    两种都要当成列表处理，所以这里把 list/tuple 递归摊平，其余原样吐出。
    """
    if isinstance(value, (list, tuple)):
        for item in value:
            yield from _iter_values(item)
    elif value is not None:
        yield value


def collect_images(group):
    """图像口：batch 拆成多张，list 摊平，统一成「一张一条」。"""
    out = []
    for name, value in _ordered(group):
        for unit in _iter_values(value):
            frames = _as_frames(unit)
            if frames is None:
                continue
            for i in range(int(frames.shape[0])):
                out.append({
                    "source": name,
                    "source_index": i,
                    "image": frames[i:i + 1],
                    "height": int(frames.shape[1]),
                    "width": int(frames.shape[2]),
                })
    return out


def collect_videos(group, fps):
    """视频口：一段视频 = 一个 batch；上游给的是列表就一个元素一段。"""
    out = []
    for name, value in _ordered(group):
        for unit in _iter_values(value):
            frames = _as_frames(unit)
            if frames is None:
                continue
            count = int(frames.shape[0])
            out.append({
                "source": name,
                "frames": frames,
                "frame_count": count,
                "duration": count / float(fps or FPS_DEFAULT),
            })
    return out


def collect_audios(group):
    out = []
    for name, value in _ordered(group):
        for unit in _iter_values(value):
            if not isinstance(unit, dict):
                continue
            duration, sr = audio_duration(unit)
            out.append({
                "source": name,
                "audio": unit,
                "duration": duration,
                "sample_rate": sr,
            })
    return out


def _fmt(value):
    return f"{value:.2f}s"


def _thumb(frames, max_side=160, quality=70):
    """IMAGE 张量 [B,H,W,C] 的第一帧 → JPEG data URL；失败返回空串。

    只为了让面板能显示缩略图，尺寸压到 160px 以内，单张 base64 约 6~10KB。
    """
    try:
        import base64
        import io

        import torch
        from PIL import Image

        frame = frames[0]
        height, width = int(frame.shape[0]), int(frame.shape[1])
        if height < 1 or width < 1:
            return ""
        scale = float(max_side) / float(max(height, width))
        if scale < 1.0:
            new_h = max(1, int(round(height * scale)))
            new_w = max(1, int(round(width * scale)))
            data = frame.permute(2, 0, 1).unsqueeze(0).float()
            data = torch.nn.functional.interpolate(
                data, size=(new_h, new_w), mode="bilinear", align_corners=False
            )
            frame = data[0].permute(1, 2, 0)
        array = frame.detach().float().clamp(0.0, 1.0).cpu().numpy()
        array = (array * 255.0).round().astype("uint8")
        if array.ndim != 3:
            return ""
        array = array[:, :, :3]
        buffer = io.BytesIO()
        Image.fromarray(array, mode="RGB").save(
            buffer, format="JPEG", quality=quality
        )
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return "data:image/jpeg;base64," + encoded
    except Exception:
        return ""


def _peaks(audio, bars=48):
    """AUDIO 波形 → 归一化包络（0~1 的若干根柱子），给面板画小波形。"""
    waveform = audio.get("waveform") if isinstance(audio, dict) else None
    if waveform is None or not hasattr(waveform, "shape"):
        return []
    try:
        data = waveform.reshape(-1).detach().float().abs().cpu()
    except Exception:
        return []
    total = int(data.numel())
    if total <= 0:
        return []
    bars = max(8, int(bars))
    step = max(1, total // bars)
    values = []
    for index in range(bars):
        chunk = data[index * step:(index + 1) * step]
        values.append(float(chunk.max()) if int(chunk.numel()) else 0.0)
    peak = max(values) or 1.0
    return [round(min(1.0, value / peak), 3) for value in values]


def run_collect(*, images=None, videos=None, audios=None, video_audios=None,
                fps=FPS_DEFAULT, audio_min=2.0, video_min=2.0, video_max=15.0,
                image_limit=None):
    """展开 + 测量 + 屏蔽 + 重排，返回 (18 个输出, 报告 dict, 人类可读文本)。"""
    fps = float(_scalar(fps, FPS_DEFAULT) or FPS_DEFAULT)
    audio_min = float(_scalar(audio_min, 2.0) or 0.0)
    video_min = float(_scalar(video_min, 2.0) or 0.0)
    video_max = float(_scalar(video_max, 15.0) or 0.0)
    report = {
        "version": 1,
        "fps": fps,
        "thresholds": {
            "audio_min": float(audio_min),
            "video_min": float(video_min),
            "video_max": float(video_max),
        },
        "items": {"images": [], "videos": [], "audios": [], "video_audios": []},
        "blocked": [],
        "warnings": [],
        "counts": {"images": 0, "videos": 0, "audios": 0, "video_audios": 0},
    }
    outs = [None] * OUT_TOTAL

    # ---------------------------------------------------------------- 图像
    img_items = collect_images(images)
    if image_limit is not None:
        image_limit = int(_scalar(image_limit))
        if len(img_items) > image_limit:
            report["warnings"].append(
                f"图像共 {len(img_items)} 张，当前模式只用前 {image_limit} 张"
            )
            img_items = img_items[:image_limit]
    if len(img_items) > IMAGE_CAP:
        report["warnings"].append(
            f"图像共 {len(img_items)} 张，超出上限 {IMAGE_CAP}，已截断"
        )
        img_items = img_items[:IMAGE_CAP]
    for i, item in enumerate(img_items):
        outs[OUT_IMAGE_BASE + i] = item["image"]
        report["items"]["images"].append({
            "slot": i,
            "source": item["source"],
            "source_index": item["source_index"],
            "width": item["width"],
            "height": item["height"],
            "thumb": _thumb(item["image"]),
        })

    # ---------------------------------------------------------------- 视频
    vid_items = collect_videos(videos, fps)
    vaud_items = collect_audios(video_audios)
    paired_by_index = {}
    for item in vaud_items:
        paired_by_index[_slot_number(item["source"])] = item

    kept = []
    used_paired = set()
    for item in vid_items:
        idx = _slot_number(item["source"])
        paired = paired_by_index.get(idx)
        reason = None
        if item["frame_count"] < VIDEO_MIN_FRAMES:
            reason = (f"帧数 {item['frame_count']} < {VIDEO_MIN_FRAMES} 帧"
                      f"（官方节点会直接报错）")
        elif item["duration"] < float(video_min):
            reason = f"时长 {_fmt(item['duration'])} < 最短 {_fmt(float(video_min))}"
        elif item["duration"] > float(video_max):
            reason = f"时长 {_fmt(item['duration'])} > 最长 {_fmt(float(video_max))}"

        if reason:
            report["blocked"].append({
                "kind": "video", "slot": idx, "source": item["source"],
                "duration": round(item["duration"], 3), "reason": reason,
            })
            if paired is not None:
                used_paired.add(id(paired))
                report["blocked"].append({
                    "kind": "video_audio", "slot": idx, "source": paired["source"],
                    "duration": round(paired["duration"], 3),
                    "reason": "所属视频被屏蔽，配套音频一同屏蔽",
                })
            continue

        audio_out = None
        paired_kept = None
        if paired is not None:
            used_paired.add(id(paired))
            if paired["duration"] < float(audio_min):
                report["blocked"].append({
                    "kind": "video_audio", "slot": idx, "source": paired["source"],
                    "duration": round(paired["duration"], 3),
                    "reason": f"时长 {_fmt(paired['duration'])} < 最短 {_fmt(float(audio_min))}",
                })
            else:
                audio_out = paired["audio"]
                paired_kept = paired
        kept.append({"video": item, "audio": audio_out, "paired": paired_kept})

    # 没有对应视频的配套音频：官方节点根本不会读它
    for item in vaud_items:
        if id(item) in used_paired:
            continue
        report["warnings"].append(
            f"配套音频 {item['source']} 没有同号参考视频，已忽略"
            "（官方节点按 ref_video_N 的 N 配对）"
        )

    if len(kept) > VIDEO_CAP:
        report["warnings"].append(f"视频共 {len(kept)} 段，超出上限 {VIDEO_CAP}，已截断")
        kept = kept[:VIDEO_CAP]

    for i, entry in enumerate(kept):
        vid = entry["video"]
        outs[OUT_VIDEO_BASE + i] = vid["frames"]
        if entry["audio"] is not None:
            outs[OUT_PAIRED_BASE + i] = entry["audio"]
            paired = entry.get("paired") or {}
            report["items"]["video_audios"].append({
                "slot": i,
                "source": paired.get("source", ""),
                "duration": round(float(paired.get("duration") or 0.0), 3),
                "sample_rate": paired.get("sample_rate", 0),
                "peaks": _peaks(paired.get("audio")),
            })
        report["items"]["videos"].append({
            "slot": i,
            "source": vid["source"],
            "frames": vid["frame_count"],
            "duration": round(vid["duration"], 3),
            "paired_audio": entry["audio"] is not None,
            "thumb": _thumb(vid["frames"]),
        })

    # ------------------------------------------------------------ 独立音频
    aud_items = collect_audios(audios)
    kept_audio = []
    for item in aud_items:
        if item["duration"] < float(audio_min):
            report["blocked"].append({
                "kind": "audio", "slot": _slot_number(item["source"]),
                "source": item["source"], "duration": round(item["duration"], 3),
                "reason": f"时长 {_fmt(item['duration'])} < 最短 {_fmt(float(audio_min))}",
            })
            continue
        kept_audio.append(item)
    if len(kept_audio) > AUDIO_CAP:
        report["warnings"].append(f"独立音频共 {len(kept_audio)} 条，超出上限 {AUDIO_CAP}，已截断")
        kept_audio = kept_audio[:AUDIO_CAP]
    for i, item in enumerate(kept_audio):
        outs[OUT_AUDIO_BASE + i] = item["audio"]
        report["items"]["audios"].append({
            "slot": i,
            "source": item["source"],
            "duration": round(item["duration"], 3),
            "sample_rate": item["sample_rate"],
            "peaks": _peaks(item["audio"]),
        })

    for key in ("images", "videos", "audios", "video_audios"):
        report["counts"][key] = len(report["items"][key])
    return tuple(outs), report, human_text(report)


def human_text(report):
    """给界面看的纯文本摘要。"""
    counts = report.get("counts", {})
    lines = [
        f"图像 {counts.get('images', 0)}/{IMAGE_CAP} · "
        f"视频 {counts.get('videos', 0)}/{VIDEO_CAP} · "
        f"独立音频 {counts.get('audios', 0)}/{AUDIO_CAP} · "
        f"配套音频 {counts.get('video_audios', 0)}/{PAIRED_AUDIO_CAP}"
    ]
    for item in report.get("items", {}).get("videos", []):
        lines.append(
            f"  视频{item['slot'] + 1}：{item['duration']:.2f}s / {item['frames']}帧"
            + ("（含配套音轨）" if item.get("paired_audio") else "")
        )
    for item in report.get("items", {}).get("audios", []):
        lines.append(f"  音频{item['slot'] + 1}：{item['duration']:.2f}s")
    for item in report.get("blocked", []):
        lines.append(f"  ⛔ {item['source']}：{item['reason']}")
    for item in report.get("warnings", []):
        lines.append(f"  ⚠ {item}")
    return "\n".join(lines)


def dump_report(report):
    return json.dumps(report, ensure_ascii=False)
