"""Tooling for the Roam → Logseq migration (and back). See ../import-issues.md and
../reversibility.md for the why. Reuses ankify_logseq's parser."""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ANKIFY = os.path.normpath(os.path.join(_HERE, "..", "..", "ankify_logseq"))
if _ANKIFY not in sys.path:
    sys.path.insert(0, _ANKIFY)
