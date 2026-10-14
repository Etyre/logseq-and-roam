"""The sidecar map `roam-uid-map.json.gz` next to a graph (gzipped: GitHub refuses
files over 100 MB and the plain JSON is 108 MB). Readers accept the old plain
`roam-uid-map.json` too."""
import gzip
import json
import os

NAME = "roam-uid-map.json.gz"
LEGACY = "roam-uid-map.json"


def sidecar_path(graph_dir, explicit=None):
    if explicit:
        return explicit
    gz = os.path.join(graph_dir, NAME)
    if os.path.exists(gz):
        return gz
    legacy = os.path.join(graph_dir, LEGACY)
    return legacy if os.path.exists(legacy) else gz


def load_sidecar(path):
    if path.endswith(".gz"):
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_sidecar(path, data):
    if path.endswith(".gz"):
        with gzip.open(path, "wt", encoding="utf-8", compresslevel=6) as f:
            json.dump(data, f, ensure_ascii=False)
    else:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
