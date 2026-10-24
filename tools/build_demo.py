"""Собирает фронтенд в один HTML-файл для демо без сервера (например, чтобы показать по ссылке).

    python tools/build_demo.py [путь к esbuild] → dist/rostov-arena-demo.html

Нужен esbuild (npx esbuild или бинарник). three.js, шаблон карты и фото встраиваются в файл.
"""
import base64
import io
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONT = ROOT / "frontend"
OUT = ROOT / "dist"


def photos() -> dict:
    try:
        from PIL import Image
    except ImportError:
        Image = None
    out = {}
    for p in sorted((FRONT / "assets" / "photos").glob("*.jpg")):
        data = p.read_bytes()
        if Image:
            im = Image.open(p)
            w = 1200 if p.stem == "genplan" else 900
            if im.width > w:
                im = im.resize((w, int(im.height * w / im.width)))
            buf = io.BytesIO()
            im.convert("RGB").save(buf, "JPEG", quality=62, optimize=True)
            data = buf.getvalue()
        out[p.stem] = "data:image/jpeg;base64," + base64.b64encode(data).decode()
    return out


def main():
    esbuild = sys.argv[1] if len(sys.argv) > 1 else "npx esbuild"
    OUT.mkdir(exist_ok=True)
    js = OUT / "bundle.js"
    cmd = f'{esbuild} {FRONT / "src" / "main.js"} --bundle --format=esm --minify --target=es2022 --charset=ascii ' \
          f'--alias:three={FRONT / "vendor" / "three" / "three.module.js"} ' \
          f'--alias:three/addons={FRONT / "vendor" / "three" / "addons"} --outfile={js}'
    subprocess.run(cmd, shell=True, check=True)
    css = (FRONT / "src" / "styles.css").read_text(encoding="utf-8")
    template = (FRONT / "data" / "manezh_dgtu_map.json").read_text(encoding="utf-8")
    boot = (
        "<script>window.__FORCE_DEMO__=true;"
        f"window.__TEMPLATE__={json.dumps(json.loads(template))};"
        f"window.__PHOTOS__={json.dumps(photos())};</script>"
    )
    code = js.read_text(encoding="utf-8").replace("</script", "<\\/script")
    html = (
        '<meta charset="utf-8">\n<title>Карта Ростов Арены</title>\n'
        f"<style>{css}</style>\n"
        '<div id="app" class="boot"><div class="boot-mark">РА</div></div>\n'
        f"{boot}\n<script type=\"module\">{code}</script>\n"
    )
    out = OUT / "rostov-arena-demo.html"
    out.write_text(html, encoding="utf-8")
    js.unlink()
    print(out, f"{out.stat().st_size // 1024} КБ")


if __name__ == "__main__":
    main()
