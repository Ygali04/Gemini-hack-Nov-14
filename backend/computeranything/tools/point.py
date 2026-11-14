#!/usr/bin/env python3
"""ComputerAnything agent: screenshot -> Gemini (OpenRouter) -> speak + point/draw/click.

Usage:
  python3 agent.py "where is the Wi-Fi menu?"
  echo "circle the close button" | python3 agent.py
  python3 agent.py --voice          # record 5 s, transcribe with ElevenLabs STT
  python3 agent.py --selftest       # offline checks
Stdlib only.
"""
import base64, json, os, re, shutil, stat, subprocess, sys, tempfile, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OVERLAY_BIN = os.path.join(HERE, "..", "..", "overlay", "overlay")
FIFO = os.environ.get("CA_FIFO", "")  # set by run.sh to a FIFO in a private 0700 dir
MODEL = os.environ.get("CA_MODEL", "google/gemini-4-argon")
VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")

SYSTEM = """You are ComputerAnything, a helper that can see the user's screen and has its own blue cursor.
Answer in one to three short spoken sentences (no markdown). Add tags to act on the screen, using
pixel coordinates of the attached screenshot (origin top-left):
  [POINT:x,y:label]        fly your cursor to an element and label it
  [DRAW:circle|rect|arrow:x,y,w,h]   draw a shape around a region (arrow goes from x,y to x+w,y+h)
  [HIGHLIGHT:x,y,w,h]      shade a region
  [CLICK:x,y]              click there (only when the user asks you to do something)
Point at the exact center of the element. Use at most three tags."""

TAG_RE = re.compile(r"\[(POINT|DRAW|HIGHLIGHT|CLICK):([^\]]*)\]")


def parse_tags(text):
    """Return (spoken_text, [ops]) with ops in screenshot pixel space."""
    ops = []
    for kind, body in TAG_RE.findall(text):
        try:
            if kind == "POINT":
                xy, _, label = body.partition(":")
                x, y = [float(v) for v in xy.split(",")[:2]]
                ops.append({"op": "point", "x": x, "y": y, "label": label.strip()})
            elif kind == "DRAW":
                shape, _, rest = body.partition(":")
                x, y, w, h = [float(v) for v in rest.split(",")[:4]]
                ops.append({"op": "draw", "shape": shape.strip().lower(), "x": x, "y": y, "w": w, "h": h})
            elif kind == "HIGHLIGHT":
                x, y, w, h = [float(v) for v in body.split(",")[:4]]
                ops.append({"op": "highlight", "x": x, "y": y, "w": w, "h": h})
            elif kind == "CLICK":
                x, y = [float(v) for v in body.split(",")[:2]]
                ops.append({"op": "click", "x": x, "y": y})
        except ValueError:
            continue
    spoken = re.sub(r"\s+", " ", TAG_RE.sub("", text)).strip()
    return spoken, ops


def scale_ops(ops, shot_size, screen_size):
    """Screenshot pixels -> screen points (main display only)."""
    # ponytail: main display only; multi-monitor needs per-display captures and origins.
    sx = screen_size[0] / shot_size[0]
    sy = screen_size[1] / shot_size[1]
    out = []
    for o in ops:
        o = dict(o)
        o["x"], o["y"] = round(o["x"] * sx, 1), round(o["y"] * sy, 1)
        if "w" in o:
            o["w"], o["h"] = round(o["w"] * sx, 1), round(o["h"] * sy, 1)
        out.append(o)
    return out


def screen_size_points():
    js = 'ObjC.import("AppKit"); var f=$.NSScreen.mainScreen.frame.size; f.width+","+f.height'
    out = subprocess.run(["osascript", "-l", "JavaScript", "-e", js], capture_output=True, text=True).stdout
    w, h = out.strip().split(",")
    return float(w), float(h)


def capture():
    path = os.path.join(tempfile.mkdtemp(prefix="ca-"), "shot.png")
    subprocess.run(["screencapture", "-x", "-C", path], check=True)
    subprocess.run(["sips", "-Z", "1280", path], capture_output=True, check=True)
    info = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
                          capture_output=True, text=True).stdout
    w = float(re.search(r"pixelWidth: (\d+)", info).group(1))
    h = float(re.search(r"pixelHeight: (\d+)", info).group(1))
    return path, (w, h)


def post_json(url, payload, headers):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def ask(prompt, png_path):
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("OPENROUTER_API_KEY is not set")
    b64 = base64.b64encode(open(png_path, "rb").read()).decode()
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
            ]},
        ],
    }
    raw = post_json("https://openrouter.ai/api/v1/chat/completions", body,
                    {"Authorization": "Bearer " + key, "X-Title": "ComputerAnything"})
    return json.loads(raw)["choices"][0]["message"]["content"]


def speak(text):
    if not text:
        return
    key = os.environ.get("ELEVENLABS_API_KEY")
    if key:
        try:
            mp3 = post_json(f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}",
                            {"text": text, "model_id": "eleven_flash_v2_5"},
                            {"xi-api-key": key, "Accept": "audio/mpeg"})
            path = os.path.join(tempfile.mkdtemp(prefix="ca-"), "say.mp3")
            open(path, "wb").write(mp3)
            subprocess.Popen(["afplay", path])
            return
        except Exception as e:
            print("ElevenLabs TTS failed, using say:", e, file=sys.stderr)
    subprocess.Popen(["say", text])


def listen():
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not (key and shutil.which("ffmpeg")):
        sys.exit("--voice needs ffmpeg and ELEVENLABS_API_KEY")
    wav = os.path.join(tempfile.mkdtemp(prefix="ca-"), "mic.wav")
    print("Listening for 5 s...", file=sys.stderr)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "avfoundation", "-i", ":0", "-t", "5", "-y", wav], check=True)
    boundary = "----ca" + os.urandom(8).hex()
    parts = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"model_id\"\r\n\r\nscribe_v1\r\n"
             f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"mic.wav\"\r\n"
             f"Content-Type: audio/wav\r\n\r\n").encode() + open(wav, "rb").read() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request("https://api.elevenlabs.io/v1/speech-to-text", data=parts,
                                 headers={"xi-api-key": key, "Content-Type": "multipart/form-data; boundary=" + boundary})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["text"]


def send_overlay(ops):
    """Write ops to the running overlay's FIFO (started by run.sh)."""
    try:
        st = os.lstat(FIFO) if FIFO else None
    except OSError:
        st = None
    if not st or not stat.S_ISFIFO(st.st_mode) or st.st_uid != os.getuid():
        print("overlay not running (no own FIFO at %r); ops: %s" % (FIFO, ops), file=sys.stderr)
        return
    with os.fdopen(os.open(FIFO, os.O_WRONLY | os.O_NOFOLLOW), "w") as f:
        for o in ops:
            f.write(json.dumps(o) + "\n")


def main(argv):
    if "--voice" in argv:
        prompt = listen()
        print("You said:", prompt)
    else:
        prompt = " ".join(a for a in argv if not a.startswith("--")) or sys.stdin.read().strip()
    if not prompt:
        sys.exit("usage: agent.py \"your question\"")
    png, shot = capture()
    reply = ask(prompt, png)
    spoken, ops = parse_tags(reply)
    ops = scale_ops(ops, shot, screen_size_points())
    print("Gemini:", reply)
    safe = [o for o in ops if o["op"] != "click"]
    send_overlay(safe)
    speak(spoken)
    for o in ops:
        if o["op"] == "click":
            ans = input(f"Click at ({o['x']}, {o['y']})? [y/N] ").strip().lower()
            if ans == "y":
                send_overlay([o])


def selftest():
    text = "The Save button is here. [POINT:640,360:Save] [DRAW:circle:600,340,80,40] [HIGHLIGHT:0,0,100,50] [CLICK:10,20] [POINT:bad]"
    spoken, ops = parse_tags(text)
    assert spoken == "The Save button is here.", spoken
    assert [o["op"] for o in ops] == ["point", "draw", "highlight", "click"], ops
    assert ops[0] == {"op": "point", "x": 640.0, "y": 360.0, "label": "Save"}
    assert ops[1]["shape"] == "circle" and ops[1]["w"] == 80.0
    # 1280x800 screenshot of a 1512x945 pt display (retina MacBook)
    s = scale_ops(ops, (1280, 800), (1512, 945))
    assert s[0]["x"] == 756.0 and s[0]["y"] == 425.2, s[0]
    assert s[1]["w"] == 94.5 and s[1]["h"] == 47.2, s[1]
    assert ops[0]["x"] == 640.0  # input not mutated
    assert scale_ops([], (1, 1), (1, 1)) == []
    print("selftest OK")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main(sys.argv[1:])
