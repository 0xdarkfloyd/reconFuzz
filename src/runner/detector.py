"""Classify d8 output into crash / sanitizer / V8 signatures."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from enum import Enum, auto
from typing import ClassVar

from .d8_wrapper import D8Result


class CrashClass(Enum):
    NONE = auto()
    CHECK_FAILURE = auto()
    DCHECK_FAILURE = auto()
    ASSERT = auto()
    FATAL_ERROR = auto()
    UNREACHABLE = auto()
    NULL_DEREF = auto()
    UAF = auto()
    BUFFER_OVERFLOW = auto()
    SANDBOX_VIOLATION = auto()
    SIGNAL = auto()
    STACK_OVERFLOW = auto()
    SANITIZER = auto()
    TIMEOUT = auto()
    UNKNOWN = auto()


@dataclass(frozen=True)
class Detection:
    """Normalized detection result."""

    is_crash: bool
    crash_class: CrashClass
    title: str
    stack_hash: str
    raw: str


class Detector:
    """Parse d8 stdout/stderr and produce a stable Detection."""

    # Keep specific diagnostics before the generic fatal-error header. Current
    # V8 CHECK/DCHECK output includes both, on separate lines.
    PATTERNS: ClassVar[list[tuple[CrashClass, re.Pattern[str]]]] = [
        (
            CrashClass.DCHECK_FAILURE,
            re.compile(
                r"(?:Debug check failed:|DCHECK failure(?::|[ \t]+in))[ \t]*[^\r\n]*"
            ),
        ),
        (
            CrashClass.CHECK_FAILURE,
            re.compile(r"(?:Check failed:|CHECK failure(?::|[ \t]+in))[ \t]*[^\r\n]*"),
        ),
        # Torque/CSA asserts use a different format:
        #   abort: CSA_DCHECK failed: <expr> [<file>:<line>]
        (CrashClass.DCHECK_FAILURE, re.compile(r"CSA_DCHECK failed:[ \t]*[^\r\n]*")),
        (CrashClass.ASSERT, re.compile(r"ASSERT(?:ION)?\s+FAILED")),
        (CrashClass.NULL_DEREF, re.compile(r"Null-dereference\s+(READ|WRITE)")),
        (
            CrashClass.UAF,
            re.compile(r"(?:heap-use-after-free|use-after-free)", re.IGNORECASE),
        ),
        (CrashClass.BUFFER_OVERFLOW, re.compile(r"buffer-overflow", re.IGNORECASE)),
        (CrashClass.SANDBOX_VIOLATION, re.compile(r"V8 sandbox violation")),
        (
            CrashClass.STACK_OVERFLOW,
            re.compile(r"Stack-overflow|stack overflow", re.IGNORECASE),
        ),
        (
            CrashClass.UNREACHABLE,
            re.compile(r"(?:unreachable|unimplemented) code", re.IGNORECASE),
        ),
        (
            CrashClass.FATAL_ERROR,
            re.compile(r"Fatal (?:error|javascript OOM)[^\r\n]*", re.IGNORECASE),
        ),
        (
            CrashClass.SIGNAL,
            re.compile(
                r"Received[ \t]+signal[ \t]+\d+|Signal[ \t]+\w+|SIG(?:SEGV|ILL|ABRT|FPE)",
                re.IGNORECASE,
            ),
        ),
    ]

    SANITIZER_PATTERN: ClassVar[re.Pattern[str]] = re.compile(
        r"(?:ERROR|WARNING|SUMMARY):[ \t]*"
        r"(?:AddressSanitizer|HWAddressSanitizer|MemorySanitizer|"
        r"ThreadSanitizer|LeakSanitizer|UndefinedBehaviorSanitizer)\b"
    )

    # Signatures that look fatal but are induced by the testcase's own flags,
    # not by an engine bug: --liftoff-only deliberately turns unimplemented-
    # instruction bailouts into fatals, file-referencing flags (e.g.
    # --gc-fake-mmap=<nonexistent>) fatal at startup, and contradictory flag
    # sets abort in flags.cc with a "Cycle in flag implications" diagnostic.
    # None of these can be a genuine engine bug triggered by JS execution.
    BENIGN_PATTERNS: ClassVar[list[re.Pattern[str]]] = [
        # FatalNoSecurityImpact emits this marker specifically for failures
        # that V8's own fuzzers should ignore.
        re.compile(
            r"^#[ \t]+The following harmless error was encountered:",
            re.MULTILINE,
        ),
        re.compile(r"^#[ \t]+--\S+: treating bailout as fatal error", re.MULTILINE),
        re.compile(
            r"^#[ \t]+Failed to open .+: No such file or directory$",
            re.MULTILINE,
        ),
        re.compile(r"^#[ \t]+Cycle in flag implications:", re.MULTILINE),
        re.compile(
            r"^Flag processing error: Contradictory flag implications\b",
            re.MULTILINE,
        ),
    ]

    def detect(self, result: D8Result) -> Detection:
        combined = result.stdout + "\n" + result.stderr
        # Native diagnostics and sanitizers write to stderr. Prefer that
        # channel so a testcase printing a signature to stdout cannot override
        # a real diagnostic; REPRL also stores its combined output in stderr.
        crash_class, title = self._classify(result.stderr)
        if crash_class is CrashClass.UNKNOWN:
            crash_class, title = self._classify(result.stdout)
        sanitizer_report = self.SANITIZER_PATTERN.search(result.stderr) is not None

        # Downgrade flag-induced "crashes" — the engine behaved as asked,
        # so the negative returncode (SIGABRT) must not count either.
        benign = (
            not sanitizer_report
            and not result.timed_out
            and any(p.search(result.stderr) for p in self.BENIGN_PATTERNS)
        )

        # d8 exits 1 on any uncaught JS exception, which is normal behavior,
        # not a crash. A diagnostic-looking string printed by the testcase is
        # also not enough: known V8 signatures require a native abort status.
        # Timeouts are NOT crashes (user decision): on this slow-dchecks
        # build they are overwhelmingly just slow testcases, and counting
        # them drowns out every real signal. The TIMEOUT class is kept for
        # labeling only.
        # A negative returncode after a timeout is our own kill signal, so the
        # timeout classification takes precedence over partial diagnostics.
        # Native V8 diagnostics are emitted while aborting (negative signal
        # status on POSIX). Exit code 1 is normally just an uncaught JS
        # exception, even if the exception text resembles a V8 signature.
        native_abort = result.returncode < 0 and not result.timed_out
        sanitizer_abort = (
            sanitizer_report and result.returncode != 0 and not result.timed_out
        )
        is_crash = not benign and (native_abort or sanitizer_abort)

        # Keep the persisted class consistent with is_crash. Harness callers
        # also retain non-crashing executions as seeds, and the scheduler uses
        # this class directly when assigning energy.
        if result.timed_out:
            crash_class, title = CrashClass.TIMEOUT, "timeout (not a crash)"
        elif benign:
            crash_class, title = CrashClass.NONE, "benign (flag-induced)"
        elif not is_crash:
            crash_class, title = CrashClass.NONE, "no crash"

        stack_hash = self._stack_hash(combined, title)

        return Detection(
            is_crash=is_crash,
            crash_class=crash_class,
            title=title,
            stack_hash=stack_hash,
            raw=combined,
        )

    def _classify(self, output: str) -> tuple[CrashClass, str]:
        sanitizer_match = self.SANITIZER_PATTERN.search(output)
        if sanitizer_match:
            return CrashClass.SANITIZER, sanitizer_match.group(0)

        for crash_class, pattern in self.PATTERNS:
            match = pattern.search(output)
            if match:
                return crash_class, match.group(0)

        if "Abrt" in output or "Ill in v8" in output or "Unknown signal" in output:
            return CrashClass.SIGNAL, "signal-like abort"

        # NOTE: wasm "trap" output (e.g. RuntimeError: unreachable executed)
        # is normal wasm behavior, not a crash — do not classify it.

        return CrashClass.UNKNOWN, "unknown"

    def _stack_hash(self, output: str, fallback: str = "") -> str:
        """Produce a stable hash from frames or a stackless failure signature."""
        lines = output.splitlines()
        frames: list[str] = []
        in_c_stack = False
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("==== C stack trace"):
                in_c_stack = True
                continue
            if "#" in stripped and ("v8::" in stripped or "Builtins_" in stripped):
                # Drop addresses to keep the hash stable across runs.
                cleaned = re.sub(r"0x[0-9a-fA-F]+", "0xADDR", stripped)
                frames.append(cleaned)
            elif in_c_stack and stripped.startswith("/"):
                # V8 native stack dumps have no '#' prefix:
                #   /path/d8(v8::foo::Bar()+0x2d) [0x...]
                # Keep only the symbol so the hash is address-stable.
                match = re.search(r"^(.+?)\((.*)\)[ \t]+\[0x[0-9a-fA-F]+\]$", stripped)
                if match:
                    module, symbol = match.groups()
                    if re.fullmatch(r"\+0x[0-9a-fA-F]+", symbol):
                        # Unsymbolized module-relative offsets are still stable
                        # across executions of one build and carry more signal
                        # than the ASLR-dependent absolute address.
                        frames.append(module.rsplit("/", 1)[-1] + symbol)
                    else:
                        frames.append(re.sub(r"\+0x[0-9a-fA-F]+$", "", symbol))
            if len(frames) >= 5:
                break
        if not frames:
            # Stackless failures used to all hash the empty string. Keep a
            # stable, normalized diagnostic signature instead so unrelated
            # DCHECK/FATAL/SANITIZER reports are not collapsed together.
            normalized: list[str] = []
            signature_lines = (
                fallback.splitlines() if fallback and fallback != "unknown" else lines
            )
            for line in signature_lines:
                line = re.sub(r"0x[0-9a-fA-F]+", "0xADDR", line.strip())
                line = re.sub(r"/tmp/tmp[^ /]+", "/tmp/TEMP", line)
                if line:
                    normalized.append(line)
                if len(normalized) >= 8:
                    break
            signature = "\n".join(normalized) or "unknown"
        else:
            signature = "\n".join(frames)
        digest = hashlib.sha256(signature.encode("utf-8", "replace")).hexdigest()
        return digest[:16]
