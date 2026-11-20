"""Exercise the built TUI in a real PTY with isolated transcripts and fake CLIs."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

BINARY = str(Path(__file__).resolve().parents[1] / 'bin' / 'search-chats.js')
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')

with tempfile.TemporaryDirectory(prefix='chat-tui-') as temp:
    root = Path(temp).resolve()
    project = root / "project ' $(false)"
    project.mkdir()
    codex = root / 'codex'
    (codex / 'sessions').mkdir(parents=True)
    claude = root / 'claude' / 'project'
    claude.mkdir(parents=True)
    stub_bin = root / 'bin'
    stub_bin.mkdir()
    record = root / 'resumed.json'
    for agent in ['codex', 'claude']:
        stub = stub_bin / agent
        stub.write_text('#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\nPath(os.environ["CHAT_TUI_RECORD"]).write_text(json.dumps({"agent":Path(sys.argv[0]).name,"args":sys.argv[1:],"cwd":os.getcwd()}))\n')
        stub.chmod(0o755)
    def rows(file, entries, age):
        file.write_text('\n'.join(json.dumps(row, separators=(',', ':')) for row in entries) + '\n')
        os.utime(file, (time.time() - age, time.time() - age))
    cid = "codex';$(false)"
    rows(codex / 'sessions' / 'new.jsonl', [
        {'type': 'session_meta', 'payload': {'id': cid, 'cwd': str(project), 'thread_source': 'user', 'source': 'cli'}},
        {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'Newest Codex chat'}]}},
        {'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Codex transcript body'}]}},
    ], 0)
    rows(claude / 'claude-session.jsonl', [
        {'type': 'user', 'cwd': str(project), 'message': {'content': 'Older Claude chat'}},
        {'type': 'assistant', 'message': {'content': 'Claude transcript body'}},
    ], 100)
    env = dict(os.environ, SEARCH_CHATS_CODEX_DIR=str(codex), SEARCH_CHATS_CLAUDE_DIR=str(claude.parent),
               SEARCH_CHATS_CURSOR_DIR=str(root / 'none'), SEARCH_CHATS_DEVIN_DIR=str(root / 'none'),
               XDG_CACHE_HOME=str(root / 'cache'), CHAT_TUI_RECORD=str(record), PATH=str(stub_bin) + ':' + os.environ['PATH'])

    class Terminal:
        def __init__(self, args=()):
            self.master, slave = pty.openpty()
            self.slave = slave
            self.before = termios.tcgetattr(slave)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 120, 0, 0))
            self.proc = subprocess.Popen([BINARY, '--local', *args], stdin=slave, stdout=slave, stderr=slave, env=env)
            self.output = b''
        def read(self, duration=.2):
            until = time.monotonic() + duration
            while time.monotonic() < until:
                ready, _, _ = select.select([self.master], [], [], max(0, until-time.monotonic()))
                if not ready: break
                try: self.output += os.read(self.master, 65536)
                except OSError: break
            return ANSI.sub('', self.output.decode(errors='replace'))
        def wait_for(self, text):
            until = time.monotonic() + 5
            while time.monotonic() < until:
                if text in self.read(.05): return
            raise AssertionError(f'Missing {text!r}: {self.output[-1000:]!r}')
        def send(self, data):
            self.output = b''
            os.write(self.master, data)
        def wait_exit(self):
            until = time.monotonic() + 5
            while time.monotonic() < until:
                self.read(.05)
                if self.proc.poll() is not None: return
            raise AssertionError(f'Did not exit: {ANSI.sub("", self.output.decode(errors="replace"))[-3000:]}')
        def close(self):
            if self.proc.poll() is None:
                os.write(self.master, b'\x03')
            self.wait_exit()
            self.read(.05)
            assert b'\x1b[?1049l' in self.output, 'alternate screen not restored'
            after = termios.tcgetattr(self.slave)
            assert after == self.before, 'terminal modes not restored'
            os.close(self.master)
            os.close(self.slave)

    term = Terminal()
    term.wait_for('2 chats')
    text = term.read()
    assert text.find('Newest Codex chat') < text.find('Older Claude chat')
    term.send(b'\t')
    term.wait_for('1 of 2')
    assert 'Older Claude chat' not in term.read(), 'provider filter leaked a Claude chat'
    term.send(b'\t')
    term.wait_for('Older Claude chat')
    term.send(b'\x14')
    term.wait_for('TRANSCRIPT')
    term.wait_for('Claude transcript body')
    term.send(b'\x1b')
    term.read(.6) # readline waits to distinguish Escape from a longer sequence
    term.send(b'\x1b[200~pasted\r\nquery\x1b[201~')
    term.wait_for('pasted query')
    assert not record.exists(), 'paste unexpectedly resumed a session'
    term.send(b'\x15')
    term.wait_for('Older Claude chat')
    term.send(b'\r')
    term.wait_exit()
    term.close()
    resumed = json.loads(record.read_text())
    assert resumed == {'agent': 'claude', 'args': ['--resume', 'claude-session'], 'cwd': str(project)}, resumed
    record.unlink()

    term = Terminal()
    term.wait_for('Newest Codex chat')
    term.send(b'\r')
    term.wait_exit()
    term.close()
    resumed = json.loads(record.read_text())
    assert resumed == {'agent': 'codex', 'args': ['resume', cid], 'cwd': str(project)}, resumed

    term = Terminal()
    term.wait_for('2 chats')
    term.send(b'\x03')
    term.close()
    assert term.proc.returncode == 0
    print('PTY checks passed: search, filters, transcript, paste, literal resume argv/cwd, terminal restoration.')
