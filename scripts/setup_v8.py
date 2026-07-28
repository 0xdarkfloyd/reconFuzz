"""Download and build V8 from source for reconfuzz testing.

This script automates the official V8 build workflow:

  1. Fetch depot_tools if not present.
  2. Sync the V8 source tree.
  3. Install build dependencies.
  4. Generate a GN build configuration.
  5. Compile d8 with common fuzzing flags enabled.

Because a full V8 build can take 30-90 minutes depending on hardware, the
script is idempotent: re-running it will update an existing checkout rather
than starting from scratch.
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Download and build V8 for reconfuzz")
    parser.add_argument(
        "--workdir",
        type=Path,
        default=Path("third_party"),
        help="Directory where depot_tools and v8 will be checked out",
    )
    parser.add_argument(
        "--branch",
        type=str,
        default="main",
        help="V8 branch or tag to sync (default: main)",
    )
    parser.add_argument(
        "--build-type",
        choices=("debug", "release"),
        default="release",
        help="Build configuration",
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=None,
        help="Number of parallel ninja jobs (default: auto)",
    )
    parser.add_argument(
        "--no-clobber",
        action="store_true",
        help="Do not delete an existing workdir",
    )
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="Sync only; do not compile",
    )
    return parser


def run(cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    """Run a shell command and stream output."""
    print(f"[setup] {' '.join(cmd)}")
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


def depot_cmd(name: str, depot: Path) -> list[str]:
    """Return the platform-appropriate invocation for a depot_tools script."""
    depot = depot.resolve()
    if platform.system() == "Windows":
        # Prefer the .bat wrapper; fallback to python script.
        bat = depot / f"{name}.bat"
        if bat.exists():
            return [str(bat)]
        return ["python", str(depot / f"{name}.py")]
    return [str(depot / name)]


def ensure_depot_tools(workdir: Path) -> Path:
    """Clone or update depot_tools."""
    depot = workdir / "depot_tools"
    if depot.exists():
        print("[setup] updating depot_tools...")
        # depot_tools may be in a detached HEAD state; fetch then reset.
        run(["git", "fetch", "origin"], cwd=depot)
        run(["git", "reset", "--hard", "origin/main"], cwd=depot)
    else:
        print("[setup] cloning depot_tools...")
        depot.parent.mkdir(parents=True, exist_ok=True)
        run(
            [
                "git",
                "clone",
                "https://chromium.googlesource.com/chromium/tools/depot_tools.git",
                str(depot),
            ]
        )
    return depot


def sync_v8(workdir: Path, branch: str) -> Path:
    """Fetch V8 source using fetch + gclient sync."""
    v8_dir = workdir / "v8"
    depot = workdir / "depot_tools"

    env = os.environ.copy()
    env["PATH"] = f"{depot}{os.pathsep}{env.get('PATH', '')}"
    # On Windows, use the locally installed Visual Studio instead of trying to
    # download a Google-internal toolchain.
    if platform.system() == "Windows":
        env["DEPOT_TOOLS_WIN_TOOLCHAIN"] = "0"

    if not v8_dir.exists():
        print("[setup] fetching V8 source...")
        workdir.mkdir(parents=True, exist_ok=True)
        run(depot_cmd("fetch", depot) + ["v8"], cwd=workdir, env=env)

    print("[setup] syncing V8 checkout...")
    run(["git", "checkout", branch], cwd=v8_dir, env=env)
    run(depot_cmd("gclient", depot) + ["sync", "-D"], cwd=v8_dir, env=env)
    return v8_dir


def install_build_deps(v8_dir: Path) -> None:
    """Run the platform-specific dependency installer."""
    system = platform.system()
    if system == "Linux":
        deps_script = v8_dir / "build" / "install-build-deps.sh"
        if deps_script.exists():
            run(["bash", str(deps_script), "--no-prompt"], cwd=v8_dir)
    elif system == "Darwin":
        # macOS typically needs Xcode command line tools only.
        run(["xcode-select", "--install"])
    elif system == "Windows":
        print(
            "[setup] Windows V8 builds require Visual Studio 2022 with "
            "C++ build tools and the Windows 11 SDK. "
            "Please ensure they are installed before continuing."
        )


def generate_gn_args(v8_dir: Path, build_type: str) -> Path:
    """Create a GN args file for a fuzzing-friendly d8 build."""
    out_dir = v8_dir / "out" / build_type
    out_dir.mkdir(parents=True, exist_ok=True)

    is_debug = "true" if build_type == "debug" else "false"

    args = f"""is_debug = {is_debug}
is_component_build = false
symbol_level = 1
treat_warnings_as_errors = false
v8_enable_test_features = true
v8_enable_sandbox = true
v8_enable_maglev = true
v8_enable_turbofan = true
v8_enable_webassembly = true
use_goma = false
"""
    (out_dir / "args.gn").write_text(args, encoding="utf-8")
    return out_dir


def build_v8(v8_dir: Path, out_dir: Path, jobs: int | None) -> None:
    """Run gn gen and ninja to compile d8."""
    depot = v8_dir.parent / "depot_tools"
    env = os.environ.copy()
    env["PATH"] = f"{depot}{os.pathsep}{env.get('PATH', '')}"
    if platform.system() == "Windows":
        env["DEPOT_TOOLS_WIN_TOOLCHAIN"] = "0"

    print("[setup] generating build files...")
    run(depot_cmd("gn", depot) + ["gen", str(out_dir)], cwd=v8_dir, env=env)

    print("[setup] compiling V8 (this may take a while)...")
    cmd = depot_cmd("ninja", depot) + ["-C", str(out_dir), "d8"]
    if jobs is not None:
        cmd.extend(["-j", str(jobs)])
    run(cmd, cwd=v8_dir, env=env)


def print_summary(v8_dir: Path, out_dir: Path) -> None:
    """Print the path to the compiled d8 binary and a sample command."""
    system = platform.system()
    d8_name = "d8.exe" if system == "Windows" else "d8"
    d8_path = out_dir / d8_name

    print("\n[setup] V8 build summary")
    print(f"  d8 binary: {d8_path}")
    print(f"  exists: {d8_path.exists()}")
    print("\nSample reconfuzz command:")
    print(f"  python scripts/fuzz.py --d8 {d8_path} " f"--iterations 100 --mode hybrid")


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)

    if args.workdir.exists() and not args.no_clobber:
        print(f"[setup] removing existing workdir: {args.workdir}")
        shutil.rmtree(args.workdir, ignore_errors=True)

    try:
        ensure_depot_tools(args.workdir)
        v8_dir = sync_v8(args.workdir, args.branch)
        install_build_deps(v8_dir)
        out_dir = generate_gn_args(v8_dir, args.build_type)

        if not args.skip_build:
            build_v8(v8_dir, out_dir, args.jobs)

        print_summary(v8_dir, out_dir)
    except subprocess.CalledProcessError as exc:
        print(f"[setup] failed: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
