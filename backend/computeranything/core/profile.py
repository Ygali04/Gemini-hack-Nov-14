"""User settings the UI can read and change: what the agents call you, the voice, the models.

Stored in CA_HOME/profile.json and applied to the running process on load and on every save.
"""

import json
import os

from . import runs

PATH = os.path.join(runs.HOME, "profile.json")
KEYS = ("call_me", "voice_id", "model", "decide_model", "agent_name")


def load():
    try:
        with open(PATH) as f:
            p = json.load(f)
        return {k: str(v) for k, v in p.items() if k in KEYS} if isinstance(p, dict) else {}
    except (OSError, ValueError):
        return {}


def apply(p=None):
    from . import llm

    p = load() if p is None else p
    if p.get("model"):
        llm.MODEL = p["model"]
    if "decide_model" in p:
        llm.DECIDE_MODEL = p["decide_model"] or None
    if p.get("voice_id"):
        os.environ["ELEVENLABS_VOICE_ID"] = p["voice_id"]


def save(updates):
    """Merge validated updates, persist, apply. Unknown keys are refused, not dropped silently."""
    bad = [k for k in updates if k not in KEYS]
    if bad:
        raise ValueError("unknown setting(s): %s" % ", ".join(bad))
    p = load()
    for k, v in updates.items():
        v = str(v or "").strip()
        if len(v) > 200 or any(c in v for c in "\r\n"):
            raise ValueError("%s: one line, at most 200 characters" % k)
        p[k] = v
    os.makedirs(os.path.dirname(PATH), exist_ok=True)
    with open(PATH, "w") as f:
        json.dump(p, f, indent=2)
    apply(p)
    return view()


def view():
    from . import llm

    p = load()
    return {
        "call_me": p.get("call_me", ""),
        "voice_id": os.environ.get("ELEVENLABS_VOICE_ID", ""),
        "model": llm.MODEL,
        "decide_model": llm.DECIDE_MODEL or "",
        "agent_name": p.get("agent_name", ""),
    }
