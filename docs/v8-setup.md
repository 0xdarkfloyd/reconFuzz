# V8 Setup Guide

This guide explains how to build the V8 developer shell (`d8`) from source so
that reconfuzz can execute generated testcases against a real engine.

## Automated setup

The easiest path is the provided helper script:

```bash
python scripts/setup_v8.py --workdir ../third_party --build-type release
```

The script performs these steps:

1. Clones or updates `depot_tools`.
2. Runs `fetch v8` to get the V8 source tree and dependencies.
3. Checks out the requested branch (`main` by default).
4. Runs `gclient sync -D` to pull all sub-repositories and run hooks.
5. Generates a GN build configuration in `v8/out/<build-type>`.
6. Runs `ninja -C v8/out/<build-type> d8` to compile.

If `--skip-build` is passed, only steps 1–4 are performed.

### Options

| Option | Description |
|---|---|
| `--workdir DIR` | Where `depot_tools` and `v8` are stored (default: `third_party`) |
| `--branch BRANCH` | V8 branch or tag (default: `main`) |
| `--build-type {debug,release}` | GN build type (default: `release`) |
| `--jobs N` | Parallel ninja jobs (default: auto) |
| `--skip-build` | Sync only, do not compile |
| `--no-clobber` | Keep an existing workdir instead of deleting it |

## Platform-specific notes

### Linux

Install the build dependencies:

```bash
sudo apt update
sudo apt install git python3 python3-pip lbzip2
# V8's install-build-deps.sh will request the rest:
python scripts/setup_v8.py --workdir ../third_party --skip-build
bash ../third_party/v8/build/install-build-deps.sh --no-prompt
python scripts/setup_v8.py --workdir ../third_party --build-type release
```

### macOS

Install Xcode command line tools:

```bash
xcode-select --install
python scripts/setup_v8.py --workdir ../third_party --build-type release
```

### Windows

1. Install **Visual Studio 2022** with the following workloads:
   - Desktop development with C++
   - Windows 11 SDK (10.0.22000.0 or later)
2. The helper script sets `DEPOT_TOOLS_WIN_TOOLCHAIN=0` so depot_tools uses
   your local Visual Studio instead of trying to download a Google-internal
   toolchain.
3. Enable long paths in Git (the V8 rust dependency has very long filenames):
   ```powershell
   git config --global core.longpaths true
   ```
4. Run the helper script from a PowerShell or Command Prompt (not WSL):
   ```powershell
   python scripts\setup_v8.py --workdir ..\third_party --build-type release
   ```

If you see errors about filenames being too long during `gclient sync`, run:

```powershell
git config --global core.longpaths true
cd ..\third_party\v8\third_party\rust
git reset --hard
git clean -fd
cd ..\..\..\reconfuzz
python scripts\setup_v8.py --workdir ..\third_party --build-type release
```

## GN args used by the helper

The generated `args.gn` enables the features most useful for fuzzing:

```gn
is_debug = false
is_component_build = false
symbol_level = 1
treat_warnings_as_errors = false
v8_enable_test_features = true
v8_enable_sandbox = true
v8_enable_maglev = true
v8_enable_turbofan = true
v8_enable_webassembly = true
use_goma = false
```

For a debug build (slower but better stack traces), use `--build-type debug`.

## Verifying the build

After compilation succeeds, run:

```bash
../third_party/v8/out/release/d8 --version
../third_party/v8/out/release/d8 --allow-natives-syntax -e "print(%Version());"
```

If d8 prints its version and a V8 version string, the build is usable.

## Using a prebuilt d8

If you obtained `d8` from another source (Chromium checkout, V8 release,
ClusterFuzz image), just pass its path to reconfuzz scripts:

```bash
python scripts/fuzz.py --d8 /path/to/d8 --iterations 100 --mode hybrid
```

## Troubleshooting

### `fetch` or `gclient` not found

Make sure `depot_tools` is in your `PATH`, or use the helper script which adds
it automatically.

### `No downloadable toolchain found` on Windows

Set `DEPOT_TOOLS_WIN_TOOLCHAIN=0` as an environment variable, or use the helper
script which does this for you.

### Build fails with Python errors

depot_tools uses its own managed Python. Do not mix system Python and
depot_tools Python; let the helper script run the depot_tools wrappers.

### Very long build times

A full release build of V8 can take 30–90 minutes on consumer hardware.  For
faster iteration:

- Use `--build-type release` (debug is slower to compile and run).
- Limit jobs with `--jobs N` if RAM is constrained.
- After the first build, incremental builds are much faster.

### Disk space

V8 source plus a release build needs roughly 15–20 GB.  Ensure your disk has
at least 30 GB free before starting.
