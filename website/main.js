const REPO = "Jxkss/overclip";

async function wireDownloads() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return;
    const release = await res.json();
    const asset = (release.assets || []).find((a) => /-setup\.exe$/i.test(a.name));
    if (!asset) return;
    const mb = (asset.size / 1024 / 1024).toFixed(1);
    for (const a of document.querySelectorAll("[data-download]")) a.href = asset.browser_download_url;
    for (const el of document.querySelectorAll("[data-download-label]")) {
      el.textContent = `Download ${release.tag_name} for Windows`;
    }
    const meta = document.querySelector("[data-download-meta]");
    if (meta) meta.textContent = `${release.tag_name} · ${mb} MB installer · No account · No ads · No tracking`;
  } catch {
  }
}

function wireSwatches() {
  const swatches = document.querySelectorAll("[data-accent]");
  for (const s of swatches) {
    s.addEventListener("click", () => {
      document.documentElement.style.setProperty("--accent", s.dataset.accent);
      for (const o of swatches) o.classList.toggle("is-on", o === s);
    });
  }
}


function perFrame(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...args);
    });
  };
}

function wireScroll() {
  const nav = document.querySelector(".nav");
  const bar = document.querySelector(".scroll-progress");
  const update = perFrame(() => {
    const y = scrollY;
    const max = document.documentElement.scrollHeight - innerHeight;
    nav?.classList.toggle("is-scrolled", y > 8);
    bar?.style.setProperty("--progress", max > 0 ? String(y / max) : "0");
  });
  addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update);
  update();
}

function wireReveals() {
  const selector = [
    ".section h2, .section-lead, .sub-h, .eyebrow-center",
    ".feature, .split-text, .split-shot",
    ".swatches, .custom-grid img, .rec-grid img, .recbar-demo, .recorder-shots figure",
    ".custom-list li, .rec-cards article",
    ".settings-map > div, .callout, .rec-how .steps, .split .steps, .rec-req, .keys-table tr, #faq details",
    ".final-cta h2, .final-cta .btn",
  ].join(", ");
  const targets = new Set();
  for (const el of document.querySelectorAll(selector)) {
    if (el.closest(".hero")) continue;
    el.dataset.reveal = "";
    targets.add(el);
  }
  for (const el of targets) {
    const same = [...(el.parentElement?.children ?? [])].filter((c) => targets.has(c));
    el.style.setProperty("--i", String(Math.min(same.indexOf(el), 8)));
  }
  const done = (el) => {
    el.classList.add("is-in");
    setTimeout(() => {
      delete el.dataset.reveal;
      el.classList.remove("is-in");
    }, 1700);
  };
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        done(e.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  targets.forEach((el) => io.observe(el));
}

function wireRecorderDemo() {
  const bar = document.querySelector(".recbar");
  const toast = document.querySelector(".recbar-toast");
  const cursor = bar?.querySelector(".fake-cursor");
  if (!bar || !toast || !cursor) return;
  const save = bar.querySelector('[data-act="save"]');
  const rec = bar.querySelector('[data-act="record"]');
  const recLabel = rec.querySelector("b");
  const games = ["Valorant", "Rocket League", "Fortnite", "Apex Legends", "Minecraft"];
  let game = 0;
  let visible = false;
  let running = false;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const at = (btn) => {
    const b = btn.getBoundingClientRect();
    const o = bar.getBoundingClientRect();
    return [b.left - o.left + b.width * 0.55, b.top - o.top + b.height * 0.55];
  };
  const place = (x, y) => {
    cursor.style.transform = `translate(${x}px, ${y}px)`;
  };
  const moveTo = async (btn) => {
    cursor.style.opacity = "1";
    place(...at(btn));
    await wait(750);
  };
  const click = async (btn) => {
    btn.classList.add("is-pressed");
    const ripple = document.createElement("span");
    ripple.className = "ripple";
    btn.append(ripple);
    setTimeout(() => ripple.remove(), 650);
    await wait(160);
    btn.classList.remove("is-pressed");
  };
  const say = (text, state) => {
    toast.querySelector("span").textContent = text;
    toast.classList.remove("is-done", "is-live");
    if (state) toast.classList.add(state);
    toast.classList.add("is-on");
  };
  const hideCursor = () => {
    cursor.style.opacity = "0";
  };

  async function loop() {
    running = true;
    cursor.style.transition = "none";
    place(bar.offsetWidth + 20, bar.offsetHeight + 30);
    cursor.getBoundingClientRect();
    cursor.style.transition = "";
    while (visible) {
      await moveTo(save);
      await click(save);
      say("Saving the last 1 min…");
      await wait(1300);
      say(`Replay saved to ${games[game++ % games.length]}`, "is-done");
      hideCursor();
      await wait(2200);
      toast.classList.remove("is-on");
      await wait(900);
      if (!visible) break;

      await moveTo(rec);
      await click(rec);
      rec.classList.add("is-live");
      recLabel.textContent = "Stop";
      say("Recording", "is-live");
      hideCursor();
      await wait(2600);
      await moveTo(rec);
      await click(rec);
      rec.classList.remove("is-live");
      recLabel.textContent = "Record";
      say("Recording saved", "is-done");
      hideCursor();
      await wait(2000);
      toast.classList.remove("is-on");
      await wait(1400);
    }
    running = false;
  }

  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !running) loop();
  }).observe(bar);
}

wireDownloads();
wireSwatches();
wireScroll();
wireReveals();
wireRecorderDemo();
