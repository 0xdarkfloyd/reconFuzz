"""Import external POC corpora into reconfuzz seeds."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from src.runner.corpus_manager import CorpusManager, Seed

_FLAG_PREFIX = "// Flags:"
_FLAG_SCAN_LIMIT = 32
_SEED_ID_LIMIT = 64
_SEED_HASH_LENGTH = 12
_UNSAFE_ID_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass
class ImportStats:
    """Outcome counters for a corpus import."""

    newly_added: int = 0
    already_present: int = 0
    quarantined: int = 0


def _positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _normalize_extension(value: str) -> str:
    extension = value.strip()
    if not extension:
        raise argparse.ArgumentTypeError("extension must not be empty")
    return extension if extension.startswith(".") else f".{extension}"


def _log(event: str, **fields: object) -> None:
    record = {"event": event, **fields}
    sys.stderr.write(f"[import] {json.dumps(record, ensure_ascii=True, sort_keys=True)}\n")


def _seed_id(source_dir: Path, relative_path: Path) -> str:
    digest = hashlib.sha256(relative_path.as_posix().encode("utf-8")).hexdigest()
    suffix = digest[:_SEED_HASH_LENGTH]
    raw_prefix = f"{source_dir.name}_{relative_path.stem}"
    safe_prefix = _UNSAFE_ID_CHARS.sub("_", raw_prefix).strip("._-") or "seed"
    prefix_limit = _SEED_ID_LIMIT - len(suffix) - 1
    safe_prefix = safe_prefix[:prefix_limit].rstrip("._-") or "seed"
    return f"{safe_prefix}_{suffix}"


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Import big_sleep / lokihardt_jshitter corpora into reconfuzz seeds"
    )
    parser.add_argument(
        "source",
        type=Path,
        help="Root directory of the corpus (e.g., big_sleep/ or lokihardt_jshitter/)",
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        default=Path("seeds/corpus"),
        help="Destination corpus directory",
    )
    parser.add_argument(
        "--crashes",
        type=Path,
        default=Path("seeds/crashes"),
        help="Destination crashes directory",
    )
    parser.add_argument(
        "--extension",
        type=_normalize_extension,
        default=".js",
        help="File extension to import",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report imports without writing seeds",
    )
    parser.add_argument(
        "--limit",
        type=_positive_int,
        default=None,
        help="Maximum number of matching files to import",
    )
    parser.add_argument(
        "--daemon",
        default=None,
        help="Generator daemon base URL used to lift seeds before import",
    )
    parser.add_argument(
        "--quarantine",
        type=Path,
        default=None,
        help="Directory for seeds rejected by the daemon lift endpoint",
    )
    return parser


def extract_flags(source: str) -> list[str]:
    """Parse an exact V8 ``// Flags:`` header from the leading 32-line block."""
    for line in source.split("\n", _FLAG_SCAN_LIMIT)[:_FLAG_SCAN_LIMIT]:
        if line.startswith(_FLAG_PREFIX):
            return line.removeprefix(_FLAG_PREFIX).strip().split()
    return []


def lift_via_daemon(source: str, daemon_url: str) -> dict[str, object] | None:
    """Validate and canonicalize source through the generator daemon."""
    request = urllib.request.Request(
        f"{daemon_url.rstrip('/')}/lift",
        data=source.encode("utf-8"),
        headers={"Content-Type": "text/plain"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            result = json.loads(response.read())
    except (
        urllib.error.URLError,
        OSError,
        UnicodeDecodeError,
        json.JSONDecodeError,
    ):
        return None
    return result if isinstance(result, dict) else None


def import_corpus(
    source_dir: Path,
    corpus: CorpusManager,
    extension: str,
    *,
    dry_run: bool = False,
    limit: int | None = None,
    stats: ImportStats | None = None,
    log: bool = False,
    daemon_url: str | None = None,
    quarantine_dir: Path | None = None,
) -> int:
    """Import matching files, returning the number added or that would be added."""
    extension = _normalize_extension(extension)
    result = stats if stats is not None else ImportStats()
    result.newly_added = 0
    result.already_present = 0
    result.quarantined = 0
    processed = 0
    daemon_warning_logged = False
    if daemon_url is not None and quarantine_dir is None:
        corpus_dir = Path(corpus.corpus_dir)
        quarantine_dir = corpus_dir.with_name(f"{corpus_dir.name}_quarantine")
    dry_run_keys = (
        {(seed.crash_class, seed.stack_hash) for seed in corpus.iter_seed_metadata()}
        if dry_run
        else set()
    )

    for path in sorted(source_dir.rglob(f"*{extension}")):
        if limit is not None and processed >= limit:
            break
        try:
            source = path.read_text(encoding="utf-8", errors="replace")
            processed += 1
            relative_path = path.relative_to(source_dir)
            seed_id = _seed_id(source_dir, relative_path)
            seed_source = source
            seed_flags = extract_flags(source)

            if daemon_url is not None:
                lifted = lift_via_daemon(source, daemon_url)
                if lifted is None:
                    if not daemon_warning_logged:
                        _log(
                            "warning",
                            daemon=daemon_url,
                            reason="daemon unreachable; importing seeds verbatim",
                        )
                        daemon_warning_logged = True
                elif lifted.get("ok") is True:
                    normalized = lifted.get("normalized")
                    if not isinstance(normalized, str):
                        raise ValueError("lift response normalized field is not a string")
                    seed_source = normalized
                    lifted_flags = lifted.get("flags")
                    if isinstance(lifted_flags, list) and lifted_flags:
                        seed_flags = lifted_flags
                else:
                    errors = lifted.get("errors", [])
                    if not dry_run:
                        try:
                            assert quarantine_dir is not None
                            quarantine_dir.mkdir(parents=True, exist_ok=True)
                            (quarantine_dir / f"{seed_id}.js").write_text(
                                source, encoding="utf-8"
                            )
                            (quarantine_dir / f"{seed_id}.meta.json").write_text(
                                json.dumps(
                                    {"reason": "lift_failed", "errors": errors},
                                    ensure_ascii=True,
                                    indent=2,
                                )
                                + "\n",
                                encoding="utf-8",
                            )
                        except Exception as exc:  # noqa: BLE001 - isolate quarantine failures
                            _log(
                                "warning",
                                path=str(path),
                                quarantine=str(quarantine_dir),
                                reason=str(exc),
                            )
                            continue
                    result.quarantined += 1
                    if log:
                        _log(
                            "seed",
                            path=str(path),
                            seed_id=seed_id,
                            status="would-quarantine" if dry_run else "quarantined",
                        )
                    continue

            seed = Seed(
                id=seed_id,
                source=seed_source,
                flags=seed_flags,
                crash_class="imported",
                stack_hash=f"imported-{path.as_posix()}",
            )
            key = (seed.crash_class, seed.stack_hash)
            added = key not in dry_run_keys if dry_run else corpus.add_seed(seed)
        except OSError as exc:
            _log("warning", path=str(path), reason=str(exc))
            continue
        except Exception as exc:  # noqa: BLE001 - isolate one malformed seed
            _log("warning", path=str(path), reason=str(exc))
            continue

        if added:
            result.newly_added += 1
            if dry_run:
                dry_run_keys.add(key)
        else:
            result.already_present += 1

        if log:
            status = "would-add" if dry_run and added else "added" if added else "already-present"
            _log("seed", path=str(path), seed_id=seed_id, status=status)
    return result.newly_added


def _run_import(
    source_dir: Path,
    corpus: CorpusManager,
    extension: str,
    *,
    dry_run: bool,
    limit: int | None,
    daemon_url: str | None,
    quarantine_dir: Path | None,
) -> ImportStats:
    stats = ImportStats()
    import_corpus(
        source_dir,
        corpus,
        extension,
        dry_run=dry_run,
        limit=limit,
        stats=stats,
        log=True,
        daemon_url=daemon_url,
        quarantine_dir=quarantine_dir,
    )
    return stats


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)

    if not args.source.is_dir():
        _log("error", reason="source is not a directory", source=str(args.source))
        return 1

    quarantine_dir = args.quarantine
    if args.daemon is not None and quarantine_dir is None:
        quarantine_dir = args.corpus.with_name(f"{args.corpus.name}_quarantine")

    if args.dry_run:
        with tempfile.TemporaryDirectory(prefix="reconfuzz-import-") as temporary_dir:
            temporary_root = Path(temporary_dir)
            corpus_dir = args.corpus if args.corpus.is_dir() else temporary_root / "corpus"
            corpus = CorpusManager(corpus_dir, temporary_root / "crashes")
            stats = _run_import(
                args.source,
                corpus,
                args.extension,
                dry_run=True,
                limit=args.limit,
                daemon_url=args.daemon,
                quarantine_dir=quarantine_dir,
            )
    else:
        corpus = CorpusManager(args.corpus, args.crashes)
        stats = _run_import(
            args.source,
            corpus,
            args.extension,
            dry_run=False,
            limit=args.limit,
            daemon_url=args.daemon,
            quarantine_dir=quarantine_dir,
        )
    summary: dict[str, object] = {
        "already_present": stats.already_present,
        "dry_run": args.dry_run,
        "newly_added": stats.newly_added,
        "source": str(args.source),
    }
    if args.daemon is not None:
        summary["quarantined"] = stats.quarantined
    _log("summary", **summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
