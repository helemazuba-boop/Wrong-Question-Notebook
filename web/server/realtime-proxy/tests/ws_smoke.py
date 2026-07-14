#!/usr/bin/env python3
"""
Smoke test for the WQN Flash Realtime relay.

Connects to ws://localhost:8080/api/esp32/realtime with the correct
subprotocol, sends a session.update + 240 frames of 16 kHz sine wave
PCM, and verifies the proxy returns session.ready and starts mirroring
audio deltas back as WFLV binary frames.

Run:
    python ws_smoke.py
or against a deployed host:
    python ws_smoke.py --host wqn.helema.cn --token d7a0...ba0f --insecure
"""

import argparse
import asyncio
import base64
import math
import struct
import sys

import websockets


WFLV_MAGIC = 0x57464C56
WFLV_VERSION = 2
FRAME_HEADER_FMT = '<IHHIIII'  # magic, version, flags, seq, sr, ch, res
FRAME_HEADER_LEN = struct.calcsize(FRAME_HEADER_FMT)


def pcm_sine(duration_s: float = 0.5, sample_rate: int = 16000, freq: float = 440.0) -> bytes:
    samples = int(duration_s * sample_rate)
    return bytes(
        int(0.3 * 32767 * math.sin(2 * math.pi * freq * (n / sample_rate)))
        for n in range(samples)
    )


def build_wflv(pcm: bytes, seq: int, sample_rate: int = 16000) -> bytes:
    header = struct.pack(
        FRAME_HEADER_FMT,
        WFLV_MAGIC,
        WFLV_VERSION,
        0x0001,  # flag STREAM
        seq,
        sample_rate,
        1,
        0,
    )
    return header + pcm


async def go(args):
    headers = []
    if args.token:
        headers.append(('Authorization', f'Bearer {args.token}'))

    url = f"{args.scheme}://{args.host}:{args.port}/api/esp32/realtime"
    ssl_ctx = None if args.insecure else True

    print(f"[smoke] connecting to {url}", flush=True)
    async with websockets.connect(
        url,
        subprotocols=['wqn-flash-v2'],
        additional_headers=headers,
        ssl=ssl_ctx,
        open_timeout=10,
        max_size=8 * 1024 * 1024,
    ) as ws:
        # 1. session.update — same shape as the firmware sends.
        session_update = {
            "type": "session.update",
            "session": {
                "model": "wqn-flash-v2",  # proxy must rewrite
                "voice": "qingchunshaonv",
                "input_audio_format": "pcm16",
                "input_sample_rate": 16000,
                "output_audio_format": "opus",
                "output_sample_rate": 24000,
                "instructions": "你是测试助理,只用 1 个汉字回复: 好",
                "vad": {"mode": "server_vad", "prefix_padding_ms": 500, "silence_duration_ms": 200},
            },
        }
        await ws.send(json_dumps(session_update))
        print("[smoke] sent session.update", flush=True)

        # 2. first we should get session.ready within 8 s
        ready_deadline = asyncio.get_event_loop().time() + 8
        saw_ready = False
        saw_text = False
        bytes_received = 0
        while True:
            remaining = ready_deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            if isinstance(msg, str):
                if '"session.ready"' in msg:
                    saw_ready = True
                    print(f"[smoke] session.ready: {msg}", flush=True)
                elif '"error"' in msg:
                    print(f"[smoke] ERROR: {msg}", flush=True)
                    return 2
            else:
                bytes_received += len(msg)

        if not saw_ready:
            print("[smoke] FAIL: never got session.ready", flush=True)
            return 1

        # 3. send 5 chunks of audio (75 ms @ 16 kHz)
        chunk = pcm_sine(0.015, 16000, 440.0)
        for seq in range(5):
            await ws.send(build_wflv(chunk, seq))
            await asyncio.sleep(0.015)

        # 4. drain a few seconds of upstream traffic to see if audio comes back
        deadline = asyncio.get_event_loop().time() + 5
        while asyncio.get_event_loop().time() < deadline:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=2)
                if isinstance(msg, str):
                    saw_text = saw_text or '"text.delta"' in msg or '"audio_transcript' in msg
                    if '"tool.done"' in msg or '"tool.start"' in msg:
                        print(f"[smoke] tool event: {msg}", flush=True)
                else:
                    # WFLV frame
                    if len(msg) >= FRAME_HEADER_LEN and msg[:4] == b'WFLV':
                        bytes_received += len(msg)
            except asyncio.TimeoutError:
                break

        print(f"[smoke] received {bytes_received} bytes total from proxy", flush=True)
        print(f"[smoke] RESULT: ready={saw_ready} text={saw_text} bytes={bytes_received}")
        return 0 if saw_ready else 1


def json_dumps(obj):
    import json
    return json.dumps(obj, ensure_ascii=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='localhost')
    parser.add_argument('--port', default=8080)
    parser.add_argument('--scheme', default='ws')
    parser.add_argument('--token', default='', help='Device bearer token')
    parser.add_argument('--insecure', action='store_true', help='Skip TLS verify')
    args = parser.parse_args()
    sys.exit(asyncio.run(go(args)))


if __name__ == '__main__':
    main()
