"""桃源 H3 素材装载 —— 预览缓存 + 本地 HTTP 路由。

面板里的缩略图/波形是跟着报告（base64）走的，小、够看；但「点开大图」「播放视频」「试听音频」
需要完整数据，塞进报告会把工作流 JSON 撑爆。所以执行时把放行的素材就地压成 JPEG / MP4 / WAV，
按 token 存在进程内存里，前端点开时再按 token 来取。

只保留最近几次执行（默认 6 个 token），旧的自然淘汰，不会无限涨。
"""

from __future__ import annotations

import io
import threading
import time
import uuid
from collections import OrderedDict

from taoyuan_h3_media import (
    AUDIO_CAP,
    IMAGE_CAP,
    OUT_AUDIO_BASE,
    OUT_IMAGE_BASE,
    OUT_PAIRED_BASE,
    OUT_VIDEO_BASE,
    VIDEO_CAP,
)

MAX_TOKENS = 6
TTL_SECONDS = 3600.0

# 预览尺寸：大图 1024 够看清脸，视频压到 384 宽足够判断内容，音频整段给。
IMAGE_MAX_SIDE = 1024
IMAGE_QUALITY = 82
VIDEO_MAX_SIDE = 384
VIDEO_CRF = 30
AUDIO_MAX_SECONDS = 60.0

_CACHE: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()
_LOCK = threading.Lock()
_ROUTES_REGISTERED = False


# ------------------------------------------------------------------ 缓存

def put(bundle: dict) -> str:
    token = uuid.uuid4().hex[:16]
    with _LOCK:
        _CACHE[token] = (time.time(), bundle)
        while len(_CACHE) > MAX_TOKENS:
            _CACHE.popitem(last=False)
    return token


def _get(token):
    if not token:
        return None
    with _LOCK:
        item = _CACHE.get(token)
        if not item:
            return None
        created, bundle = item
        if time.time() - created > TTL_SECONDS:
            _CACHE.pop(token, None)
            return None
        _CACHE.move_to_end(token)
        return bundle


# ------------------------------------------------------------------ 编码

def _resize_u8(frames, max_side=None):
    """[N,H,W,C] 张量 → [N,h,w,3] uint8；按 max_side 等比缩小（整批一次插值）。"""
    import torch

    x = frames.float()
    height, width = int(x.shape[1]), int(x.shape[2])
    if height < 1 or width < 1:
        return None
    if max_side:
        scale = float(max_side) / float(max(height, width))
        if scale < 1.0:
            new_h = max(1, int(round(height * scale)))
            new_w = max(1, int(round(width * scale)))
            x = x.permute(0, 3, 1, 2)
            x = torch.nn.functional.interpolate(
                x, size=(new_h, new_w), mode="bilinear", align_corners=False
            )
            x = x.permute(0, 2, 3, 1)
    array = x.clamp(0.0, 1.0).mul(255.0).round().to(torch.uint8).cpu().numpy()
    if array.ndim != 4:
        return None
    return array[:, :, :, :3]


def image_jpeg(frames, max_side=IMAGE_MAX_SIDE, quality=IMAGE_QUALITY):
    """第一帧 → JPEG 字节。给「点开看大图」用。"""
    from PIL import Image

    array = _resize_u8(frames[:1], max_side)
    if array is None:
        return b""
    buffer = io.BytesIO()
    Image.fromarray(array[0], mode="RGB").save(buffer, format="JPEG", quality=quality)
    return buffer.getvalue()


def video_mp4(frames, fps=24.0, max_side=VIDEO_MAX_SIDE, crf=VIDEO_CRF):
    """整段帧 → 无声 H.264 MP4，给「点开播放」用。编码失败返回空。"""
    import av

    array = _resize_u8(frames, max_side)
    if array is None or len(array) < 1:
        return b""
    height = int(array.shape[1]) - int(array.shape[1]) % 2
    width = int(array.shape[2]) - int(array.shape[2]) % 2
    if height < 2 or width < 2:
        return b""
    rate = max(1, int(round(float(fps) or 24.0)))
    buffer = io.BytesIO()
    container = av.open(buffer, mode="w", format="mp4")
    try:
        stream = container.add_stream("libx264", rate=rate)
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuv420p"
        stream.options = {"crf": str(crf), "preset": "veryfast"}
        for frame in array:
            frame = frame[:height, :width]
            for packet in stream.encode(av.VideoFrame.from_ndarray(frame, format="rgb24")):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    finally:
        container.close()
    return buffer.getvalue()


def audio_wav(audio, max_seconds=AUDIO_MAX_SECONDS):
    """AUDIO → 16bit PCM WAV，给「点开试听」用。"""
    import wave

    import numpy as np

    if not isinstance(audio, dict):
        return b""
    waveform = audio.get("waveform")
    try:
        sample_rate = int(audio.get("sample_rate") or 0)
    except Exception:
        sample_rate = 0
    if waveform is None or sample_rate <= 0 or not hasattr(waveform, "shape"):
        return b""
    data = waveform
    if data.dim() == 3:
        data = data[0]
    if data.dim() == 1:
        data = data.unsqueeze(0)
    if data.dim() != 2:
        return b""
    data = data.float().cpu().numpy()
    channels = int(data.shape[0])
    if channels < 1:
        return b""
    if channels > 2:
        data = data[:2]
        channels = 2
    limit = int(min(data.shape[1], sample_rate * float(max_seconds or 60.0)))
    if limit < 1:
        return b""
    pcm = (np.clip(data[:, :limit].T, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm)
    return buffer.getvalue()


# ------------------------------------------------------------------ 组包

def build_bundle(outs, fps=24.0):
    """把 18 个素材输出压成一份可预览的数据；失败就返回 None（不影响主流程）。"""
    try:
        images = [image_jpeg(outs[OUT_IMAGE_BASE + i]) for i in range(IMAGE_CAP)
                  if outs[OUT_IMAGE_BASE + i] is not None]
        videos = [video_mp4(outs[OUT_VIDEO_BASE + i], fps=fps) for i in range(VIDEO_CAP)
                  if outs[OUT_VIDEO_BASE + i] is not None]
        audios = [audio_wav(outs[OUT_AUDIO_BASE + i]) for i in range(AUDIO_CAP)
                  if outs[OUT_AUDIO_BASE + i] is not None]
        paired = [audio_wav(outs[OUT_PAIRED_BASE + i]) for i in range(AUDIO_CAP)
                  if outs[OUT_PAIRED_BASE + i] is not None]
    except Exception:
        return None
    return {
        "fps": float(fps or 24.0),
        "images": images,
        "videos": videos,
        "audios": audios,
        "video_audios": paired,
    }


# ------------------------------------------------------------------ 路由

def register_routes():
    """把预览路由挂到 ComfyUI 的 aiohttp 上；环境不满足就安静返回 False。"""
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED:
        return True
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return False
    instance = getattr(PromptServer, "instance", None)
    routes = getattr(instance, "routes", None)
    if routes is None or not hasattr(routes, "get"):
        return False
    if getattr(routes, "_ty_h3_registered", False):
        _ROUTES_REGISTERED = True
        return True

    def _index(raw, upper):
        try:
            value = int(raw or 0)
        except Exception:
            return -1
        return value if 0 <= value < upper else -1

    @routes.get("/ty_h3/image")
    async def ty_h3_image(request):
        bundle = _get(request.query.get("t"))
        index = _index(request.query.get("i"), IMAGE_CAP)
        if not bundle or index < 0 or index >= len(bundle["images"]):
            return web.Response(status=404)
        body = bundle["images"][index]
        if not body:
            return web.Response(status=404)
        return web.Response(body=body, content_type="image/jpeg",
                            headers={"Cache-Control": "max-age=600"})

    @routes.get("/ty_h3/video")
    async def ty_h3_video(request):
        bundle = _get(request.query.get("t"))
        index = _index(request.query.get("i"), VIDEO_CAP)
        if not bundle or index < 0 or index >= len(bundle["videos"]):
            return web.Response(status=404)
        body = bundle["videos"][index]
        if not body:
            return web.Response(status=404)
        return web.Response(body=body, content_type="video/mp4",
                            headers={"Accept-Ranges": "bytes", "Cache-Control": "max-age=600"})

    @routes.get("/ty_h3/audio")
    async def ty_h3_audio(request):
        bundle = _get(request.query.get("t"))
        key = request.query.get("k") or "audios"
        if key not in ("audios", "video_audios"):
            key = "audios"
        index = _index(request.query.get("i"), AUDIO_CAP)
        if not bundle or index < 0 or index >= len(bundle[key]):
            return web.Response(status=404)
        body = bundle[key][index]
        if not body:
            return web.Response(status=404)
        return web.Response(body=body, content_type="audio/wav",
                            headers={"Accept-Ranges": "bytes", "Cache-Control": "max-age=600"})

    _ROUTES_REGISTERED = True
    try:
        routes._ty_h3_registered = True
    except Exception:
        pass
    return True
