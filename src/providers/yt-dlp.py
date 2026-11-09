"""Fetch one video's metadata and, optionally, one caption track."""

import json
import sys
import time
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qs, urlsplit

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError


class YoutubeClient(YoutubeDL):
    rate_limited = False
    retry_after_ms = 0

    def urlopen(self, request):
        try:
            return super().urlopen(request)
        except Exception as error:
            if getattr(error, "status", None) == 429:
                self.rate_limited = True
                header = getattr(getattr(error, "response", None), "headers", {}).get("Retry-After")
                if header:
                    try:
                        seconds = int(header) if header.isdecimal() else parsedate_to_datetime(header).timestamp() - time.time()
                        self.retry_after_ms = max(self.retry_after_ms, int(seconds * 1000))
                    except (TypeError, ValueError, OverflowError):
                        pass
            raise


def native_track(tracks, language):
    if not language:
        return None
    base = language.split("-")[0]
    for key in dict.fromkeys([language, *tracks]):
        if key not in tracks or key.split("-")[0] != base or key.endswith("-orig"):
            continue
        if any(not translated(track) for track in tracks[key]):
            return key


def translated(track):
    return bool(parse_qs(urlsplit(track["url"]).query).get("tlang"))


def select_track(info):
    manual = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}
    originals = [key for key in auto if key.endswith("-orig")]
    language = info.get("language") or next(
        (fmt["language"] for fmt in info.get("formats", [])
         if fmt.get("language") and (fmt.get("language_preference") or 0) > 0),
        None,
    )
    if len(originals) == 1:
        language = originals[0][:-5]
    original_auto = next(
        (key for key in originals if language and key[:-5].split("-")[0] == language.split("-")[0]),
        None,
    )
    for tracks, key, kind, allow_translation in (
        (manual, native_track(manual, language), "manual", False),
        (auto, original_auto or native_track(auto, language), "automatic", False),
        (manual, native_track(manual, "en"), "manual", False),
        (auto, native_track(auto, "en") or ("en" if "en" in auto else None), "automatic", True),
    ):
        for track in tracks.get(key, []):
            if track["ext"] == "json3" and (allow_translation or not translated(track)):
                return key.removesuffix("-orig"), kind, track


def transcript(client, info, caption_delay):
    selected = select_track(info)
    if selected is None:
        return {"status": "no_captions"}
    language, kind, track = selected
    target = urlsplit(track["url"])
    if (target.scheme, target.hostname, target.path) != (
        "https", "www.youtube.com", "/api/timedtext"
    ):
        return {"status": "unavailable"}

    time.sleep(caption_delay)
    try:
        with client.urlopen(track["url"]) as response:
            body = response.read(2_000_001)
        if len(body) > 2_000_000:
            return {"status": "unavailable"}
        segments = []
        for event in json.loads(body).get("events", []):
            text = "".join(segment.get("utf8", "") for segment in event.get("segs", [])).strip()
            if text and isinstance(event.get("tStartMs"), int):
                segments.append({"start_seconds": event["tStartMs"] / 1000, "text": text})
    except Exception:
        return {"status": "rate_limited" if client.rate_limited else "unavailable"}

    if not segments:
        return {"status": "unavailable"}
    return {
        "status": "ok", "language": language, "kind": kind,
        "translated": translated(track), "segments": segments,
    }


def fetch(video_id, include_transcript, request_gap):
    with YoutubeClient({
        "quiet": True, "skip_download": True, "noplaylist": True,
        "socket_timeout": 10, "extractor_retries": 0, "retries": 0,
        "sleep_interval_requests": request_gap,
        "extractor_args": {"youtube": {"skip": ["hls", "dash"]}},
    }) as client:
        url = "https://www.youtube.com/watch?v=" + video_id
        try:
            info = client.extract_info(url, download=False)
        except DownloadError:
            return {"error": "rate_limited" if client.rate_limited else "unavailable",
                    "retry_after_ms": client.retry_after_ms}
        result = {"url": url}
        for field in ("title", "channel", "description", "channel_id", "uploader_id"):
            if isinstance(info.get(field), str):
                result[field] = info[field]
        duration = info.get("duration")
        if isinstance(duration, (int, float)):
            result["duration"] = duration
        if info.get("chapters"):
            result["chapters"] = [
                {"start_seconds": chapter["start_time"], "title": chapter["title"]}
                for chapter in info["chapters"]
                if isinstance(chapter.get("start_time"), (int, float))
                and isinstance(chapter.get("title"), str)
            ]
        date = info.get("upload_date")
        if date:
            result["upload_date"] = f"{date[:4]}-{date[4:6]}-{date[6:]}"
        if include_transcript:
            result["transcript"] = ({"status": "rate_limited"} if client.rate_limited
                                    else transcript(client, info, request_gap))
        if client.rate_limited:
            result["rate_limited"] = True
            result["retry_after_ms"] = client.retry_after_ms
        return result


if __name__ == "__main__":
    print(json.dumps(fetch(sys.argv[1], sys.argv[2] == "true",
                           int(sys.argv[3]) / 1000), ensure_ascii=False))
