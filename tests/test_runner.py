"""Tests for the Python runner components."""

import argparse
import json
import random
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from multiprocessing import shared_memory
from pathlib import Path
from typing import Self

import pytest

import src.runner.coverage_union as coverage_union_module
import src.runner.d8_wrapper as d8_wrapper_module
import src.runner.reprl as reprl_module
import scripts.import_corpus as import_corpus_module
from scripts import reproduce
from scripts.fuzz import adjust_op_mix, crossover_via_daemon, get_source_from_daemon, mutate_via_daemon
from scripts.import_corpus import build_arg_parser as build_import_arg_parser
from scripts.import_corpus import extract_flags, import_corpus, lift_via_daemon
from scripts.import_corpus import main as import_corpus_main
from scripts.reproduce import _positive_float, _validate_inputs
from scripts.reproduce import parse_args as parse_reproduce_args
from src.runner import CorpusManager, ReprlRunner, Scheduler, SchedulerConfig, Seed
from src.runner.d8_wrapper import FUZZILLI_SHM_SIZE, D8Result, D8Wrapper
from src.runner.detector import CrashClass, Detector
from src.runner.harness import Harness


def _run_reproduce(monkeypatch: pytest.MonkeyPatch, *arguments: str) -> int:
    monkeypatch.setattr(sys, "argv", ["reproduce.py", *arguments])
    return reproduce.main()


@pytest.mark.parametrize("text", ["0", "-1", "nan", "inf", "-inf", "abc"])
def test_reproduce_positive_float_rejects_invalid_values(text: str) -> None:
    with pytest.raises(argparse.ArgumentTypeError):
        _positive_float(text)


@pytest.mark.parametrize(("text", "expected"), [("5", 5.0), ("0.5", 0.5)])
def test_reproduce_positive_float_accepts_positive_values(text: str, expected: float) -> None:
    assert _positive_float(text) == expected


def test_reproduce_missing_testcase_returns_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    testcase = tmp_path / "missing.js"

    assert (
        _run_reproduce(
            monkeypatch,
            "--d8",
            str(tmp_path / "d8"),
            "--testcase",
            str(testcase),
        )
        == 2
    )
    error = capsys.readouterr().err
    assert "[reproduce]" in error
    assert str(testcase) in error


def test_reproduce_directory_testcase_returns_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    testcase = tmp_path / "directory.js"
    testcase.mkdir()

    assert (
        _run_reproduce(
            monkeypatch,
            "--d8",
            str(tmp_path / "d8"),
            "--testcase",
            str(testcase),
        )
        == 2
    )
    error = capsys.readouterr().err
    assert "[reproduce]" in error
    assert str(testcase) in error


def test_reproduce_missing_d8_returns_clean_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    testcase = tmp_path / "testcase.js"
    testcase.write_text("print(1);", encoding="utf-8")
    d8_path = tmp_path / "d8"

    assert (
        _run_reproduce(
            monkeypatch,
            "--d8",
            str(d8_path),
            "--testcase",
            str(testcase),
        )
        == 2
    )
    error = capsys.readouterr().err
    assert f"d8 is missing or not executable: {d8_path}" in error
    assert "[reproduce]" in error
    assert "Traceback" not in error


@pytest.mark.parametrize("is_crash", [False, True])
def test_reproduce_prints_detection_and_returns_status(
    is_crash: bool,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    testcase = tmp_path / "testcase.js"
    testcase.write_text("print(1);", encoding="utf-8")
    d8_path = tmp_path / "d8"
    d8_path.write_text("placeholder", encoding="utf-8")
    d8_path.chmod(0o755)
    crash_class = "CHECK_FAILURE" if is_crash else "NONE"

    class FakeHarness:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def evaluate(self, source: str, flags: list[str], seed_id: str) -> object:
            assert source == "print(1);"
            assert flags == ["--flag=value with spaces", "--other"]
            assert seed_id == "testcase"
            return type(
                "DetectionLike",
                (),
                {
                    "crash_class": type("CrashClassLike", (), {"name": crash_class})(),
                    "title": "test title",
                    "stack_hash": "stack123",
                    "is_crash": is_crash,
                    "raw": "raw output",
                },
            )()

    monkeypatch.setattr(reproduce, "D8Wrapper", lambda **_kwargs: object())
    monkeypatch.setattr(reproduce, "Harness", FakeHarness)
    result = _run_reproduce(
        monkeypatch,
        "--d8",
        str(d8_path),
        "--testcase",
        str(testcase),
        "--corpus",
        str(tmp_path / "corpus"),
        "--flags=--flag=\"value with spaces\" --other",
    )

    assert result == (1 if is_crash else 0)
    output = capsys.readouterr().out
    assert "Return class:" in output
    assert crash_class in output
    assert "Title:        test title" in output
    assert "Stack hash:   stack123" in output
    assert f"Is crash:     {is_crash}" in output
    assert "raw output" in output


def test_reproduce_iterations_count_findings_and_prints_first_result(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    testcase = tmp_path / "testcase.js"
    testcase.write_text("print(1);", encoding="utf-8")
    d8_path = tmp_path / "d8"
    d8_path.write_text("placeholder", encoding="utf-8")
    d8_path.chmod(0o755)
    calls: list[int] = []

    class FakeHarness:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def evaluate(self, source: str, flags: list[str], seed_id: str) -> object:
            calls.append(1)
            is_crash = len(calls) == 2
            return type(
                "DetectionLike",
                (),
                {
                    "crash_class": type(
                        "CrashClassLike", (), {"name": "CHECK_FAILURE" if is_crash else "NONE"}
                    )(),
                    "title": "first result" if len(calls) == 1 else "later result",
                    "stack_hash": f"stack-{len(calls)}",
                    "is_crash": is_crash,
                    "raw": f"raw-{len(calls)}",
                },
            )()

    monkeypatch.setattr(reproduce, "D8Wrapper", lambda **_kwargs: object())
    monkeypatch.setattr(reproduce, "Harness", FakeHarness)

    result = _run_reproduce(
        monkeypatch,
        "--d8",
        str(d8_path),
        "--testcase",
        str(testcase),
        "--iterations",
        "3",
    )

    assert result == 1
    assert len(calls) == 3
    captured = capsys.readouterr()
    assert "Title:        first result" in captured.out
    assert "raw-1" in captured.out
    assert captured.err.strip() == "[reproduce] iterations=3 findings=1"


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


def _bitmap_with_edges(edges: range) -> bytes:
    bitmap = bytearray(3)
    for edge in edges:
        bitmap[edge // 8] |= 1 << (edge % 8)
    return bytes(bitmap)


def test_gain_admission_sets_energy_from_new_edges(tmp_path: Path) -> None:
    corpus = CorpusManager(tmp_path / "corpus", tmp_path / "crashes", admission="gain")
    low_novelty = Seed(
        "low-novelty", "low();", [], "NONE", "low-stack", coverage_bitmap=_bitmap_with_edges(range(2))
    )
    high_novelty = Seed(
        "high-novelty",
        "high();",
        [],
        "NONE",
        "high-stack",
        coverage_bitmap=_bitmap_with_edges(range(2, 22)),
    )

    assert corpus.add_seed(low_novelty) is True
    assert corpus.add_seed(high_novelty) is True
    assert low_novelty.energy == corpus.GAIN_ENERGY_FLOOR + 2
    assert high_novelty.energy == corpus.GAIN_ENERGY_FLOOR + 20
    assert high_novelty.energy > low_novelty.energy > 1

    persisted = {seed.id: seed.energy for seed in corpus.iter_seed_metadata()}
    assert persisted == {"low-novelty": low_novelty.energy, "high-novelty": high_novelty.energy}


def test_gain_novelty_energy_biases_scheduler(tmp_path: Path) -> None:
    corpus = CorpusManager(tmp_path / "corpus", tmp_path / "crashes", admission="gain")
    low_novelty = Seed(
        "low-novelty", "low();", [], "NONE", "low-stack", coverage_bitmap=_bitmap_with_edges(range(2))
    )
    high_novelty = Seed(
        "high-novelty",
        "high();",
        [],
        "NONE",
        "high-stack",
        coverage_bitmap=_bitmap_with_edges(range(2, 22)),
    )
    assert corpus.add_seed(low_novelty) is True
    assert corpus.add_seed(high_novelty) is True

    seeds = list(corpus.iter_seed_metadata())
    scheduler = Scheduler(
        SchedulerConfig(
            base_energy=1,
            crash_bonus=0,
            coverage_bonus=0,
            depth_bonus=0,
            rng=random.Random(24680),
        )
    )
    selected_ids = [scheduler.select(seeds).id for _ in range(1000)]

    assert selected_ids.count("high-novelty") > selected_ids.count("low-novelty")


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


def test_scheduler_does_not_reward_normal_failures() -> None:
    scheduler = Scheduler(SchedulerConfig(base_energy=1, crash_bonus=100))
    assert scheduler.assign_energy(Seed("unknown", "", [], "UNKNOWN", "x")) == 1
    assert scheduler.assign_energy(Seed("timeout", "", [], "TIMEOUT", "x")) == 1
    assert scheduler.assign_energy(Seed("crash", "", [], "CHECK_FAILURE", "x")) == 101


@pytest.mark.parametrize(
    "field",
    ["base_energy", "crash_bonus", "coverage_bonus", "depth_bonus"],
)
@pytest.mark.parametrize("value", [-1, -5, 1.5, "10", True])
def test_scheduler_config_rejects_invalid_energy_values(field: str, value: object) -> None:
    with pytest.raises(ValueError):
        SchedulerConfig(**{field: value})  # type: ignore[arg-type]


def test_scheduler_config_accepts_defaults_and_valid_values() -> None:
    assert SchedulerConfig() == SchedulerConfig(
        base_energy=10,
        crash_bonus=100,
        coverage_bonus=50,
        depth_bonus=5,
    )
    assert SchedulerConfig(base_energy=0, crash_bonus=0, coverage_bonus=0, depth_bonus=0)


def test_scheduler_assign_energy_rewards_coverage() -> None:
    scheduler = Scheduler(SchedulerConfig(base_energy=10, coverage_bonus=7))
    with_coverage = Seed("covered", "", [], "NONE", "x", coverage_hash="hash")
    without_coverage = Seed("uncovered", "", [], "NONE", "x", coverage_hash=None)
    empty_coverage = Seed("empty", "", [], "NONE", "x", coverage_hash="")

    assert scheduler.assign_energy(with_coverage) == 17
    assert scheduler.assign_energy(without_coverage) == 10
    assert scheduler.assign_energy(empty_coverage) == 10


def test_scheduler_assign_energy_rejects_negative_depth() -> None:
    scheduler = Scheduler(SchedulerConfig(base_energy=10, depth_bonus=5))

    with pytest.raises(ValueError, match="depth must be non-negative"):
        scheduler.assign_energy(Seed("seed", "", [], "NONE", "x"), depth=-5)


def test_scheduler_select_rejects_empty_seed_list() -> None:
    with pytest.raises(ValueError, match="empty seed list"):
        Scheduler().select([])


def test_scheduler_select_uses_last_seed_fallback() -> None:
    seeds = [
        Seed("first", "", [], "NONE", "x"),
        Seed("last", "", [], "NONE", "y"),
    ]

    class EndpointRandom(random.Random):
        def uniform(self, _start: float, end: float) -> float:
            return end

    assert Scheduler(SchedulerConfig(rng=EndpointRandom())).select(seeds) is seeds[-1]


def test_scheduler_select_is_deterministic_with_injected_rng() -> None:
    seeds = [
        Seed("first", "", [], "NONE", "x"),
        Seed("second", "", [], "NONE", "y", coverage_hash="coverage"),
    ]

    first = Scheduler(SchedulerConfig(rng=random.Random(1234))).select(seeds)
    second = Scheduler(SchedulerConfig(rng=random.Random(1234))).select(seeds)

    assert first is second


def test_scheduler_select_preserves_input_membership() -> None:
    seeds = [
        Seed(f"seed-{index}", "", [], "NONE", f"stack-{index}")
        for index in range(7)
    ]
    scheduler = Scheduler(SchedulerConfig(rng=random.Random(24680)))

    for _ in range(500):
        selected = scheduler.select(seeds)
        assert any(selected is seed for seed in seeds)
        assert selected.id in {seed.id for seed in seeds}


def test_scheduler_select_honors_persisted_energy(tmp_path: Path) -> None:
    corpus = CorpusManager(tmp_path / "corpus", tmp_path / "crashes")
    assert corpus.add_seed(Seed("low", "low();", [], "NONE", "low-stack", energy=1))
    assert corpus.add_seed(Seed("high", "high();", [], "NONE", "high-stack", energy=50))
    seeds = list(CorpusManager(corpus.corpus_dir, corpus.crashes_dir).iter_seed_metadata())
    assert {seed.id: seed.energy for seed in seeds} == {"low": 1, "high": 50}

    scheduler = Scheduler(
        SchedulerConfig(
            base_energy=1,
            crash_bonus=0,
            coverage_bonus=0,
            depth_bonus=0,
            rng=random.Random(13579),
        )
    )
    selected_ids = [scheduler.select(seeds).id for _ in range(1000)]

    assert selected_ids.count("high") > 5 * selected_ids.count("low")


def test_reproduce_parse_args_splits_quoted_flags(tmp_path: Path) -> None:
    args = parse_reproduce_args(
        [
            "--d8",
            str(tmp_path / "d8"),
            "--testcase",
            str(tmp_path / "test.js"),
            "--flags",
            '--trace-file="path with spaces" --stress-gc',
        ]
    )

    assert args.flags == ["--trace-file=path with spaces", "--stress-gc"]


def test_reproduce_iterations_requires_positive_integer(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as error:
        parse_reproduce_args(
            [
                "--d8",
                str(tmp_path / "d8"),
                "--testcase",
                str(tmp_path / "test.js"),
                "--iterations",
                "0",
            ]
        )

    assert error.value.code == 2
    assert "must be a positive integer" in capsys.readouterr().err


def test_reproduce_crashes_default_is_sibling_of_corpus(tmp_path: Path) -> None:
    corpus = tmp_path / "nested" / "corpus"
    args = parse_reproduce_args(
        [
            "--d8",
            str(tmp_path / "d8"),
            "--testcase",
            str(tmp_path / "test.js"),
            "--corpus",
            str(corpus),
        ]
    )

    assert args.crashes == corpus.parent / "crashes"


def test_reproduce_validate_inputs_rejects_missing_d8(tmp_path: Path) -> None:
    testcase = tmp_path / "test.js"
    testcase.write_text("print(1);", encoding="utf-8")
    args = parse_reproduce_args(
        ["--d8", str(tmp_path / "missing-d8"), "--testcase", str(testcase)]
    )

    error = _validate_inputs(args)

    assert error is not None
    assert "d8" in error
    assert "not executable" in error


def test_reproduce_timeout_requires_positive_float(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as error:
        parse_reproduce_args(
            [
                "--d8",
                str(tmp_path / "d8"),
                "--testcase",
                str(tmp_path / "test.js"),
                "--timeout",
                "-1",
            ]
        )

    assert error.value.code == 2
    assert "must be a positive float" in capsys.readouterr().err


def test_corpus_imports_external_directory(tmp_corpus: CorpusManager, tmp_path: Path) -> None:
    external = tmp_path / "external"
    issue_dir = external / "400000001"
    issue_dir.mkdir(parents=True)
    (issue_dir / "meta.json").write_text('{"title": "CHECK failure"}')
    (issue_dir / "testcase_123456789.js").write_text("// Flags: --allow-natives-syntax\nvar x = 1;")
    (issue_dir / "testcase_987654321.js").write_text("var x = 2;")

    count = tmp_corpus.import_directory(external)
    assert count == 2

    seeds = list(tmp_corpus.iter_seeds())
    assert len(seeds) == 2
    assert ["--allow-natives-syntax"] in [seed.flags for seed in seeds]

    reloaded = CorpusManager(tmp_corpus.corpus_dir, tmp_corpus.crashes_dir)
    assert reloaded.import_directory(external) == 0


def test_import_corpus_extracts_flags_after_leading_lines() -> None:
    source = (
        "#!/usr/bin/env d8\n"
        "// Generated testcase\n"
        "// Flags: --allow-natives-syntax --trace-gc\n"
        "print(1);\n"
    )

    assert extract_flags(source) == ["--allow-natives-syntax", "--trace-gc"]
    assert extract_flags("print(1);") == []


def test_lift_via_daemon_returns_decoded_response(monkeypatch: pytest.MonkeyPatch) -> None:
    expected = {
        "ok": True,
        "errors": [],
        "normalized": "const value = 1;\n",
        "flags": ["--trace-gc"],
    }

    class LiftResponse:
        def __enter__(self) -> Self:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps(expected).encode("utf-8")

    def respond(request: urllib.request.Request) -> LiftResponse:
        assert request.full_url == "http://127.0.0.1:3000/lift"
        assert request.data == b"let value=1;"
        assert request.get_header("Content-type") == "text/plain"
        assert request.get_method() == "POST"
        return LiftResponse()

    monkeypatch.setattr(urllib.request, "urlopen", respond)

    assert lift_via_daemon("let value=1;", "http://127.0.0.1:3000/") == expected


def test_lift_via_daemon_returns_none_on_url_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def unreachable(_request: urllib.request.Request) -> object:
        raise urllib.error.URLError("unreachable")

    monkeypatch.setattr(urllib.request, "urlopen", unreachable)

    assert lift_via_daemon("let value=1;", "http://127.0.0.1:3000") is None


def test_import_corpus_uses_lifted_source_and_flags(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source_dir = tmp_path / "external"
    source_dir.mkdir()
    original = "// Flags: --input-flag\nlet value=1;"
    normalized = "// Flags: --daemon-flag\nlet value = 1;\n"
    (source_dir / "valid.js").write_text(original, encoding="utf-8")
    corpus_dir = tmp_path / "corpus"
    crashes_dir = tmp_path / "crashes"

    def lift(source: str, daemon_url: str) -> dict[str, object]:
        assert source == original
        assert daemon_url == "http://daemon.test"
        return {
            "ok": True,
            "errors": [],
            "normalized": normalized,
            "flags": ["--daemon-flag"],
        }

    monkeypatch.setattr(import_corpus_module, "lift_via_daemon", lift)

    assert (
        import_corpus_main(
            [
                str(source_dir),
                "--corpus",
                str(corpus_dir),
                "--crashes",
                str(crashes_dir),
                "--daemon",
                "http://daemon.test",
            ]
        )
        == 0
    )

    seeds = list(CorpusManager(corpus_dir, crashes_dir).iter_seeds())
    assert len(seeds) == 1
    assert seeds[0].source == normalized
    assert seeds[0].flags == ["--daemon-flag"]
    assert '"quarantined": 0' in capsys.readouterr().err


def test_import_corpus_quarantines_failed_lift(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source_dir = tmp_path / "external"
    source_dir.mkdir()
    original = "not valid source"
    (source_dir / "invalid.js").write_text(original, encoding="utf-8")
    corpus_dir = tmp_path / "corpus"
    crashes_dir = tmp_path / "crashes"
    quarantine_dir = tmp_path / "quarantine"
    monkeypatch.setattr(
        import_corpus_module,
        "lift_via_daemon",
        lambda _source, _url: {
            "ok": False,
            "errors": ["parse error"],
            "normalized": original,
            "flags": [],
        },
    )

    assert (
        import_corpus_main(
            [
                str(source_dir),
                "--corpus",
                str(corpus_dir),
                "--crashes",
                str(crashes_dir),
                "--daemon",
                "http://daemon.test",
                "--quarantine",
                str(quarantine_dir),
            ]
        )
        == 0
    )

    assert list(CorpusManager(corpus_dir, crashes_dir).iter_seed_metadata()) == []
    quarantined_sources = list(quarantine_dir.glob("*.js"))
    assert len(quarantined_sources) == 1
    assert quarantined_sources[0].read_text(encoding="utf-8") == original
    metadata_path = quarantined_sources[0].with_suffix(".meta.json")
    assert json.loads(metadata_path.read_text(encoding="utf-8")) == {
        "reason": "lift_failed",
        "errors": ["parse error"],
    }
    assert '"quarantined": 1' in capsys.readouterr().err


def test_import_corpus_falls_back_when_lift_is_unreachable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_dir = tmp_path / "external"
    source_dir.mkdir()
    original = "// Flags: --input-flag\nlet value=1;"
    (source_dir / "fallback.js").write_text(original, encoding="utf-8")
    corpus_dir = tmp_path / "corpus"
    crashes_dir = tmp_path / "crashes"
    monkeypatch.setattr(import_corpus_module, "lift_via_daemon", lambda _source, _url: None)

    assert (
        import_corpus_main(
            [
                str(source_dir),
                "--corpus",
                str(corpus_dir),
                "--crashes",
                str(crashes_dir),
                "--daemon",
                "http://daemon.test",
            ]
        )
        == 0
    )

    seeds = list(CorpusManager(corpus_dir, crashes_dir).iter_seeds())
    assert len(seeds) == 1
    assert seeds[0].source == original
    assert seeds[0].flags == ["--input-flag"]


def test_import_corpus_without_daemon_remains_verbatim(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_dir = tmp_path / "external"
    source_dir.mkdir()
    original = "// Flags: --input-flag\nlet value=1;"
    (source_dir / "verbatim.js").write_text(original, encoding="utf-8")
    corpus_dir = tmp_path / "corpus"
    crashes_dir = tmp_path / "crashes"

    def unexpected_lift(_source: str, _url: str) -> None:
        pytest.fail("lift_via_daemon was called without --daemon")

    monkeypatch.setattr(import_corpus_module, "lift_via_daemon", unexpected_lift)

    assert (
        import_corpus_main(
            [
                str(source_dir),
                "--corpus",
                str(corpus_dir),
                "--crashes",
                str(crashes_dir),
            ]
        )
        == 0
    )

    seeds = list(CorpusManager(corpus_dir, crashes_dir).iter_seeds())
    assert len(seeds) == 1
    assert seeds[0].source == original
    assert not corpus_dir.with_name("corpus_quarantine").exists()


def test_import_corpus_normalizes_extension_and_rejects_empty(
    tmp_corpus: CorpusManager, tmp_path: Path
) -> None:
    source_dir = tmp_path / "external"
    source_dir.mkdir()
    (source_dir / "one.js").write_text("print(1);", encoding="utf-8")

    parser = build_import_arg_parser()
    assert parser.parse_args([str(source_dir), "--extension", "js"]).extension == ".js"
    with pytest.raises(SystemExit) as error:
        parser.parse_args([str(source_dir), "--extension", ""])
    assert error.value.code == 2

    assert import_corpus(source_dir, tmp_corpus, "js") == 1


@pytest.mark.parametrize("failure", [OSError("write failed"), ValueError("bad seed")])
def test_import_corpus_isolates_per_seed_failures(
    failure: Exception,
    tmp_corpus: CorpusManager,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source_dir = tmp_path / "external"
    source_dir.mkdir()
    (source_dir / "bad.js").write_text("bad seed", encoding="utf-8")
    (source_dir / "good.js").write_text("good seed", encoding="utf-8")
    add_seed = tmp_corpus.add_seed

    def fail_bad_seed(seed: Seed) -> bool:
        if seed.source == "bad seed":
            raise failure
        return add_seed(seed)

    monkeypatch.setattr(tmp_corpus, "add_seed", fail_bad_seed)

    assert import_corpus(source_dir, tmp_corpus, ".js") == 1
    assert [seed.source for seed in tmp_corpus.iter_seeds()] == ["good seed"]
    warning = capsys.readouterr().err
    assert "warning" in warning
    assert str(source_dir / "bad.js") in warning


def test_import_corpus_seed_ids_are_safe_and_distinguish_same_stems(
    tmp_corpus: CorpusManager, tmp_path: Path
) -> None:
    source_dir = tmp_path / "source corpus!"
    for directory, value in (("left", 1), ("right", 2)):
        path = source_dir / directory / "same stem.js"
        path.parent.mkdir(parents=True)
        path.write_text(f"print({value});", encoding="utf-8")

    assert import_corpus(source_dir, tmp_corpus, ".js") == 2
    seed_ids = [seed.id for seed in tmp_corpus.iter_seed_metadata()]

    assert len(set(seed_ids)) == 2
    assert all(len(seed_id) <= 64 for seed_id in seed_ids)
    safe_characters = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
    assert all(set(seed_id) <= safe_characters for seed_id in seed_ids)

    second_corpus = CorpusManager(tmp_path / "second-corpus", tmp_path / "second-crashes")
    assert import_corpus(source_dir, second_corpus, ".js") == 2
    assert {seed.id for seed in second_corpus.iter_seed_metadata()} == set(seed_ids)


def test_import_corpus_dry_run_adds_nothing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    source_dir = tmp_path / "external"
    source_dir.mkdir()
    (source_dir / "one.js").write_text("print(1);", encoding="utf-8")
    corpus_dir = tmp_path / "corpus"

    result = import_corpus_main(
        [
            str(source_dir),
            "--corpus",
            str(corpus_dir),
            "--crashes",
            str(tmp_path / "crashes"),
            "--dry-run",
        ]
    )

    assert result == 0
    assert not corpus_dir.exists()
    assert not (tmp_path / "crashes").exists()
    captured = capsys.readouterr()
    assert captured.out == ""
    assert '"newly_added": 1' in captured.err
    assert '"dry_run": true' in captured.err


def test_import_corpus_limit_caps_imports(tmp_path: Path) -> None:
    source_dir = tmp_path / "external"
    source_dir.mkdir()
    for index in range(4):
        (source_dir / f"seed-{index}.js").write_text(f"print({index});", encoding="utf-8")
    corpus_dir = tmp_path / "corpus"
    crashes_dir = tmp_path / "crashes"

    assert (
        import_corpus_main(
            [
                str(source_dir),
                "--corpus",
                str(corpus_dir),
                "--crashes",
                str(crashes_dir),
                "--limit",
                "2",
            ]
        )
        == 0
    )

    corpus = CorpusManager(corpus_dir, crashes_dir)
    assert len(list(corpus.iter_seed_metadata())) == 2


def test_import_corpus_limit_requires_positive_integer(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    source_dir = tmp_path / "external"
    source_dir.mkdir()

    with pytest.raises(SystemExit):
        import_corpus_main([str(source_dir), "--limit", "0"])

    assert "must be a positive integer" in capsys.readouterr().err


def test_import_corpus_rejects_source_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    source_file = tmp_path / "external.js"
    source_file.write_text("print(1);", encoding="utf-8")

    assert import_corpus_main([str(source_file)]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert '"reason": "source is not a directory"' in captured.err


def test_import_corpus_repeat_reports_already_present(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    source_dir = tmp_path / "external"
    source_dir.mkdir()
    (source_dir / "one.js").write_text("print(1);", encoding="utf-8")
    corpus_dir = tmp_path / "corpus"
    crashes_dir = tmp_path / "crashes"
    argv = [
        str(source_dir),
        "--corpus",
        str(corpus_dir),
        "--crashes",
        str(crashes_dir),
    ]

    assert import_corpus_main(argv) == 0
    capsys.readouterr()
    assert import_corpus_main(argv) == 0

    captured = capsys.readouterr()
    assert '"newly_added": 0' in captured.err
    assert '"already_present": 1' in captured.err
    corpus = CorpusManager(corpus_dir, crashes_dir)
    assert len(list(corpus.iter_seed_metadata())) == 1


def test_coverage_is_the_seed_admission_key(tmp_corpus: CorpusManager) -> None:
    first = Seed("same", "var x = 1;", [], "NONE", "stack-a", coverage_hash="edge-a")
    second = Seed("different", "var x = 2;", [], "NONE", "stack-b", coverage_hash="edge-a")
    novel = Seed("novel", "var x = 3;", [], "NONE", "stack-c", coverage_hash="edge-b")

    assert tmp_corpus.add_seed(first) is True
    assert tmp_corpus.add_seed(second) is False
    assert tmp_corpus.add_seed(novel) is True
    assert {seed.coverage_hash for seed in tmp_corpus.iter_seed_metadata()} == {"edge-a", "edge-b"}


def test_collision_ids_are_persisted_without_overwrite(tmp_corpus: CorpusManager) -> None:
    for stack in ("stack-a", "stack-b"):
        assert tmp_corpus.add_crash(Seed("replay_parent", "throw 1;", [], "FATAL_ERROR", stack))

    names = sorted(path.name for path in tmp_corpus.crashes_dir.iterdir())
    assert names == ["replay_parent", "replay_parent_1"]
    assert (tmp_corpus.crashes_dir / "replay_parent_1" / "meta.json").read_text().find(
        '"id": "replay_parent_1"'
    ) >= 0


def test_distinct_findings_with_same_id_do_not_overwrite(tmp_corpus: CorpusManager) -> None:
    first = Seed("finding", "first();", ["--first"], "FATAL_ERROR", "stack-first")
    second = Seed("finding", "second();", ["--second"], "FATAL_ERROR", "stack-second")

    assert tmp_corpus.add_crash(first)
    assert tmp_corpus.add_crash(second)

    finding_dirs = sorted(path for path in tmp_corpus.crashes_dir.iterdir() if path.is_dir())
    assert [path.name for path in finding_dirs] == ["finding", "finding_1"]
    stored = {
        json.loads((path / "meta.json").read_text(encoding="utf-8"))["stack_hash"]: (
            path.name,
            (path / "testcase.js").read_text(encoding="utf-8"),
            json.loads((path / "meta.json").read_text(encoding="utf-8")),
        )
        for path in finding_dirs
    }
    assert stored["stack-first"][1] == "first();"
    assert stored["stack-first"][2]["flags"] == ["--first"]
    assert stored["stack-second"][1] == "second();"
    assert stored["stack-second"][2]["flags"] == ["--second"]
    assert {record[2]["id"] for record in stored.values()} == {"finding", "finding_1"}


def test_stackless_crash_dedupe_persists_across_restart(tmp_path: Path) -> None:
    corpus_dir = tmp_path / "corpus"
    crashes_dir = tmp_path / "crashes"
    first = CorpusManager(corpus_dir, crashes_dir)
    assert first.add_crash(Seed("first", "throw 1;", [], "FATAL_ERROR", ""))

    reloaded = CorpusManager(corpus_dir, crashes_dir)
    assert not reloaded.add_crash(Seed("duplicate", "throw 2;", [], "FATAL_ERROR", ""))
    assert reloaded.add_crash(Seed("other-class", "while (1);", [], "TIMEOUT", ""))


def test_non_object_metadata_does_not_break_corpus_reload(tmp_path: Path) -> None:
    corpus_dir = tmp_path / "corpus"
    invalid_seed_dir = corpus_dir / "invalid"
    invalid_seed_dir.mkdir(parents=True)
    (invalid_seed_dir / "meta.json").write_text("[]", encoding="utf-8")
    (invalid_seed_dir / "testcase.js").write_text("invalid", encoding="utf-8")

    corpus = CorpusManager(corpus_dir, tmp_path / "crashes")
    assert corpus.add_seed(Seed("valid", "var x = 1;", [], "NONE", "stack"))
    assert [seed.id for seed in corpus.iter_seeds()] == ["valid"]
    assert [seed.id for seed in corpus.iter_seed_metadata()] == ["valid"]


@pytest.mark.parametrize(
    ("returncode", "text", "expected"),
    [
        (0, "Fatal error in testcase\n", False),
        (1, "Fatal error in testcase\n", False),
        (-6, "Fatal error in testcase\n", True),
        (0, "ERROR: AddressSanitizer: heap-use-after-free\n", False),
        (1, "ERROR: AddressSanitizer: heap-use-after-free\n", True),
    ],
)
def test_detector_requires_abnormal_native_exit(
    returncode: int, text: str, expected: bool
) -> None:
    result = D8Result(returncode, "", text, False, 1.0)
    assert Detector().detect(result).is_crash is expected


def test_flag_implication_cycle_is_benign_not_crash() -> None:
    # A testcase's --jitless stacked on the baseline JIT flags aborts in
    # flags.cc with a "Cycle in flag implications" diagnostic. This is a
    # self-induced flag-config error, never an engine bug, so the SIGABRT
    # must not be counted as a finding.
    text = (
        "# Fatal error in ../../src/flags/flags.cc, line 1044\n"
        "# Cycle in flag implications:\n"
        "--maglev-future -> --maglev\n"
        "--jitless -> --no-maglev\n"
    )
    result = D8Result(-6, "", text, False, 1.0)
    detection = Detector().detect(result)
    assert detection.is_crash is False
    assert detection.crash_class is CrashClass.NONE


def test_stackless_diagnostics_do_not_share_one_hash() -> None:
    detector = Detector()
    first = detector.detect(D8Result(-6, "DCHECK failure: first\n", "", False, 1.0))
    second = detector.detect(D8Result(-6, "DCHECK failure: second\n", "", False, 1.0))
    assert first.crash_class is CrashClass.DCHECK_FAILURE
    assert second.crash_class is CrashClass.DCHECK_FAILURE
    assert first.stack_hash != second.stack_hash


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "# Fatal error in objects.cc, line 10\n# Debug check failed: value.",
            CrashClass.DCHECK_FAILURE,
        ),
        (
            "# Fatal error in objects.cc, line 10\n# Check failed: value.",
            CrashClass.CHECK_FAILURE,
        ),
        (
            "# Fatal error in objects.cc, line 10\n# unreachable code",
            CrashClass.UNREACHABLE,
        ),
        ("Received signal 11 SEGV_MAPERR 000000000000", CrashClass.SIGNAL),
    ],
)
def test_detector_recognizes_current_v8_diagnostics(
    text: str, expected: CrashClass
) -> None:
    detection = Detector().detect(D8Result(-6, "", text, False, 1.0))
    assert detection.is_crash is True
    assert detection.crash_class is expected


def test_detector_keeps_non_crash_class_consistent() -> None:
    printed = Detector().detect(D8Result(0, "Fatal error in testcase", "", False, 1.0))
    timeout = Detector().detect(
        D8Result(-9, "", "# Fatal error in objects.cc, line 10", True, 1.0)
    )

    assert printed.is_crash is False
    assert printed.crash_class is CrashClass.NONE
    assert timeout.is_crash is False
    assert timeout.crash_class is CrashClass.TIMEOUT


def test_detector_recognizes_sanitizer_warning_exit() -> None:
    result = D8Result(66, "", "WARNING: ThreadSanitizer: data race", False, 1.0)
    detection = Detector().detect(result)
    assert detection.is_crash is True
    assert detection.crash_class is CrashClass.SANITIZER


def test_detector_does_not_trust_sanitizer_text_on_stdout() -> None:
    result = D8Result(1, "ERROR: AddressSanitizer: heap-use-after-free", "", False, 1.0)
    detection = Detector().detect(result)
    assert detection.is_crash is False
    assert detection.crash_class is CrashClass.NONE


def test_flag_processing_error_is_benign_not_crash() -> None:
    text = (
        "Flag processing error: Contradictory flag implications from "
        "--jitless and --disallow-unsafe-flags for flag --script-context-cells.\n"
        "==== C stack trace ===============================\n"
    )
    detection = Detector().detect(D8Result(-5, "", text, False, 1.0))
    assert detection.is_crash is False
    assert detection.crash_class is CrashClass.NONE


def test_symbolized_stack_hash_uses_frames_not_diagnostic_text() -> None:
    detector = Detector()
    first = detector._stack_hash(
        "first diagnostic\n"
        "==== C stack trace ===============================\n"
        "/build/d8(v8::internal::Foo::Bar()+0x2d) [0x1234]\n"
    )
    second = detector._stack_hash(
        "second diagnostic\n"
        "==== C stack trace ===============================\n"
        "/other/d8(v8::internal::Foo::Bar()+0x91) [0xabcd]\n"
    )
    assert first == second


def test_symbolized_stack_hash_discriminates_different_top_frames() -> None:
    detector = Detector()
    first = detector._stack_hash(
        "==== C stack trace ===============================\n"
        "/build/d8(v8::internal::Parser::ParseProgram()+0x2d) [0x1234]\n"
    )
    second = detector._stack_hash(
        "==== C stack trace ===============================\n"
        "/build/d8(v8::internal::Compiler::Compile()+0x2d) [0x1234]\n"
    )

    assert first != second


def test_harness_propagates_coverage_to_seed(tmp_corpus: CorpusManager) -> None:
    class FakeD8:
        def run(self, source: str, extra_flags: list[str]) -> D8Result:
            return D8Result(0, "", "", False, 1.0, "edge-123")

    detection, seed = Harness(FakeD8(), Detector(), tmp_corpus).run_source("print(1);")
    assert detection.is_crash is False
    assert seed.coverage_hash == "edge-123"


def test_harness_evaluate_without_corpus_does_not_persist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeD8:
        def run(self, source: str, extra_flags: list[str]) -> D8Result:
            return D8Result(0, "", "", False, 1.0)

    calls: list[str] = []

    def record_seed(_seed: Seed) -> bool:
        calls.append("add_seed")
        return True

    def record_crash(_seed: Seed) -> bool:
        calls.append("add_crash")
        return True

    monkeypatch.setattr(CorpusManager, "add_seed", record_seed)
    monkeypatch.setattr(CorpusManager, "add_crash", record_crash)

    detection = Harness(FakeD8(), Detector()).evaluate("print(1);")

    assert detection.is_crash is False
    assert calls == []


def test_harness_evaluate_routes_crashes_to_crash_corpus(tmp_corpus: CorpusManager) -> None:
    class FakeD8:
        def run(self, source: str, extra_flags: list[str]) -> D8Result:
            return D8Result(-6, "", "Received signal 11 SEGV_MAPERR", False, 1.0)

    detection = Harness(FakeD8(), Detector(), tmp_corpus).evaluate("crash();")

    assert detection.is_crash is True
    assert list(tmp_corpus.crashes_dir.glob("*/meta.json"))
    assert list(tmp_corpus.corpus_dir.glob("*/meta.json")) == []


def test_harness_evaluate_routes_clean_results_to_seed_corpus(
    tmp_corpus: CorpusManager,
) -> None:
    class FakeD8:
        def run(self, source: str, extra_flags: list[str]) -> D8Result:
            return D8Result(0, "", "", False, 1.0)

    detection = Harness(FakeD8(), Detector(), tmp_corpus).evaluate("print(1);")

    assert detection.is_crash is False
    assert list(tmp_corpus.corpus_dir.glob("*/meta.json"))
    assert list(tmp_corpus.crashes_dir.glob("*/meta.json")) == []


def test_harness_run_source_copies_flags() -> None:
    received: list[list[str]] = []

    class FakeD8:
        def run(self, source: str, extra_flags: list[str]) -> D8Result:
            received.append(extra_flags)
            return D8Result(0, "", "", False, 1.0)

    flags = ["--trace-gc"]
    _, seed = Harness(FakeD8(), Detector()).run_source("print(1);", flags)
    flags.append("--extra")

    assert received[0] is not flags
    assert received == [["--trace-gc"]]
    assert seed.flags == ["--trace-gc"]


def test_harness_run_source_handles_timeout() -> None:
    class FakeD8:
        def run(self, source: str, extra_flags: list[str]) -> D8Result:
            raise subprocess.TimeoutExpired("d8", 1)

    detection, seed = Harness(FakeD8(), Detector()).run_source("print(1);")

    assert detection.is_crash is False
    assert detection.crash_class is CrashClass.TIMEOUT
    assert detection.stack_hash == "timeout"
    assert "TimeoutExpired" in detection.title
    assert detection.raw.startswith("TimeoutExpired(")
    assert seed.crash_class == CrashClass.TIMEOUT.name
    assert seed.stack_hash == "timeout"


def test_harness_run_source_handles_missing_d8() -> None:
    class FakeD8:
        def run(self, source: str, extra_flags: list[str]) -> D8Result:
            raise FileNotFoundError("d8 missing")

    detection, seed = Harness(FakeD8(), Detector()).run_source("print(1);")

    assert detection.is_crash is False
    assert detection.crash_class is CrashClass.UNKNOWN
    assert detection.stack_hash == "tool-error:FileNotFoundError"
    assert "FileNotFoundError: d8 missing" in detection.title
    assert detection.raw.startswith("FileNotFoundError(")
    assert seed.stack_hash == detection.stack_hash


def test_harness_run_source_splits_string_flags() -> None:
    received: list[list[str]] = []

    class FakeD8:
        def run(self, source: str, extra_flags: list[str]) -> D8Result:
            received.append(extra_flags)
            return D8Result(0, "", "", False, 1.0)

    _, seed = Harness(FakeD8(), Detector()).run_source(
        "print(1);", '--stack-trace --a "b c"'
    )

    assert received == [["--stack-trace", "--a", "b c"]]
    assert seed.flags == ["--stack-trace", "--a", "b c"]


def test_harness_run_source_rejects_non_string_source() -> None:
    class FakeD8:
        def run(self, source: str, extra_flags: list[str]) -> D8Result:
            pytest.fail("d8 should not run for a non-string source")

    with pytest.raises(TypeError, match="source must be a str"):
        Harness(FakeD8(), Detector()).run_source(b"print(1);")  # type: ignore[arg-type]


def test_harness_seed_ids_are_deterministic_and_explicit() -> None:
    class FakeD8:
        def run(self, source: str, extra_flags: list[str]) -> D8Result:
            return D8Result(0, "", "", False, 1.0)

    source = "print(1);"
    first = Harness._make_id(source)
    second = Harness._make_id(source)
    _, seed = Harness(FakeD8(), Detector()).run_source(source, seed_id="provided")

    assert first == second
    assert first.startswith("seed_")
    assert seed.id == "provided"


def test_lcov_coverage_hash_ignores_source_paths_and_changes_with_counts() -> None:
    wrapper = D8Wrapper(Path("/bin/true"))
    first = wrapper._extract_coverage(
        "SF:/tmp/source-a.js\nFNDA:1,f\nDA:1,1\nend_of_record\n"
    )
    same = wrapper._extract_coverage(
        "SF:/tmp/source-b.js\nFNDA:1,f\nDA:1,1\nend_of_record\n"
    )
    changed = wrapper._extract_coverage(
        "SF:/tmp/source-c.js\nFNDA:1,f\nDA:1,0\nend_of_record\n"
    )
    assert first == same
    assert first != changed


def test_wrapper_does_not_use_source_identity_as_coverage() -> None:
    wrapper = D8Wrapper(Path("/bin/true"), coverage_flags=["--trace-block-coverage"])
    result = wrapper.run("var x = 1;")
    assert result.returncode == 0
    assert result.coverage_hash is None


def test_shared_memory_open_falls_back_without_track(monkeypatch: pytest.MonkeyPatch) -> None:
    """Python 3.10-3.12 constructors do not accept the track keyword."""
    calls: list[dict[str, object]] = []

    class LegacySharedMemory:
        name = "legacy-shm"

        def __init__(self, **kwargs: object) -> None:
            calls.append(kwargs)
            if "track" in kwargs:
                raise TypeError("unexpected keyword argument 'track'")

    monkeypatch.setattr(shared_memory, "SharedMemory", LegacySharedMemory)

    shm = d8_wrapper_module._open_shared_memory(create=True, size=32)

    assert isinstance(shm, LegacySharedMemory)
    assert calls == [
        {"create": True, "size": 32, "track": False},
        {"create": True, "size": 32},
    ]


def test_coverage_backends_use_the_v8_bitmap_size(tmp_path: Path) -> None:
    assert reprl_module._REPRL_SHM_SIZE == FUZZILLI_SHM_SIZE

    union = coverage_union_module.CoverageUnion.create(tmp_path / "coverage-union.bin")
    try:
        assert union._shm.buf is not None
        assert len(union._shm.buf) == FUZZILLI_SHM_SIZE
        payload = bytearray(FUZZILLI_SHM_SIZE - 4)
        payload[-1] = 1
        assert union.check_and_merge(bytes(payload)) is True
        assert union.check_and_merge(bytes(payload)) is False
    finally:
        union.close(unlink=True)


def test_coverage_union_persists_payload_without_header_shift(tmp_path: Path) -> None:
    path = tmp_path / "coverage-union.bin"
    union = coverage_union_module.CoverageUnion.create(path)
    try:
        bitmap = bytearray(2)
        bitmap[0] = 1 << 3
        bitmap[1] = 1 << 7
        assert union.check_and_merge(bytes(bitmap)) is True
        union.save(force=True)
    finally:
        union.close(unlink=True)

    assert path.read_bytes()[:2] == bytes([1 << 3, 1 << 7])
    restored = coverage_union_module.CoverageUnion.create(path)
    try:
        assert restored.check_and_merge(bytes(bitmap)) is False
    finally:
        restored.close(unlink=True)


def test_coverage_union_is_monotonic_for_subset_merges(tmp_path: Path) -> None:
    union = coverage_union_module.CoverageUnion.create(tmp_path / "coverage-union.bin")
    try:
        initial = bytes([0b01010101, 0b10000001])
        subset = bytes([0b00010001, 0b00000001])
        assert union.check_and_merge(initial) is True
        after_initial = bytes(union._shm.buf[: len(initial)])

        assert union.check_and_merge(subset) is False
        after_subset = bytes(union._shm.buf[: len(initial)])

        assert after_initial == initial
        assert after_subset == after_initial
        assert all((before & after) == before for before, after in zip(initial, after_subset))
    finally:
        union.close(unlink=True)


def test_coverage_union_concurrent_same_byte_or_has_no_lost_update(tmp_path: Path) -> None:
    merge_reads = threading.Barrier(2)
    start = threading.Barrier(2)

    class CoordinatedBuffer:
        def __init__(self) -> None:
            self.data = bytearray(1)

        def __len__(self) -> int:
            return len(self.data)

        def __getitem__(self, index: int | slice) -> int | bytearray:
            value = self.data[index]
            if isinstance(index, int):
                try:
                    merge_reads.wait(timeout=0.5)
                except threading.BrokenBarrierError:
                    pass
            return value

        def __setitem__(self, index: int | slice, value: object) -> None:
            self.data[index] = value  # type: ignore[index,assignment]

    class SharedMemoryLike:
        name = "coordinated-union"

        def __init__(self, buf: CoordinatedBuffer) -> None:
            self.buf = buf

        def close(self) -> None:
            pass

        def unlink(self) -> None:
            pass

    shared_buffer = CoordinatedBuffer()
    path = tmp_path / "coverage-union.bin"
    unions = [
        coverage_union_module.CoverageUnion(SharedMemoryLike(shared_buffer), path),  # type: ignore[arg-type]
        coverage_union_module.CoverageUnion(SharedMemoryLike(shared_buffer), path),  # type: ignore[arg-type]
    ]

    def merge(union: coverage_union_module.CoverageUnion, bitmap: bytes) -> bool:
        start.wait()
        return union.check_and_merge(bitmap)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(merge, unions[0], bytes([0b00000001])),
            executor.submit(merge, unions[1], bytes([0b00000010])),
        ]
        assert [future.result() for future in futures] == [True, True]

    assert shared_buffer.data[0] == 0b00000011


def _bitmap(*edge_indices: int) -> bytes:
    """Build a minimal Fuzzilli-style edge bitmap with the given bits set."""
    size = max(edge_indices) // 8 + 1
    data = bytearray(size)
    for index in edge_indices:
        data[index // 8] |= 1 << (index % 8)
    return bytes(data)


def test_gain_admission_retains_only_new_edges(tmp_path: Path) -> None:
    corpus = CorpusManager(tmp_path / "corpus", tmp_path / "crashes", admission="gain")
    first = Seed("a", "var a;", [], "NONE", "s1", coverage_bitmap=_bitmap(1, 2))
    subset = Seed("b", "var b;", [], "NONE", "s2", coverage_bitmap=_bitmap(1))
    novel = Seed("c", "var c;", [], "NONE", "s3", coverage_bitmap=_bitmap(2, 9))

    assert corpus.add_seed(first) is True
    assert corpus.add_seed(subset) is False  # no globally new edge
    assert corpus.add_seed(novel) is True  # edge 9 is new
    # The union now covers 1, 2, 9: a re-run of the first program adds nothing.
    assert corpus.add_seed(Seed("d", "var d;", [], "NONE", "s4", coverage_bitmap=_bitmap(1, 2, 9))) is False
    assert {s.id for s in corpus.iter_seed_metadata()} == {"a", "c"}


def test_gain_admission_falls_back_to_hash_without_bitmap(tmp_path: Path) -> None:
    corpus = CorpusManager(tmp_path / "corpus", tmp_path / "crashes", admission="gain")
    assert corpus.add_seed(Seed("a", "var a;", [], "NONE", "s1", coverage_hash="h1")) is True
    assert corpus.add_seed(Seed("b", "var b;", [], "NONE", "s2", coverage_hash="h1")) is False


def test_gain_union_persists_across_restart(tmp_path: Path) -> None:
    corpus = CorpusManager(tmp_path / "corpus", tmp_path / "crashes", admission="gain")
    assert corpus.add_seed(Seed("a", "var a;", [], "NONE", "s1", coverage_bitmap=_bitmap(3, 4))) is True
    corpus._persist_coverage_union(force=True)

    reloaded = CorpusManager(tmp_path / "corpus", tmp_path / "crashes", admission="gain")
    assert reloaded.add_seed(Seed("b", "var b;", [], "NONE", "s2", coverage_bitmap=_bitmap(3, 4))) is False
    assert reloaded.add_seed(Seed("c", "var c;", [], "NONE", "s3", coverage_bitmap=_bitmap(4, 5))) is True


def test_failed_seed_write_does_not_commit_admission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    corpus = CorpusManager(tmp_path / "corpus", tmp_path / "crashes", admission="gain")
    seed = Seed("a", "var a;", [], "NONE", "s1", coverage_bitmap=_bitmap(3, 4))
    original_write_text = Path.write_text
    failed = False

    def fail_first_metadata_write(path: Path, data: str, **kwargs: object) -> int:
        nonlocal failed
        if path.name == "meta.json" and not failed:
            failed = True
            raise OSError("simulated write failure")
        return original_write_text(path, data, **kwargs)

    monkeypatch.setattr(Path, "write_text", fail_first_metadata_write)

    with pytest.raises(OSError, match="simulated write failure"):
        corpus.add_seed(seed)
    assert corpus.add_seed(seed) is True
    assert corpus.add_seed(seed) is False
    assert [saved.id for saved in corpus.iter_seeds()] == ["a_1"]


FUZZBUILD_D8 = Path("~/v8/v8/out/fuzzbuild/d8").expanduser()


def _make_reprl_stub(tmp_path: Path) -> tuple[Path, Path]:
    """Create a REPRL child that stalls once and always ignores SIGTERM."""
    stub_path = tmp_path / "reprl_stub.py"
    stalled_marker = tmp_path / "stalled-once"
    term_marker = tmp_path / "received-sigterm"
    stub_path.write_text(
        f"#!{sys.executable}\n"
        "import mmap\n"
        "import os\n"
        "import pathlib\n"
        "import signal\n"
        "import struct\n"
        "import time\n"
        f"stalled_marker = pathlib.Path({str(stalled_marker)!r})\n"
        f"term_marker = pathlib.Path({str(term_marker)!r})\n"
        "def ignore_sigterm(_signum, _frame):\n"
        "    term_marker.touch()\n"
        "signal.signal(signal.SIGTERM, ignore_sigterm)\n"
        "def read_exact(fd, size):\n"
        "    data = bytearray()\n"
        "    while len(data) < size:\n"
        "        chunk = os.read(fd, size - len(data))\n"
        "        if not chunk:\n"
        "            raise SystemExit(0)\n"
        "        data.extend(chunk)\n"
        "    return bytes(data)\n"
        "shm_name = os.environ['SHM_ID'].lstrip('/')\n"
        "shm_fd = os.open('/dev/shm/' + shm_name, os.O_RDWR)\n"
        "coverage = mmap.mmap(shm_fd, 0)\n"
        "coverage[:4] = struct.pack('<I', 8)\n"
        "os.write(101, b'HELO')\n"
        "if read_exact(100, 4) != b'HELO':\n"
        "    raise SystemExit(2)\n"
        "stall = not stalled_marker.exists()\n"
        "stalled_marker.touch(exist_ok=True)\n"
        "while True:\n"
        "    if read_exact(100, 4) != b'exec':\n"
        "        raise SystemExit(3)\n"
        "    size = struct.unpack('<Q', read_exact(100, 8))[0]\n"
        "    if stall:\n"
        "        while True:\n"
        "            time.sleep(60)\n"
        "    read_exact(102, size)\n"
        "    coverage[4:6] = b'\\x02\\x00'\n"
        "    os.write(103, b'stub completed\\n')\n"
        "    os.write(101, struct.pack('<i', 0))\n",
        encoding="utf-8",
    )
    stub_path.chmod(0o755)
    return stub_path, term_marker


@pytest.mark.skipif(not FUZZBUILD_D8.exists(), reason="fuzzbuild d8 not available")
def test_fuzzbuild_shmem_coverage_distinguishes_programs() -> None:
    assert D8Wrapper.probe_shmem_coverage(FUZZBUILD_D8)
    wrapper = D8Wrapper(FUZZBUILD_D8, shmem_coverage=True, default_flags=[])
    empty = wrapper.run("")
    busy = wrapper.run("var s = 0; for (var i = 0; i < 1000; i++) { s += i; }")

    assert empty.coverage_hash is not None and empty.coverage_bitmap is not None
    assert busy.coverage_hash is not None and busy.coverage_bitmap is not None
    assert empty.coverage_hash != busy.coverage_hash
    assert busy.edge_count is not None and empty.edge_count is not None
    assert busy.edge_count > empty.edge_count

    def bit_diff(a: bytes, b: bytes) -> int:
        return sum((x ^ y).bit_count() for x, y in zip(a, b))

    # Coverage is real execution feedback, not noise: identical programs
    # differ only by background-thread jitter, while different programs
    # diverge by orders of magnitude more edges.
    empty_again = wrapper.run("")
    assert empty_again.coverage_bitmap is not None
    jitter = bit_diff(empty.coverage_bitmap, empty_again.coverage_bitmap)
    signal = bit_diff(empty.coverage_bitmap, busy.coverage_bitmap)
    assert jitter < 500
    assert signal > 10 * max(jitter, 1)


@pytest.fixture
def reprl_runner() -> ReprlRunner:
    runner = ReprlRunner(
        FUZZBUILD_D8,
        default_flags=["--expose-gc", "--allow-natives-syntax"],
        timeout_seconds=15.0,
    )
    yield runner
    runner.close()


@pytest.mark.skipif(not FUZZBUILD_D8.exists(), reason="fuzzbuild d8 not available")
def test_reprl_executes_and_collects_coverage(reprl_runner: ReprlRunner) -> None:
    ok = reprl_runner.run("var s = 0; for (var i = 0; i < 500; i++) { s += i; } print(s);")
    assert ok.returncode == 0
    assert ok.coverage_hash is not None
    assert ok.coverage_bitmap is not None
    assert ok.edge_count is not None and ok.edge_count > 0

    # A JS exception is result=1, NOT a native crash.
    thrown = reprl_runner.run("throw new Error('boom');")
    assert thrown.returncode == 1
    assert thrown.coverage_hash is not None


@pytest.mark.skipif(not FUZZBUILD_D8.exists(), reason="fuzzbuild d8 not available")
def test_reprl_recovers_after_native_crash(reprl_runner: ReprlRunner) -> None:
    import os
    import struct

    # Force a native abort with an invalid REPRL action: d8 FATALs and dies.
    os.write(reprl_runner._ctrl_w, b"XXXX")
    os.write(reprl_runner._ctrl_w, struct.pack("<Q", 1))
    os.write(reprl_runner._data_w, b"1")

    crash = reprl_runner.run("1;")
    detection = Detector().detect(crash)
    assert detection.is_crash  # the dead child is reported as a crash

    # The runner respawned automatically and the next run is healthy.
    recovered = reprl_runner.run("print('recovered');")
    assert recovered.returncode == 0
    assert recovered.coverage_hash is not None


@pytest.mark.skipif(not FUZZBUILD_D8.exists(), reason="fuzzbuild d8 not available")
def test_reprl_respawn_does_not_leak_fds(reprl_runner: ReprlRunner) -> None:
    """Each crash forces a respawn; without FD cleanup the worker would hit
    the per-process FD limit (``ulimit -n``) after a few hundred findings."""
    import os
    import struct

    def open_fd_count() -> int:
        return len(os.listdir("/proc/self/fd"))

    reprl_runner.run("print('warm');")  # make sure the persistent child is up
    baseline = open_fd_count()

    for _ in range(3):
        # Same invalid-action crash as the recovery test, three times in a row.
        os.write(reprl_runner._ctrl_w, b"XXXX")
        os.write(reprl_runner._ctrl_w, struct.pack("<Q", 1))
        os.write(reprl_runner._data_w, b"1")
        crash = reprl_runner.run("1;")
        assert crash.returncode != 0  # crashed, then auto-respawned

    # Pre-fix this grew by ~4 FDs per crash (12 here); with the cleanup the
    # count stays at the baseline. A small tolerance absorbs incidental
    # allocation noise without masking the leak.
    assert open_fd_count() <= baseline + 1

    # And the runner is still functional after the storm of crashes.
    ok = reprl_runner.run("print('still alive');")
    assert ok.returncode == 0


def test_reprl_close_parent_fds_closes_open_descriptors() -> None:
    """_close_parent_fds releases every held control/data descriptor."""
    import os

    runner = object.__new__(ReprlRunner)  # bypass __init__/fork
    r1, w1 = os.pipe()
    r2, w2 = os.pipe()
    runner._ctrl_w = w1
    runner._ctrl_r = r2
    runner._data_w = w2
    runner._data_r = r1
    held = (w1, r2, w2, r1)

    runner._close_parent_fds()

    for fd in held:
        with pytest.raises(OSError):
            os.fstat(fd)
    # All four attributes reset to the closed sentinel.
    assert (runner._ctrl_w, runner._ctrl_r, runner._data_w, runner._data_r) == (-1, -1, -1, -1)


def test_reprl_close_parent_fds_is_idempotent() -> None:
    """Repeated calls are a no-op once the sentinels are in place."""
    runner = object.__new__(ReprlRunner)
    runner._ctrl_w = runner._ctrl_r = runner._data_w = runner._data_r = -1
    runner._close_parent_fds()  # must not raise
    runner._close_parent_fds()
    assert (runner._ctrl_w, runner._ctrl_r, runner._data_w, runner._data_r) == (-1, -1, -1, -1)


def test_reprl_spawn_closes_leaked_fds_before_reassigning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """_spawn must close previously-assigned FDs first (regression guard).

    The first spawn sees the -1 sentinels from __init__ and does nothing, but
    every respawn (after a crash/timeout) is invoked with the previous child's
    FDs still on the attributes. Without the cleanup call at the top of
    _spawn, those four descriptors were silently overwritten and leaked.
    """
    import os

    runner = object.__new__(ReprlRunner)
    runner._pid = 0
    # FDs as if a prior child had been spawned and crashed.
    r1, w1 = os.pipe()
    r2, w2 = os.pipe()
    runner._ctrl_w, runner._ctrl_r = w1, r2
    runner._data_w, runner._data_r = w2, r1
    old_fds = (w1, r2, w2, r1)

    # Short-circuit _spawn after the cleanup: pipe() returns sentinels and
    # fork() aborts before any real child is created, so the only observable
    # effect is whether the OLD descriptors were closed.
    monkeypatch.setattr(os, "pipe", lambda: (-1, -1))

    def _abort() -> int:
        raise OSError("stub")

    monkeypatch.setattr(os, "fork", _abort)

    with pytest.raises(OSError):
        runner._spawn()

    for fd in old_fds:
        with pytest.raises(OSError):
            os.fstat(fd)


def test_reprl_crash_result_preserves_terminating_signal() -> None:
    import os
    import signal
    import time

    runner = object.__new__(ReprlRunner)
    data_r, data_w = os.pipe()
    os.set_blocking(data_r, False)
    os.close(data_w)
    runner._data_r = data_r
    runner._spawn = lambda: None  # type: ignore[method-assign]

    pid = os.fork()
    if pid == 0:
        os.kill(os.getpid(), signal.SIGTERM)
        os._exit(1)
    runner._pid = pid

    try:
        result = runner._crash_result(time.perf_counter())
    finally:
        os.close(data_r)

    assert result.returncode == -signal.SIGTERM


def test_reprl_output_drain_respects_deadline_and_capture_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import os
    import threading
    import time

    import src.runner.reprl as reprl_module

    monkeypatch.setattr(reprl_module, "_MAX_CAPTURED_OUTPUT", 1024)
    runner = object.__new__(ReprlRunner)
    ctrl_r, ctrl_w = os.pipe()
    data_r, data_w = os.pipe()
    os.set_blocking(data_r, False)
    os.set_blocking(data_w, False)
    runner._ctrl_r = ctrl_r
    runner._data_r = data_r

    stop = threading.Event()

    def fill_output() -> None:
        chunk = b"x" * 4096
        while not stop.is_set():
            try:
                os.write(data_w, chunk)
            except BlockingIOError:
                time.sleep(0)
            except OSError:
                return

    writer = threading.Thread(target=fill_output)
    writer.start()
    started = time.perf_counter()
    try:
        status, output = runner._read_status_and_output(0.05)
    finally:
        stop.set()
        writer.join(timeout=1.0)
        os.close(ctrl_r)
        os.close(ctrl_w)
        os.close(data_r)
        os.close(data_w)

    assert status is None
    assert time.perf_counter() - started < 0.5
    assert output.endswith("[reprl] output truncated\n")
    assert len(output.encode()) <= 1024 + len(reprl_module._OUTPUT_TRUNCATED)


def test_daemon_helpers_handle_malformed_http_bodies(monkeypatch: pytest.MonkeyPatch) -> None:
    class MalformedResponse:
        def __enter__(self) -> Self:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def read(self) -> bytes:
            return b"\xff\xfe"

    monkeypatch.setattr(urllib.request, "urlopen", lambda *_args, **_kwargs: MalformedResponse())
    with pytest.raises(RuntimeError, match="Failed to fetch AST"):
        get_source_from_daemon("js-only", 1)
    assert mutate_via_daemon("var x = 1;") == "var x = 1;"
    assert crossover_via_daemon("var x = 1;", 1) == "var x = 1;"


def test_runner_all_matches_reexported_public_api() -> None:
    """Lock the ``src.runner`` public-API contract.

    ``__all__`` must list exactly the non-dunder, non-module names re-exported by
    the package. This prevents silent drift: a new ``from .x import Y`` without a
    matching ``__all__`` entry (or vice versa) fails this test rather than quietly
    changing the advertised API.
    """
    from types import ModuleType

    from src import runner

    declared = list(runner.__all__)
    assert len(declared) == len(set(declared)), "src.runner.__all__ has duplicate entries"

    exposed: set[str] = {
        name
        for name, value in vars(runner).items()
        if not name.startswith("_") and not isinstance(value, ModuleType)
    }
    declared_set = set(declared)
    assert exposed == declared_set, (
        "public-API drift between src.runner imports and __all__: "
        f"only-imported={sorted(exposed - declared_set)} "
        f"only-in-__all__={sorted(declared_set - exposed)}"
    )

    for name in declared:
        obj = getattr(runner, name)
        assert not isinstance(obj, ModuleType), (
            f"{name!r} is a submodule and must not be advertised in __all__"
        )


def test_reprl_run_kills_hung_child_within_timeout(tmp_path: Path) -> None:
    """End-to-end: a hung child is SIGKILLed within ~timeout_seconds.

    The REPRL per-run deadline must bound the whole request (writes + status
    read + drain). A child that stalls after ACKing the exec action cannot be
    allowed to run for the stub's 60s sleep; ``run()`` must report
    ``timed_out`` with ``returncode == -9`` and the stalled child must be
    killed + reaped (and a fresh child respawned). Uses ``_make_reprl_stub``
    so no real d8 is required.
    """
    import time

    stub_path, _term_marker = _make_reprl_stub(tmp_path)
    runner = ReprlRunner(stub_path, default_flags=[], timeout_seconds=1.5)
    try:
        started = time.perf_counter()
        result = runner.run("var x = 1;")
        elapsed = time.perf_counter() - started
    finally:
        runner.close()

    assert result.timed_out is True
    assert result.returncode == -9
    # Bounded by the deadline (not the 60s stall): allow slack for the
    # SIGKILL + respawn handshake, but well under a minute.
    assert elapsed < 1.5 + 3.0
    # close() reaped the respawned child; nothing leaked.
    assert runner._pid == 0


def test_reprl_close_escalates_sigterm_to_sigkill(tmp_path: Path) -> None:
    """close() is bounded + escalating on a SIGTERM-ignoring child.

    Sends SIGTERM first, then -- because the stub ignores SIGTERM -- escalates
    to SIGKILL within the short close grace window and reaps. close() must
    return promptly regardless of child state (regression guard for the
    unbounded ``waitpid`` that used to wedge shutdown).
    """
    import time

    stub_path, term_marker = _make_reprl_stub(tmp_path)
    runner = ReprlRunner(stub_path, default_flags=[], timeout_seconds=5.0)
    # After __init__ a live stub child exists (HELO done, waiting for exec).
    started = time.perf_counter()
    runner.close()
    elapsed = time.perf_counter() - started

    # SIGTERM was delivered (and observed by the stub's handler) before the
    # SIGKILL escalation -- proving the escalation order, not a lead-with-kill.
    assert term_marker.exists()
    # close() returned promptly despite the uncooperative child.
    assert elapsed < 2.0
    # Child fully reaped; no zombie left behind.
    assert runner._pid == 0


def test_run_source_records_run_flags_not_request_under_reprl():
    """Under REPRL (fixed startup flags) the Seed records the flags that ACTUALLY
    ran, not the testcase's requested flags; the one-shot wrapper records the
    testcase flags (which it honors). Fails on the old code, which always recorded
    the requested flags regardless of runner."""
    class _StubReprl:
        honors_per_testcase_flags = False
        default_flags = ["--expose-gc", "--allow-natives-syntax"]

        def run(self, source, extra_flags=None):
            raise OSError("stub: no real d8")

    class _StubOneShot:
        honors_per_testcase_flags = True
        default_flags = ["--allow-natives-syntax"]

        def run(self, source, extra_flags=None):
            raise OSError("stub: no real d8")

    requested = ["--some-other-flag"]
    # REPRL: per-testcase flags are ignored → record the fixed startup set.
    _, seed = Harness(_StubReprl(), Detector()).run_source("print(1);", flags=requested)
    assert seed.flags == ["--expose-gc", "--allow-natives-syntax"]
    # One-shot: per-testcase flags ARE honored → record them.
    _, seed = Harness(_StubOneShot(), Detector()).run_source("print(1);", flags=requested)
    assert seed.flags == requested


def test_adjust_op_mix_favors_generate() -> None:
    replay_prob, crossover_prob = adjust_op_mix(
        {"generate": 100, "mutate": 1, "crossover": 1},
        replay_prob=0.25,
        crossover_prob=0.5,
    )

    assert 0.1 <= replay_prob < 0.25
    assert abs(crossover_prob - 0.5) <= 0.2


def test_adjust_op_mix_favors_replay() -> None:
    replay_prob, crossover_prob = adjust_op_mix(
        {"generate": 1, "mutate": 50, "crossover": 50},
        replay_prob=0.25,
        crossover_prob=0.5,
    )

    assert 0.25 < replay_prob <= 0.7
    assert abs(crossover_prob - 0.5) <= 0.2


def test_adjust_op_mix_favors_crossover_within_replay() -> None:
    _, crossover_prob = adjust_op_mix(
        {"generate": 1, "mutate": 1, "crossover": 100},
        replay_prob=0.25,
        crossover_prob=0.5,
    )

    assert 0.5 < crossover_prob <= 0.9


def test_adjust_op_mix_zero_yield_preserves_inputs() -> None:
    inputs = (0.25, 0.5)

    assert adjust_op_mix(
        {"generate": 0, "mutate": 0, "crossover": 0},
        replay_prob=inputs[0],
        crossover_prob=inputs[1],
    ) == inputs


def test_adjust_op_mix_replay_converges() -> None:
    yields = {"generate": 2, "mutate": 3, "crossover": 1}
    target_replay_prob = (yields["mutate"] + yields["crossover"]) / sum(yields.values())
    replay_prob = 0.25
    crossover_prob = 0.5
    replay_history = [replay_prob]

    for _ in range(8):
        replay_prob, crossover_prob = adjust_op_mix(
            yields,
            replay_prob=replay_prob,
            crossover_prob=crossover_prob,
        )
        replay_history.append(replay_prob)

    assert replay_history[0] < replay_history[1] < replay_history[2] < replay_history[3]
    assert abs(replay_history[-1] - target_replay_prob) <= 0.03
