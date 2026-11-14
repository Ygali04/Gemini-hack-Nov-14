"""HTTPS with certificate checks always on. python.org builds of Python on macOS ship without a CA
bundle, so load certifi if present, else the system bundle at /etc/ssl/cert.pem."""

import os
import ssl
import urllib.request


def _context():
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    ctx = ssl.create_default_context()
    if os.path.exists("/etc/ssl/cert.pem"):
        ctx.load_verify_locations("/etc/ssl/cert.pem")
    return ctx


CTX = _context()


def urlopen(req, timeout=60):
    return urllib.request.urlopen(req, timeout=timeout, context=CTX)
