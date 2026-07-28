"""Tests for the Python runner components."""

from pathlib import Path

import pytest

from src.runner import CorpusManager, Scheduler, SchedulerConfig, Seed


@pytest.fixture
def tmp_corpus(tmp_path: Path) -> CorpusManager:
    return CorpusManager(
        corpus_dir=tmp_path / "corpus",
        crashes_dir=tmp_path / "crashes",
    )


def test_corpus_add_and_dedupe(tmp_corpus: CorpusManager) -> None:
    seed = Seed(
        id="test-1",
        source="var x = 1;",
        flags=[],
        crash_class="NONE",
        stack_hash="abc123",
    )
    assert tmp_corpus.add_seed(seed) is True
    assert tmp_corpus.add_seed(seed) is False

    seeds = list(tmp_corpus.iter_seeds())
    assert len(seeds) == 1
    assert seeds[0].source == "var x = 1;"


def test_scheduler_selects_from_seeds(tmp_corpus: CorpusManager) -> None:
    scheduler = Scheduler(SchedulerConfig(base_energy=1))
    for i in range(5):
        tmp_corpus.add_seed(
            Seed(
                id=f"seed-{i}",
                source=f"var x = {i};",
                flags=[],
                crash_class="NONE",
                stack_hash=f"hash-{i}",
            )
        )

    seeds = list(tmp_corpus.iter_seeds())
    selected = scheduler.select(seeds)
    assert selected.id.startswith("seed-")


def test_corpus_imports_external_directory(tmp_corpus: CorpusManager, tmp_path: Path) -> None:
    external = tmp_path / "external"
    issue_dir = external / "400000001"
    issue_dir.mkdir(parents=True)
    (issue_dir / "meta.json").write_text('{"title": "CHECK failure"}')
    (issue_dir / "testcase_123456789.js").write_text("// Flags: --allow-natives-syntax\nvar x = 1;")

    count = tmp_corpus.import_directory(external)
    assert count == 1

    seeds = list(tmp_corpus.iter_seeds())
    assert seeds[0].flags == ["--allow-natives-syntax"]
