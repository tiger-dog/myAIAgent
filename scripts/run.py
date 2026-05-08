"""工作区构建入口：标准库 only，配合 uv sync / uv run 使用。"""

from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path


def _root() -> Path:
    return Path(__file__).resolve().parents[1]


def _sidebar() -> Path:
    return _root() / "vscode-deepseek-sidebar"


def _tui() -> Path:
    return _root() / "DeepSeek-TUI"


def _run(cmd: list[str], cwd: Path) -> None:
    if not cwd.is_dir():
        raise SystemExit(f"目录不存在: {cwd}")
    print(f"+ cd {cwd} && {' '.join(cmd)}", flush=True)
    try:
        subprocess.run(cmd, cwd=cwd, check=True, env=os.environ.copy())
    except FileNotFoundError as e:
        raise SystemExit(f"未找到命令 {cmd[0]!r}，请安装 Node.js / Rust 等并加入 PATH。") from e
    except subprocess.CalledProcessError as e:
        raise SystemExit(e.returncode) from e


def cmd_sidebar_install(_: argparse.Namespace) -> None:
    _run(["npm", "install"], _sidebar())


def cmd_sidebar_compile(_: argparse.Namespace) -> None:
    _run(["npm", "run", "compile"], _sidebar())


def cmd_sidebar_watch(_: argparse.Namespace) -> None:
    _run(["npm", "run", "watch"], _sidebar())


def cmd_sidebar_package(_: argparse.Namespace) -> None:
    _run(["npx", "--yes", "@vscode/vsce", "package"], _sidebar())


def cmd_tui_build_release(_: argparse.Namespace) -> None:
    _run(["cargo", "build", "--release"], _tui())


def cmd_setup(_: argparse.Namespace) -> None:
    cmd_sidebar_install(_)


def cmd_build(_: argparse.Namespace) -> None:
    cmd_sidebar_install(_)
    cmd_sidebar_compile(_)


def main() -> None:
    p = argparse.ArgumentParser(
        prog="run.py",
        description="MyAIAgent：侧栏扩展（npm）与可选 DeepSeek-TUI（cargo）构建",
    )
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("setup", help="npm install（vscode-deepseek-sidebar）").set_defaults(fn=cmd_setup)
    sub.add_parser("build", help="npm install + compile（推荐）").set_defaults(fn=cmd_build)
    sub.add_parser("sidebar-install", help="仅 npm install").set_defaults(fn=cmd_sidebar_install)
    sub.add_parser("sidebar-compile", help="仅 tsc 编译").set_defaults(fn=cmd_sidebar_compile)
    sub.add_parser("sidebar-watch", help="tsc --watch").set_defaults(fn=cmd_sidebar_watch)
    sub.add_parser("sidebar-package", help="vsce 打 VSIX").set_defaults(fn=cmd_sidebar_package)
    sub.add_parser("tui-build-release", help="cargo build --release").set_defaults(
        fn=cmd_tui_build_release
    )

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
