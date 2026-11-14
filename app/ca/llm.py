"""Gemini 4 Argon through OpenRouter (OpenAI-compatible). Stdlib only.

CA_MOCK=1 swaps in a scripted fake so the whole pipeline runs offline in tests.
"""
import base64, json, os, re, urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = os.environ.get("CA_MODEL", "google/gemini-4-argon")
USAGE = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0}
_mock = []                                           # queued fake replies (tests)


def load_env(path=os.path.join(HERE, ".env")):
    """KEY=VALUE lines into os.environ (never overrides what is already set)."""
    try:
        for ln in open(path):
            k, eq, v = ln.strip().partition("=")
            if eq and k and not k.startswith("#"):
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except OSError:
        pass


load_env()


def mock(*replies):
    _mock.extend(replies)


def chat(system, user, images=(), json_mode=False, max_tokens=1500, temperature=0.2):
    """One completion. images = PNG/JPEG paths. Returns text (or a dict when json_mode)."""
    if os.environ.get("CA_MOCK") == "1":
        out = _mock.pop(0) if _mock else ('{"action":"done","reason":"mock"}' if json_mode else "ok")
        return parse_json(out) if json_mode else out
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY is not set (put it in app/.env)")
    content = [{"type": "text", "text": user}]
    for p in images:
        mime = "image/png" if p.endswith(".png") else "image/jpeg"
        content.append({"type": "image_url", "image_url": {
            "url": f"data:{mime};base64," + base64.b64encode(open(p, "rb").read()).decode()}})
    body = {"model": MODEL, "max_tokens": max_tokens, "temperature": temperature, "usage": {"include": True},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}]}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json",
        "X-Title": "ComputerAnything"})
    r = json.load(urllib.request.urlopen(req, timeout=120))
    if "error" in r:
        raise RuntimeError("OpenRouter: %s" % r["error"])
    u = r.get("usage") or {}
    USAGE["calls"] += 1
    USAGE["prompt_tokens"] += u.get("prompt_tokens", 0)
    USAGE["completion_tokens"] += u.get("completion_tokens", 0)
    USAGE["cost"] += float(u.get("cost") or 0)
    text = r["choices"][0]["message"]["content"] or ""
    return parse_json(text) if json_mode else text


def parse_json(text):
    """Model JSON, tolerant of ```json fences and leading prose."""
    if isinstance(text, dict):
        return text
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("no JSON object in model reply: %r" % text[:200])
    return json.loads(m.group(0))
