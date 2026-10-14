"""Minimal client for Logseq's built-in HTTP API server (file-graph version).

Enable it in Logseq: Settings → Features → HTTP APIs server, then start the server
from the API icon in the toolbar and add an authorization token. The token is read
from, in order: the `token` argument, the LOGSEQ_API_TOKEN environment variable, or
the file ~/.ankify_logseq/logseq_api_token.
"""
import json
import os
import subprocess
import urllib.error
import urllib.request

DEFAULT_URL = "http://127.0.0.1:12315/api"
TOKEN_FILE = os.path.expanduser("~/.ankify_logseq/logseq_api_token")


class LogseqApiError(Exception):
    pass


def read_token(token=None):
    if token:
        return token
    if os.environ.get("LOGSEQ_API_TOKEN"):
        return os.environ["LOGSEQ_API_TOKEN"]
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    return None


class LogseqApi:
    def __init__(self, url=DEFAULT_URL, token=None, timeout=30):
        self.url = url
        self.token = read_token(token)
        self.timeout = timeout

    def call(self, method, *args):
        body = json.dumps({"method": method, "args": list(args)}).encode()
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        req = urllib.request.Request(self.url, body, headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                data = res.read()
        except urllib.error.HTTPError as e:
            raise LogseqApiError(f"{method}: HTTP {e.code} {e.read()[:200]!r}")
        except urllib.error.URLError as e:
            raise LogseqApiError(f"{method}: cannot reach Logseq API at {self.url} ({e.reason})")
        if not data:
            return None
        out = json.loads(data)
        if isinstance(out, dict) and out.get("error") and set(out) <= {"error", "statusCode", "message"}:
            raise LogseqApiError(f"{method}: {out}")
        return out

    def reachable(self):
        try:
            self.call("logseq.App.getCurrentGraph")
            return True
        except LogseqApiError:
            return False

    def current_graph(self):
        """{'name':..., 'path':...} of the graph Logseq has open, or None."""
        return self.call("logseq.App.getCurrentGraph")

    def page_blocks_tree(self, page_name):
        return self.call("logseq.Editor.getPageBlocksTree", page_name) or []

    def get_block(self, uuid):
        return self.call("logseq.Editor.getBlock", uuid)

    def upsert_block_property(self, uuid, key, value):
        return self.call("logseq.Editor.upsertBlockProperty", uuid, key, value)


def logseq_process_running():
    """True if a Logseq desktop app (OG or classic) process exists on this machine."""
    try:
        res = subprocess.run(["pgrep", "-f", r"Logseq(-OG)?\.app/Contents/MacOS/"], capture_output=True)
        return res.returncode == 0
    except Exception:
        return False
