from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
LOGO = HERE.parents[1] / "branding" / "overclip-mark-512.png"
ACCENT = (118, 185, 0)
BG_TOP = (24, 24, 24)
BG_BOTTOM = (10, 10, 10)
TEXT = (237, 237, 237)
MUTED = (150, 150, 150)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    names = ["segoeuib.ttf", "arialbd.ttf"] if bold else ["segoeui.ttf", "arial.ttf"]
    for name in names:
        for base in (Path("C:/Windows/Fonts"), Path("/usr/share/fonts/truetype/dejavu")):
            p = base / name
            if p.exists():
                return ImageFont.truetype(str(p), size)
    return ImageFont.load_default()


def gradient(w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        c = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM))
        for x in range(w):
            px[x, y] = c
    return img


def glow(img: Image.Image, center: tuple[int, int], radius: int, alpha: int) -> Image.Image:
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x, y = center
    d.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(*ACCENT, alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(radius // 2))
    return Image.alpha_composite(img.convert("RGBA"), layer)


def centered(d: ImageDraw.ImageDraw, w: int, y: int, text: str, f, fill) -> None:
    tw = d.textlength(text, font=f)
    d.text(((w - tw) / 2, y), text, font=f, fill=fill)


def sidebar() -> None:
    w, h = 164, 314
    img = glow(gradient(w, h), (20, 40), 90, 70)
    logo = Image.open(LOGO).convert("RGBA").resize((64, 64), Image.LANCZOS)
    img.alpha_composite(logo, ((w - 64) // 2, 52))
    d = ImageDraw.Draw(img)
    centered(d, w, 128, "Overclip", font(26, True), TEXT)
    d.rectangle(((w - 28) // 2, 166, (w + 28) // 2, 168), fill=ACCENT)
    centered(d, w, 180, "Your clips &", font(12), MUTED)
    centered(d, w, 196, "screenshots,", font(12), MUTED)
    centered(d, w, 212, "one shortcut away.", font(12), MUTED)
    centered(d, w, 284, "Free & open source", font(10), MUTED)
    d.rectangle((0, 0, 2, h), fill=ACCENT)
    img.convert("RGB").save(HERE / "sidebar.bmp")


def header() -> None:
    w, h = 150, 57
    img = glow(gradient(w, h), (0, 0), 50, 60)
    logo = Image.open(LOGO).convert("RGBA").resize((30, 30), Image.LANCZOS)
    img.alpha_composite(logo, (16, (h - 30) // 2))
    d = ImageDraw.Draw(img)
    d.text((54, 13), "Overclip", font=font(20, True), fill=TEXT)
    d.rectangle((55, 40, 79, 41), fill=ACCENT)
    img.convert("RGB").save(HERE / "header.bmp")


if __name__ == "__main__":
    sidebar()
    header()
    print("wrote", HERE / "sidebar.bmp", "and", HERE / "header.bmp")
