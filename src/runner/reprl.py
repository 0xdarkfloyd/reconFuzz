"""Fuzzilli REPRL execution client for the instrumented d8 build.

The ``v8_fuzzilli=true`` d8 binary speaks Fuzzilli's REPRL protocol: it stays
alive across thousands of testcases, reading each one over a pipe and writing
back an exit status plus edge coverage in a shared-memory bitmap. This avoids
re-initializing V8 for every testcase, which is the dominant cost of the
one-process-per-testcase :class:`D8Wrapper` path.

Protocol (no V8 source changes -- the binary already implements it):

* FD 100 (CRFD) -- child reads control (action + script size) from parent
* FD 101 (CWFD) -- child writes control (HELO + per-run status) to parent
* FD 102 (DRFD) -- child reads the script bytes from parent
* FD 103 (DWFD) -- child writes stdout/stderr to parent

Handshake: child writes ``HELO`` then reads ``HELO``. Each run the parent
writes the ``exec`` action (the C multichar ``'cexe'`` == ``0x63657865``, so
the on-wire little-endian bytes are ``b"exec"``), then an 8-byte little-endian
script length, then the script. The child replies with a 4-byte status
(``result << 8``) and ``fflush``es stdout/stderr first. Edge coverage lives in
the shared-memory bitmap (``uint32 num_edges`` header + 1 bit/edge); the child
resets edge *guards* per run but never clears the bitmap, so the parent clears
the used region before every run to obtain per-run coverage.
"""

from __future__ import annotations

import fcntl
import hashlib
import os
import select
import signal
import struct
import time
from collections.abc import Sequence
from pathlib import Path

from .d8_wrapper import FUZZILLI_SHM_SIZE, D8Result, _open_shared_memory

# REPRL control/data file descriptors as fixed by src/fuzzilli/fuzzilli.h.
_CRFD, _CWFD, _DRFD, _DWFD = 100, 101, 102, 103
# The C multichar constant 'cexe' == 0x63657865; little-endian bytes -> "exec".
_EXEC_ACTION = struct.pack("<I", 0x63657865)
_HELO = b"HELO"
# These sizes are part of V8/Fuzzilli's protocol rather than properties of a
# particular testcase. V8's src/fuzzilli/cov.cc maps a 2 MiB region, while the
# reference REPRL implementation limits each data channel to 16 MiB.
# REPRL and one-shot d8 runs must expose the same V8 coverage map size.
_REPRL_SHM_SIZE = FUZZILLI_SHM_SIZE
_MAX_CAPTURED_OUTPUT = 16 << 20
_OUTPUT_TRUNCATED = b"\n[reprl] output truncated\n"
_CLOSE_TERM_TIMEOUT = 0.2
_WAITPID_POLL_INTERVAL = 0.005


class ReprlRunner:
    """Run testcases against a single persistent d8 process via REPRL.

    Returns :class:`D8Result` objects so it is a drop-in for :class:`D8Wrapper`
    in :class:`Harness`. Per-testcase flags cannot be honored (the process is
    already running with a fixed flag set); ``extra_flags`` is accepted and
    ignored for interface compatibility.
    """

    # REPRL uses a single fixed startup flag set; per-testcase flags cannot be
    # applied. The Harness reads this to record the flags that actually ran.
    honors_per_testcase_flags = False

    def __init__(
        self,
        d8_path: Path | str,
        default_flags: Sequence[str] | None = None,
        timeout_seconds: float = 10.0,
    ) -> None:
        self.d8_path = Path(d8_path)
        self.default_flags = list(
            default_flags if default_flags is not None else ["--allow-natives-syntax"]
        )
        self.timeout_seconds = timeout_seconds
        if not self.d8_path.exists():
            raise FileNotFoundError(f"d8 not found at {self.d8_path}")

        # Persistent coverage bitmap: mapped once by the child at startup and
        # reused for every run. track=False keeps the resource tracker (which
        # misbehaves under fork) out of the lifecycle.
        self._shm = _open_shared_memory(create=True, size=_REPRL_SHM_SIZE)
        self._used = 0
        self._zero = b""
        self._pid = 0
        self._ctrl_w = self._ctrl_r = self._data_w = self._data_r = -1
        try:
            self._spawn()
        except BaseException:
            # __init__ did not complete, so do not rely on finalizer timing to
            # release the shared-memory object or a partially-spawned child.
            self.close()
            raise

    # ------------------------------------------------------------------ spawn

    def _close_parent_fds(self) -> None:
        """Close the four parent-side REPRL control/data FDs.

        Called before :meth:`_spawn` reassigns them (every crash and timeout
        respawns the persistent d8 child), on a handshake failure inside
        :meth:`_spawn`, and from :meth:`close`. Without this, each respawn
        silently overwrites the old FDs and leaks four descriptors; a
        robustness campaign that surfaces a few hundred native crashes would
        then exhaust the per-process FD limit (``ulimit -n``) and the worker
        would die with EMFILE. Idempotent: a no-op when the FDs are already
        closed (initialized to -1 before the first spawn).
        """
        for fd in (self._ctrl_w, self._ctrl_r, self._data_w, self._data_r):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
        self._ctrl_w = self._ctrl_r = self._data_w = self._data_r = -1

    def _spawn(self) -> None:
        """Fork+exec d8 with REPRL FDs wired up and complete the handshake."""
        # Close any parent-side FDs left over from a previous (crashed or
        # timed-out) child before creating a fresh set. The first spawn sees
        # the -1 sentinels set in __init__ and does nothing.
        self._close_parent_fds()

        pipe_fds: list[int] = []
        try:
            p2c_ctrl_r, p2c_ctrl_w = os.pipe()  # parent writes control -> child(100)
            pipe_fds.extend((p2c_ctrl_r, p2c_ctrl_w))
            c2p_ctrl_r, c2p_ctrl_w = os.pipe()  # child(101) -> parent reads status
            pipe_fds.extend((c2p_ctrl_r, c2p_ctrl_w))
            p2c_data_r, p2c_data_w = os.pipe()  # parent writes script -> child(102)
            pipe_fds.extend((p2c_data_r, p2c_data_w))
            c2p_data_r, c2p_data_w = os.pipe()  # child(103)+stdout+stderr -> parent
            pipe_fds.extend((c2p_data_r, c2p_data_w))
            pid = os.fork()
        except BaseException:
            for fd in set(pipe_fds):
                try:
                    os.close(fd)
                except OSError:
                    pass
            raise

        if pid == 0:  # child
            try:
                source_fds = (
                    p2c_ctrl_r,
                    c2p_ctrl_w,
                    p2c_data_r,
                    c2p_data_w,
                )
                # A long-running parent can have descriptors at 100-103 (or
                # even at 1/2 if its standard streams were closed). Duplicate
                # every pipe end above the REPRL range before wiring the fixed
                # descriptors, so an early dup2 cannot overwrite a later source.
                safe_fds = [
                    fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, _DWFD + 1)
                    for fd in source_fds
                ]
                for source_fd, target_fd in zip(
                    safe_fds,
                    (_CRFD, _CWFD, _DRFD, _DWFD),
                ):
                    os.dup2(source_fd, target_fd)
                os.dup2(safe_fds[3], 1)  # stdout -> data pipe
                os.dup2(safe_fds[3], 2)  # stderr -> data pipe
                keep_fds = {1, 2, _CRFD, _CWFD, _DRFD, _DWFD}
                for fd in (*pipe_fds, *safe_fds):
                    if fd in keep_fds:
                        continue
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                # "-e ''" is only a fallback if the REPRL handshake somehow
                # fails; with the handshake below d8 loops on REPRL instead.
                env = {**os.environ, "SHM_ID": "/" + self._shm.name}
                os.execvpe(
                    str(self.d8_path),
                    [str(self.d8_path), *self.default_flags, "-e", ""],
                    env,
                )
            except BaseException:  # noqa: BLE001 - child must not survive exec failure
                os._exit(127)

        # parent: close the child-side ends
        for fd in (p2c_ctrl_r, c2p_ctrl_w, p2c_data_r, c2p_data_w):
            try:
                os.close(fd)
            except OSError:
                pass
        # The parent-side data reader and both writers must be nonblocking.
        # select() supplies the blocking behavior with an explicit deadline;
        # leaving a writer blocking would let one large os.write() overrun it.
        os.set_blocking(c2p_data_r, False)
        os.set_blocking(p2c_ctrl_w, False)
        os.set_blocking(p2c_data_w, False)
        self._pid = pid
        self._ctrl_w = p2c_ctrl_w
        self._ctrl_r = c2p_ctrl_r
        self._data_w = p2c_data_w
        self._data_r = c2p_data_r

        # Drain startup diagnostics while waiting for HELO for the same reason
        # as per-run output: stdout/stderr share a pipe with the child process.
        helo, _ = self._read_status_and_output(self.timeout_seconds)
        if helo != _HELO:
            self._kill_and_reap()
            self._close_parent_fds()
            raise RuntimeError(f"REPRL handshake failed: expected HELO, got {helo!r}")
        self._write_all(self._ctrl_w, _HELO)

        (num_edges,) = struct.unpack("<I", bytes(self._shm.buf[:4]))  # type: ignore[index]
        # Coverage guard IDs are one-based, so ID num_edges uses byte
        # num_edges // 8 (byte zero also contains the unused ID-zero bit).
        used = num_edges // 8 + 1
        if num_edges == 0 or used > _REPRL_SHM_SIZE - 4:
            self._kill_and_reap()
            self._close_parent_fds()
            raise RuntimeError(f"REPRL child reported no edges (num_edges={num_edges})")
        self._used = used
        self._zero = b"\x00" * self._used

    # -------------------------------------------------------------------- run

    def run(
        self,
        source: str,
        extra_flags: Sequence[str] | None = None,
    ) -> D8Result:
        """Execute one testcase and return a classified D8Result."""
        del extra_flags  # REPRL flags are fixed at process startup.
        start = time.perf_counter()
        deadline = start + self.timeout_seconds
        src = source.encode("utf-8")

        if not self._alive():
            try:
                self._spawn()
            except (OSError, RuntimeError):
                return self._dead_result(start, "respawn failed")

        # Per-run coverage: clear the bitmap region the child will write.
        self._shm.buf[4 : 4 + self._used] = self._zero  # type: ignore[index]

        try:
            self._write_all(self._ctrl_w, _EXEC_ACTION, deadline)
            self._write_all(self._ctrl_w, struct.pack("<Q", len(src)), deadline)
            self._write_all(self._data_w, src, deadline)
        except TimeoutError:
            return self._timeout_result(start)
        except OSError:
            # Child died before/during the request -- treat as a crash.
            return self._crash_result(start)

        status, output = self._read_status_and_output(deadline=deadline)
        if status is None:
            return self._timeout_result(start, output)
        if len(status) < 4:
            # EOF: the child aborted during execution.
            return self._crash_result(start, output)

        result = struct.unpack("<i", status)[0] >> 8
        bitmap = bytes(self._shm.buf[4 : 4 + self._used])  # type: ignore[index]
        cov_hash = hashlib.sha256(bitmap).hexdigest()[:16]
        edge_count = sum(b.bit_count() for b in bitmap)
        return D8Result(
            returncode=result,
            stdout="",
            stderr=output,
            timed_out=False,
            duration_ms=(time.perf_counter() - start) * 1000.0,
            coverage_hash=cov_hash,
            edge_count=edge_count,
            coverage_bitmap=bitmap,
        )

    # -------------------------------------------------------------- lifecycle

    def close(self) -> None:
        """Terminate the child promptly and release all owned resources."""
        try:
            if self._pid:
                try:
                    os.kill(self._pid, signal.SIGTERM)
                except OSError:
                    pass
                deadline = time.perf_counter() + _CLOSE_TERM_TIMEOUT
                if not self._reap_until(deadline):
                    try:
                        os.kill(self._pid, signal.SIGKILL)
                    except OSError:
                        pass
                    # SIGKILL cannot be handled or ignored. A blocking reap is
                    # safe here and prevents a zombie from escaping close().
                    self._reap()
        finally:
            self._close_parent_fds()
            shm = getattr(self, "_shm", None)
            if shm is not None:
                try:
                    shm.close()
                except (BufferError, OSError):
                    pass
                try:
                    shm.unlink()
                except FileNotFoundError:
                    pass

    # -------------------------------------------------------------- internals

    def _alive(self) -> bool:
        if not self._pid:
            return False
        try:
            pid, _ = os.waitpid(self._pid, os.WNOHANG)
        except ChildProcessError:
            self._pid = 0
            return False
        if pid:
            self._pid = 0
            return False
        return True

    def _reap(self) -> int | None:
        if not self._pid:
            return None
        while True:
            try:
                _, status = os.waitpid(self._pid, 0)
            except InterruptedError:
                continue
            except ChildProcessError:
                returncode = None
            else:
                returncode = os.waitstatus_to_exitcode(status)
            break
        self._pid = 0
        return returncode

    def _reap_until(self, deadline: float) -> bool:
        """Reap the child by ``deadline`` without an unbounded wait."""
        while self._pid:
            try:
                pid, _ = os.waitpid(self._pid, os.WNOHANG)
            except InterruptedError:
                continue
            except ChildProcessError:
                self._pid = 0
                return True
            if pid:
                self._pid = 0
                return True
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                return False
            time.sleep(min(_WAITPID_POLL_INTERVAL, remaining))
        return True

    def _write_all(self, fd: int, data: bytes, deadline: float | None = None) -> None:
        """Write a complete protocol message before an optional deadline."""
        view = memoryview(data)
        while view:
            remaining = None if deadline is None else deadline - time.perf_counter()
            if remaining is not None and remaining <= 0:
                raise TimeoutError(f"write to REPRL fd {fd} timed out")
            try:
                _, ready, _ = select.select([], [fd], [], remaining)
            except InterruptedError:
                continue
            if not ready:
                raise TimeoutError(f"write to REPRL fd {fd} timed out")
            try:
                written = os.write(fd, view)
            except BlockingIOError:
                continue
            except InterruptedError:
                continue
            if written <= 0:
                raise OSError(f"short write to REPRL fd {fd}")
            view = view[written:]

    def _drain_output_bytes(self, deadline: float | None = None) -> bytes:
        """Read all currently buffered child output without blocking."""
        chunks: list[bytes] = []
        while True:
            if deadline is not None and time.perf_counter() >= deadline:
                break
            try:
                chunk = os.read(self._data_r, 65536)
            except BlockingIOError:
                break
            except InterruptedError:
                continue
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)

    def _drain_output(self) -> str:
        return self._drain_output_bytes().decode("utf-8", "replace")

    def _read_status_and_output(
        self,
        timeout: float | None = None,
        *,
        deadline: float | None = None,
    ) -> tuple[bytes | None, str]:
        """Read status while draining the shared stdout/stderr pipe.

        d8 flushes output before sending status, but the two messages use
        separate pipes. Draining only after status can deadlock when a testcase
        writes more than the data pipe capacity.
        """
        status = bytearray()
        output: list[bytes] = []
        captured = 0
        truncated = False
        data_open = True
        if deadline is None:
            if timeout is None:
                raise TypeError("timeout or deadline is required")
            deadline = time.perf_counter() + timeout

        def capture(chunk: bytes) -> None:
            nonlocal captured, truncated
            available = _MAX_CAPTURED_OUTPUT - captured
            if available > 0:
                kept = chunk[:available]
                output.append(kept)
                captured += len(kept)
            if len(chunk) > max(available, 0):
                truncated = True

        def decoded_output() -> str:
            raw = b"".join(output)
            if truncated:
                raw += _OUTPUT_TRUNCATED
            return raw.decode("utf-8", "replace")

        while len(status) < 4:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                return None, decoded_output()
            read_fds = [self._ctrl_r]
            if data_open:
                read_fds.append(self._data_r)
            try:
                ready, _, _ = select.select(read_fds, [], [], remaining)
            except InterruptedError:
                continue
            except OSError:
                return bytes(status), decoded_output()
            if not ready:
                return None, decoded_output()

            if self._ctrl_r in ready:
                try:
                    chunk = os.read(self._ctrl_r, 4 - len(status))
                except InterruptedError:
                    continue
                except OSError:
                    return bytes(status), decoded_output()
                if not chunk:
                    return bytes(status), decoded_output()
                status.extend(chunk)

            if data_open and self._data_r in ready:
                while True:
                    # A testcase can continuously refill the pipe faster than
                    # it is drained. Check the deadline inside this loop so
                    # such output cannot bypass the execution timeout.
                    if time.perf_counter() >= deadline:
                        return None, decoded_output()
                    try:
                        chunk = os.read(self._data_r, 65536)
                    except BlockingIOError:
                        break
                    except InterruptedError:
                        continue
                    except OSError:
                        data_open = False
                        break
                    if not chunk:
                        data_open = False
                        break
                    capture(chunk)

        capture(self._drain_output_bytes(deadline))
        if time.perf_counter() >= deadline:
            return None, decoded_output()
        return bytes(status), decoded_output()

    def _timeout_result(self, start: float, output: str = "") -> D8Result:
        # A hang wedges the persistent child: kill and respawn for next time.
        self._kill_and_reap()
        output += self._drain_output()
        duration_ms = (time.perf_counter() - start) * 1000.0
        try:
            self._spawn()
        except (OSError, RuntimeError):
            pass
        return D8Result(
            returncode=-9,
            stdout="",
            stderr=output,
            timed_out=True,
            duration_ms=duration_ms,
            coverage_hash=None,
            edge_count=None,
            coverage_bitmap=None,
        )

    def _crash_result(self, start: float, output: str = "") -> D8Result:
        # The child terminated before reporting status. Capture its diagnostic
        # output, preserve its actual exit status, and respawn so the worker
        # keeps going. Coverage from a failed run is reported as unavailable.
        returncode = self._reap()
        output += self._drain_output()
        duration_ms = (time.perf_counter() - start) * 1000.0
        try:
            self._spawn()
        except (OSError, RuntimeError):
            pass
        return D8Result(
            # Match subprocess.Popen semantics: negative values identify the
            # terminating signal, while positive values are process exit codes.
            returncode=returncode if returncode not in (None, 0) else -1,
            stdout="",
            stderr=output,
            timed_out=False,
            duration_ms=duration_ms,
            coverage_hash=None,
            edge_count=None,
            coverage_bitmap=None,
        )

    def _dead_result(self, start: float, reason: str) -> D8Result:
        return D8Result(
            returncode=-1,
            stdout="",
            stderr=f"[reprl] {reason}",
            timed_out=False,
            duration_ms=(time.perf_counter() - start) * 1000.0,
            coverage_hash=None,
            edge_count=None,
            coverage_bitmap=None,
        )

    def _kill_and_reap(self) -> None:
        if not self._pid:
            return
        try:
            os.kill(self._pid, signal.SIGKILL)
        except OSError:
            pass
        self._reap()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:  # noqa: BLE001, S110 - best-effort cleanup in finalizer
            pass
