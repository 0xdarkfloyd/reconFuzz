"""Import external POC corpora into reconfuzz seeds."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from src.runner.corpus_manager import CorpusManager, Seed


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
        type=str,
        default=".js",
        help="File extension to import",
    )
    return parser


def extract_flags(source: str) -> list[str]:
    """Parse V8 // Flags: header if present."""
    if source.startswith("// Flags:"):
        return source.splitlines()[0].replace("// Flags:", "").strip().split()
    return []


def import_corpus(
    source_dir: Path,
    corpus: CorpusManager,
    extension: str,
) -> int:
    """Walk source_dir and import every matching file as a seed."""
    count = 0
    for path in sorted(source_dir.rglob(f"*{extension}")):
        try:
            source = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        seed_id = f"{source_dir.name}_{path.stem}"[:64]
        seed = Seed(
            id=seed_id,
            source=source,
            flags=extract_flags(source),
            crash_class="imported",
            stack_hash=f"imported-{path.as_posix()}",
        )
        if corpus.add_seed(seed):
            count += 1
    return count


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)

    if not args.source.exists():
        print(f"[import] source directory not found: {args.source}", file=sys.stderr)
        return 1

    corpus = CorpusManager(args.corpus, args.crashes)
    imported = import_corpus(args.source, corpus, args.extension)
    print(f"[import] imported {imported} seeds from {args.source}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
