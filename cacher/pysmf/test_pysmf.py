#!/usr/bin/env python3
"""Regression test for pysmf.py: run after dependency or base image updates."""
import json, os, signal, subprocess, sys, tempfile, zipfile
import py7zr

PYSMF = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pysmf.py")
# tostring(9.0) == "9" pins Lua 5.1; the assert pins the global scrub.
MAPINFO = '''
assert(not (python or os or io or debug or require or loadstring))
return { name = "Map", version = tostring(9.0), modtype = 3 }
'''

def run(path):
	return subprocess.run([sys.executable, PYSMF, path], capture_output=True, text=True, timeout=30)

with tempfile.TemporaryDirectory() as td:
	sd7, sdz, ppmd = f"{td}/m.sd7", f"{td}/m.sdz", f"{td}/ppmd.sd7"
	with py7zr.SevenZipFile(sd7, "w") as z:
		z.writestr(MAPINFO, "mapinfo.lua")
	with zipfile.ZipFile(sdz, "w") as z:
		z.writestr("mapinfo.lua", MAPINFO)
	with py7zr.SevenZipFile(ppmd, "w", filters=[{"id": py7zr.FILTER_PPMD}]) as z:
		z.writestr(MAPINFO, "mapinfo.lua")

	for path in (sd7, sdz):
		r = run(path)
		assert r.returncode == 0 and json.loads(r.stdout)["springname"] == "Map 9", (path, r)

	# PPMd needs a thread, which the filter forbids: proves the sandbox is
	# active in the real entry point and kills instead of hanging.
	r = run(ppmd)
	assert r.returncode == -signal.SIGSYS, r
print("pysmf tests passed")
