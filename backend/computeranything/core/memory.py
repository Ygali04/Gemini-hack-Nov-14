"""Facts remembered about the user across runs, stored under CA_HOME."""

import json
import os
import secrets
import tempfile
import threading
import time

_lock = threading.Lock()


def _path():
    home = os.path.expanduser(os.environ.get("CA_HOME", "~/.computeranything"))
    return os.path.join(home, "memory.json")


def _load():
    try:
        with open(_path()) as f:
            data = json.load(f)
        return [x for x in data if isinstance(x, dict) and "id" in x and "text" in x] if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save(facts):
    p = _path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        json.dump(facts, f, indent=2)


def list_facts():
    with _lock:
        return _load()


def add(text, run=None):
    text = str(text or "").strip()
    if not text:
        raise ValueError("empty fact")
    fact = {"id": "m-" + secrets.token_hex(6), "text": text, "ts": time.time(), "run": run}
    with _lock:
        facts = _load()
        facts.append(fact)
        _save(facts)
    return fact


def delete(fid):
    with _lock:
        facts = _load()
        kept = [f for f in facts if f.get("id") != fid]
        if len(kept) == len(facts):
            return False
        _save(kept)
        return True


def forget_all():
    with _lock:
        _save([])
    return True


def selftest():
    prev = os.environ.get("CA_HOME")
    with tempfile.TemporaryDirectory(prefix="ca_mem_") as tmp:
        os.environ["CA_HOME"] = tmp
        try:
            assert list_facts() == []
            f1 = add("prefers dark mode", run="r1")
            f2 = add("uses Calculator", run="r2")
            assert f1["run"] == "r1" and isinstance(f1["ts"], float)
            got = list_facts()
            assert [x["id"] for x in got] == [f1["id"], f2["id"]]
            assert delete(f1["id"]) is True
            assert delete("nonexistent") is False
            assert [x["id"] for x in list_facts()] == [f2["id"]]
            assert forget_all() is True
            assert list_facts() == []
        finally:
            if prev is None:
                os.environ.pop("CA_HOME", None)
            else:
                os.environ["CA_HOME"] = prev
    print("memory selftest OK")


if __name__ == "__main__":
    selftest()
