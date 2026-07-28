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

    # Regex patterns for V8-specific failure signatures.
    PATTERNS: ClassVar[list[tuple[CrashClass, re.Pattern[str]]]] = [
        (CrashClass.CHECK_FAILURE, re.compile(r"CHECK failure:\s*(.+?)(?:\n|\r)")),
        (CrashClass.DCHECK_FAILURE, re.compile(r"DCHECK failure:\s*(.+?)(?:\n|\r)")),
        (CrashClass.ASSERT, re.compile(r"ASSERT(?:ION)?\s+FAILED")),
        (CrashClass.FATAL_ERROR, re.compile(r"Fatal error(?:\s+in\s+(.+?))?(?:\n|\r)")),
        (CrashClass.UNREACHABLE, re.compile(r"Unreachable code")),
        (CrashClass.NULL_DEREF, re.compile(r"Null-dereference\s+(READ|WRITE)")),
        (CrashClass.UAF, re.compile(r"(?:heap-use-after-free|use-after-free)", re.IGNORECASE)),
        (CrashClass.BUFFER_OVERFLOW, re.compile(r"buffer-overflow", re.IGNORECASE)),
        (CrashClass.SANDBOX_VIOLATION, re.compile(r"V8 sandbox violation")),
        (CrashClass.SIGNAL, re.compile(r"Signal\s+\w+|SIG(?:SEGV|ILL|ABRT|FPE)")),
        (CrashClass.STACK_OVERFLOW, re.compile(r"Stack-overflow|stack overflow", re.IGNORECASE)),
    ]

    SANITIZER_PATTERN: ClassVar[re.Pattern[str]] = re.compile(
        r"ERROR:\s*(AddressSanitizer|MemorySanitizer|UndefinedBehaviorSanitizer)"
    )

    def detect(self, result: D8Result) -> Detection:
        combined = result.stdout + "\n" + result.stderr
        crash_class, title = self._classify(combined)

        is_crash = (
            result.returncode != 0
            or result.timed_out
            or crash_class not in (CrashClass.NONE, CrashClass.UNKNOWN)
        )

        stack_hash = self._stack_hash(combined)

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

        if "Trap" in output:
            return CrashClass.SIGNAL, "wasm trap"

        return CrashClass.UNKNOWN, "unknown"

    def _stack_hash(self, output: str) -> str:
        """Produce a stable hash from the first few stack frames."""
        lines = output.splitlines()
        frames: list[str] = []
        for line in lines:
            stripped = line.strip()
            if "#" in stripped and ("v8::" in stripped or "Builtins_" in stripped):
                # Drop addresses to keep the hash stable across runs.
                cleaned = re.sub(r"0x[0-9a-fA-F]+", "0xADDR", stripped)
                frames.append(cleaned)
            if len(frames) >= 5:
                break
        digest = hashlib.sha256("\n".join(frames).encode("utf-8", "replace")).hexdigest()
        return digest[:16]
