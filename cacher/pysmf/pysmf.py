#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2022 Beherith <mysterme@gmail.com>
# SPDX-FileCopyrightText: 2022 Marek Rusinowski
# SPDX-License-Identifier: GPL-2.0-only
#
# Parses a map file, and returns its Spring Name
#
# Vendored from https://github.com/p2004a/pysmf (commit 6a04195, fork of
# https://github.com/Beherith/pysmf) and updated for py7zr >= 1.0, which
# removed SevenZipFile.read().
# Pre-import codec modules used by zipfile (cp437) and py7zr (utf_16_le);
# Python lazy-imports encodings via openat(), which seccomp blocks after lockdown().
import encodings.cp437
import encodings.utf_16_le
import errno
import json
import resource
import sys
import zipfile
import py7zr
import py7zr.io
import seccomp
# Maps are written for the engine's Lua 5.1 (e.g. tostring(1.0) == "1"), so
# pin it instead of using the lupa default (Lua 5.5).
import lupa.lua51 as lupa

# Avoid py7zr lazy-importing psutil and reading /proc/meminfo under seccomp.
py7zr.py7zr.get_memory_limit = lambda: 32 * 1024 * 1024

# mapinfo.lua is a small text file, anything bigger than that is suspicious.
MAPINFO_SIZE_LIMIT = 4 * 1024 * 1024
# Base Python+py7zr+lupa VmPeak is ~35 MiB plus the LZMA2 dictionary size.
# 768 MiB accommodates up to a 512 MiB LZMA2 dictionary + 32 MiB chunk buffer
# while staying below the 1 GiB Cloud Run container limit.
PROCESS_MEMORY_LIMIT = 768 * 1024 * 1024
PROCESS_CPU_LIMIT = 55

# Pure in-memory + already-open-FD syscalls only (no open/socket/exec/fork/clone/ptrace).
ALLOWED_SYSCALLS = (
	"read",
	"write",
	"lseek",
	"close",
	"getcwd",
	"brk",
	"mmap",
	"mremap",
	"munmap",
	"rt_sigaction",
	# py7zr calls time.time() during extraction; normally answered via vDSO
	# without a syscall, but allowed in case Cloud Run's kernel falls back to it.
	"clock_gettime",
	"exit_group",
)

class SmfParseError(Exception):
	pass

def lockdown():
	resource.setrlimit(resource.RLIMIT_CPU, (PROCESS_CPU_LIMIT, PROCESS_CPU_LIMIT))
	resource.setrlimit(resource.RLIMIT_AS, (PROCESS_MEMORY_LIMIT, PROCESS_MEMORY_LIMIT))

	f = seccomp.SyscallFilter(defaction=seccomp.KILL_PROCESS)
	# py7zr's Path.resolve() probes mapinfo.lua on disk even with BytesIOFactory.
	f.add_rule(seccomp.ERRNO(errno.EPERM), "newfstatat")
	for name in ALLOWED_SYSCALLS:
		f.add_rule(seccomp.ALLOW, name)
	f.load()

def parse_mapinfo(rawmapinfo):
	lua = lupa.LuaRuntime(unpack_returned_tuples=True)
	lua.execute("""
		local keep = {
			_G=1, _VERSION=1, assert=1, error=1, getmetatable=1,
			ipairs=1, math=1, next=1, pairs=1, pcall=1, rawequal=1, rawget=1,
			rawset=1, select=1, setmetatable=1, string=1, table=1, tonumber=1,
			tostring=1, type=1, unpack=1, xpcall=1,
		}
		for k in pairs(_G) do
			if not keep[k] then _G[k] = nil end
		end
		print = function() end
	""")
	try:
		lua_func = lua.eval('function ()\n' +
							'local function getfenv() return {} end \n ' +
							'local VFS = {}\n' +
							'VFS.DirList = function () return {} end \n' +
							rawmapinfo + '\n end')
		lua_res = lua_func()
	except lupa.LuaError as l:
		raise SmfParseError('Failed to execute mapinfo.lua') from l

	if lupa.lua_type(lua_res) != 'table' or not (
			'modtype' in lua_res and 'version' in lua_res and 'name' in lua_res):
		raise SmfParseError('mapinfo.lua returned data missing required properties')

	if lua_res['modtype'] != 3:
		raise SmfParseError('This is not a map, modtype != 3')

	mapname = lua_res['name']
	if not isinstance(mapname, str):
		raise SmfParseError('mapinfo.lua name must be a string')

	raw_version = lua_res['version']
	if isinstance(raw_version, bool) or not isinstance(raw_version, (str, int, float)):
		raise SmfParseError('mapinfo.lua version must be a string or number')
	mapversion = str(raw_version)

	if mapname.endswith(mapversion):
		return mapname
	return f"{mapname} {mapversion}"

def get_smfname(filelist):
	for zfile in filelist:
		if 'maps/' in zfile.lower() and zfile.lower().endswith('.smf'):
			return zfile.rpartition('/')[2][:-4]
	raise SmfParseError('failed to find smfname in file list')

# Returns the SpringName of the archive opened at fileobj
def pysmf(fileobj, filename):
	if filename.lower().endswith('.sd7'):
		with py7zr.SevenZipFile(fileobj, mode='r') as mapfile:
			names = mapfile.getnames()
			if 'mapinfo.lua' in names:
				factory = py7zr.io.BytesIOFactory(MAPINFO_SIZE_LIMIT)
				mapfile.extract(targets=['mapinfo.lua'], factory=factory)
				mapinfo = factory.get('mapinfo.lua')
				if mapinfo.size() >= MAPINFO_SIZE_LIMIT:
					raise SmfParseError('mapinfo.lua is too big')
				mapinfo.seek(0)
				return parse_mapinfo(mapinfo.read().decode("utf-8"))
			else: # look for .smf file
				return get_smfname(names)
	elif filename.lower().endswith('.sdz'):
		with zipfile.ZipFile(fileobj) as sdz:
			mapinfopath = zipfile.Path(sdz, at = 'mapinfo.lua')
			if mapinfopath.is_file():
				with mapinfopath.open(mode = 'rb') as mapinfofile:
					data = mapinfofile.read(MAPINFO_SIZE_LIMIT + 1)
				if len(data) > MAPINFO_SIZE_LIMIT:
					raise SmfParseError('mapinfo.lua is too big')
				return parse_mapinfo(data.decode("utf-8"))
			else: # look for .smf file
				return get_smfname([zipinfo.filename for zipinfo in sdz.infolist()])
	raise SmfParseError(f'{filename} is not a recognized .sdz or .sd7 archive')

if __name__ == "__main__":
	try:
		filepath = sys.argv[1]
		with open(filepath, "rb") as fileobj:
			lockdown()
			springname = pysmf(fileobj, filepath)
		print(json.dumps({"springname": springname}))
	except Exception as e:
		print(f'{type(e).__name__}: {e}', file=sys.stderr)
		sys.exit(2)
