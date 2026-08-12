"""Shared-memory global edge union for coverage-gain admission.

Mapped by the parent and every fuzz worker so gain admission -- admit a
testcase only when it hits at least one globally-unseen edge -- can run in
the worker itself. This avoids shipping the ~300KB per-testcase edge bitmap
back to the parent on every execution, which otherwise makes the parent's
serial result handling the throughput bottleneck.

The union is a monotonic bitwise OR of every admitted testcase's edge
bitmap. A lock shared by all attachments serializes each read-modify-write,
so workers updating different bits in one byte cannot lose either update.
"""

from __future__ import annotations

import fcntl
import os
import tempfile
import threading
import time
from multiprocessing import shared_memory
from pathlib import Path

from .d8_wrapper import FUZZILLI_SHM_SIZE, _open_shared_memory


class CoverageUnion:
    """Process-shared edge bitmap used as the gain-admission oracle."""

    _PAYLOAD_SIZE = FUZZILLI_SHM_SIZE - 4

    def __init__(self, shm: shared_memory.SharedMemory, persist_path: Path) -> None:
        self._shm = shm
        self._persist_path = persist_path
        self.name = shm.name
        self._last_save = 0.0
        self._thread_lock = threading.Lock()
        self._merge_lock_path = persist_path.with_name(f".{persist_path.name}.lock")

    @classmethod
    def create(cls, persist_path: Path) -> CoverageUnion:
        """Parent-side: create a fresh shared region and seed it from disk."""
        shm = _open_shared_memory(create=True, size=FUZZILLI_SHM_SIZE)
        union = cls(shm, persist_path)
        buf = shm.buf
        if buf is not None:
            buf[:] = b"\x00" * FUZZILLI_SHM_SIZE
        if persist_path.exists():
            try:
                saved = persist_path.read_bytes()
                if buf is not None:
                    # Persist the same payload-only format used by
                    # CorpusManager. The first four bytes in a V8 bitmap are
                    # a per-process edge-count header and are not part of the
                    # union's edge bits.
                    if len(saved) == FUZZILLI_SHM_SIZE:
                        saved = saved[4:]
                    buf[: min(len(saved), cls._PAYLOAD_SIZE)] = saved[: cls._PAYLOAD_SIZE]
            except OSError:
                pass
        return union

    @classmethod
    def attach(cls, name: str, persist_path: Path) -> CoverageUnion:
        """Worker-side: attach to an existing region created by the parent."""
        # Keep worker attachments out of the resource tracker. The parent owns
        # the segment and unlinks it after all workers have shut down.
        shm = _open_shared_memory(name=name, create=False)
        return cls(shm, persist_path)

    def check_and_merge(self, bitmap: bytes) -> bool:
        """Return True iff ``bitmap`` has a bit absent from the union; when
        so, merge it in without losing concurrent same-byte updates."""
        buf = self._shm.buf
        if buf is None:
            return True  # cannot check: be permissive
        n = len(bitmap)
        if n > len(buf):
            raise ValueError("coverage bitmap exceeds the configured union size")

        incoming = int.from_bytes(bitmap, "little")
        with self._thread_lock:
            lock_fd = os.open(self._merge_lock_path, os.O_CREAT | os.O_RDWR, 0o600)
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX)
                current = int.from_bytes(bytes(buf[:n]), "little")
                if incoming & ~current == 0:
                    return False
                buf[:n] = (current | incoming).to_bytes(n, "little")
                return True
            finally:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                os.close(lock_fd)

    def save(self, force: bool = False) -> None:
        """Persist the union so gain dedup survives restarts. Throttled."""
        if not force and time.monotonic() - self._last_save < 5.0:
            return
        self._last_save = time.monotonic()
        buf = self._shm.buf
        if buf is None:
            return
        temp_path: Path | None = None
        try:
            # A sibling temp file plus replace keeps readers from observing a
            # partially written union after a crash or interrupted write.
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=self._persist_path.parent,
                prefix=f".{self._persist_path.name}.",
                delete=False,
            ) as temp_file:
                temp_path = Path(temp_file.name)
                temp_file.write(bytes(buf[: self._PAYLOAD_SIZE]))
                temp_file.flush()
                os.fsync(temp_file.fileno())
            os.replace(temp_path, self._persist_path)
        except OSError:
            pass
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)

    def close(self, unlink: bool = False) -> None:
        try:
            self._shm.close()
            if unlink:
                self._shm.unlink()
                self._merge_lock_path.unlink(missing_ok=True)
        except FileNotFoundError:
            pass
