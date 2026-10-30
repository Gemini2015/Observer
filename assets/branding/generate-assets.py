#!/usr/bin/env python3
"""从 SVG 主稿生成 Observer 各平台图标资源。

依赖：
  - Edge/Chrome（headless 渲染 SVG 为 1024 PNG）
  - Pillow（缩放、favicon.ico、预览图）
  - Wails CLI（ico/icns 由 build/Taskfile 的 generate:icons 生成）

用法（仓库根目录）：
  python assets/branding/generate-assets.py
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "assets" / "branding"
RENDER = BRAND / "_render"

CHROME_CANDIDATES = [
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
]


def render_svg(svg: Path, output: Path) -> None:
    browser = next((path for path in CHROME_CANDIDATES if path.exists()), None)
    if browser is None:
        raise SystemExit("未找到 Chrome/Edge，无法将 SVG 渲染为 PNG")
    url = "file:///" + svg.as_posix()
    subprocess.run(
        [
            str(browser),
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            "--default-background-color=00000000",
            "--window-size=1024,1024",
            f"--screenshot={output}",
            url,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main() -> None:
    RENDER.mkdir(parents=True, exist_ok=True)
    icon_png = RENDER / "icon.png"
    mark_png = RENDER / "observer-mark.png"
    tray_png = RENDER / "observer-tray.png"
    render_svg(BRAND / "observer-icon.svg", icon_png)
    render_svg(BRAND / "observer-mark.svg", mark_png)
    render_svg(BRAND / "observer-tray.svg", tray_png)

    icon = Image.open(icon_png).convert("RGBA")
    mark = Image.open(mark_png).convert("RGBA")
    tray = Image.open(tray_png).convert("RGBA")

    icon.save(ROOT / "agent/desktop/build/appicon.png")
    tray.resize((64, 64), Image.LANCZOS).save(ROOT / "agent/desktop/build/trayicon.png")

    web_public = ROOT / "web" / "public"
    web_public.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(BRAND / "observer-icon.svg", web_public / "favicon.svg")
    shutil.copyfile(BRAND / "observer-mark.svg", web_public / "logo.svg")
    icon.resize((32, 32), Image.LANCZOS).save(web_public / "favicon-32.png")
    icon.resize((180, 180), Image.LANCZOS).save(web_public / "apple-touch-icon.png")
    icon.save(
        web_public / "favicon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    front_public = ROOT / "agent" / "desktop" / "frontend" / "public"
    front_public.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(BRAND / "observer-mark.svg", front_public / "logo.svg")
    shutil.copyfile(BRAND / "observer-icon.svg", front_public / "icon.svg")

    docs_assets = ROOT / "docs" / "assets"
    docs_assets.mkdir(parents=True, exist_ok=True)
    icon.resize((512, 512), Image.LANCZOS).save(docs_assets / "icon.png")

    sheet = Image.new("RGBA", (1200, 760), (15, 23, 42, 255))
    dark = Image.new("RGBA", (600, 760), (11, 18, 32, 255))
    light = Image.new("RGBA", (600, 760), (248, 250, 252, 255))
    y = 30
    for size in (256, 128, 64, 32, 16):
        dark.alpha_composite(icon.resize((size, size), Image.LANCZOS), (30, y))
        light.alpha_composite(icon.resize((size, size), Image.LANCZOS), (30, y))
        y += size + 16
    dark.alpha_composite(mark.resize((220, 220), Image.LANCZOS), (260, 30))
    light.alpha_composite(mark.resize((220, 220), Image.LANCZOS), (260, 30))
    dark.alpha_composite(tray.resize((128, 128), Image.LANCZOS), (410, 30))
    light.alpha_composite(tray.resize((128, 128), Image.LANCZOS), (410, 30))
    sheet.alpha_composite(dark, (0, 0))
    sheet.alpha_composite(light, (600, 0))
    sheet.convert("RGB").save(BRAND / "icon-preview.png")

    shutil.rmtree(RENDER, ignore_errors=True)
    print("assets generated")


if __name__ == "__main__":
    main()
