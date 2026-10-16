/**
 * Python 标准库模块名。
 *
 * 为什么要专门列出来：Python 的导入语句长得和第三方包一样，
 * 如果不区分，任何 Python 仓库的图里都会塞满 os / json / sys 这种噪音——
 * 而架构图的价值恰恰在于"只显示你需要关心的依赖"。
 *
 * 列表覆盖 Python 3.10+ 的常用标准库。宁可少列几个，也不要多列：
 * 漏掉一个只会多显示一个节点，多列一个会把真实依赖藏起来。
 */

export const PYTHON_STDLIB = new Set([
  '__future__', '_thread', 'abc', 'aifc', 'argparse', 'array', 'ast', 'asyncio',
  'atexit', 'base64', 'bdb', 'binascii', 'bisect', 'builtins', 'bz2', 'calendar',
  'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code', 'codecs', 'codeop', 'collections',
  'colorsys', 'compileall', 'concurrent', 'configparser', 'contextlib', 'contextvars',
  'copy', 'copyreg', 'cProfile', 'crypt', 'csv', 'ctypes', 'curses', 'dataclasses',
  'datetime', 'dbm', 'decimal', 'difflib', 'dis', 'doctest', 'email', 'encodings',
  'ensurepip', 'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput',
  'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'getopt', 'getpass',
  'gettext', 'glob', 'graphlib', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html',
  'http', 'idlelib', 'imaplib', 'imghdr', 'imp', 'importlib', 'inspect', 'io',
  'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3', 'linecache', 'locale',
  'logging', 'lzma', 'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes', 'mmap',
  'modulefinder', 'msilib', 'multiprocessing', 'netrc', 'nis', 'nntplib', 'numbers',
  'operator', 'optparse', 'os', 'ossaudiodev', 'pathlib', 'pdb', 'pickle',
  'pickletools', 'pipes', 'pkgutil', 'platform', 'plistlib', 'poplib', 'posix',
  'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile',
  'pyclbr', 'pydoc', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib',
  'resource', 'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors',
  'shelve', 'shlex', 'shutil', 'signal', 'site', 'smtplib', 'sndhdr', 'socket',
  'socketserver', 'spwd', 'sqlite3', 'ssl', 'stat', 'statistics', 'string',
  'stringprep', 'struct', 'subprocess', 'sunau', 'symtable', 'sys', 'sysconfig',
  'syslog', 'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios', 'textwrap',
  'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace',
  'traceback', 'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing',
  'unicodedata', 'unittest', 'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave',
  'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xdrlib', 'xml',
  'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', 'zoneinfo',
]);

/**
 * @param {string} pkg 包名（已去掉子模块后缀）
 * @returns {boolean}
 */
export function isPythonStdlib(pkg) {
  return PYTHON_STDLIB.has(pkg);
}
