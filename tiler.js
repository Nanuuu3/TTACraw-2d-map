/*
 * In-browser tile builder.
 *
 * Slices a big map PNG into a Leaflet-compatible tile pyramid (tiles/{z}/{x}/{y}.png) plus a map.json,
 * and packages them into a zip you unzip next to index.html. Runs entirely client-side.
 *
 * The top level (z = maxZoom) is full resolution; each lower level halves it. To keep memory sane on a
 * 100-megapixel image, the top level is sliced straight from the decoded bitmap (no giant intermediate
 * canvas), and each lower level is downscaled from the previous one in a chain.
 */

const TILE = 256;

const els = {
  drop: document.getElementById("drop"),
  file: document.getElementById("file"),
  fileName: document.getElementById("fileName"),
  ppb: document.getElementById("ppb"),
  ox: document.getElementById("ox"),
  oz: document.getElementById("oz"),
  go: document.getElementById("go"),
  bar: document.getElementById("bar"),
  status: document.getElementById("status"),
};

let chosen = null;

els.drop.addEventListener("click", () => els.file.click());
els.file.addEventListener("change", () => pick(els.file.files[0]));
["dragenter", "dragover"].forEach((t) =>
  els.drop.addEventListener(t, (e) => {
    e.preventDefault();
    els.drop.classList.add("hover");
  })
);
["dragleave", "drop"].forEach((t) =>
  els.drop.addEventListener(t, (e) => {
    e.preventDefault();
    els.drop.classList.remove("hover");
  })
);
els.drop.addEventListener("drop", (e) => pick(e.dataTransfer.files[0]));
els.go.addEventListener("click", () => generate().catch(fail));

function pick(file) {
  if (!file) return;
  chosen = file;
  els.fileName.textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`;
  els.go.disabled = false;
  els.status.textContent = "";
}

function setProgress(frac) {
  els.bar.style.width = `${Math.round(frac * 100)}%`;
}

function fail(err) {
  console.error(err);
  els.status.textContent = "Error: " + (err && err.message ? err.message : err);
  els.go.disabled = false;
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

async function generate() {
  if (!chosen) return;
  els.go.disabled = true;
  setProgress(0);
  els.status.textContent = "Decoding image…";
  await nextFrame();

  const bitmap = await createImageBitmap(chosen);
  const width = bitmap.width;
  const height = bitmap.height;
  const maxZoom = Math.max(0, Math.ceil(Math.log2(Math.max(width, height) / TILE)));

  let totalTiles = 0;
  for (let z = 0; z <= maxZoom; z++) {
    const s = Math.pow(2, z - maxZoom);
    totalTiles +=
      Math.ceil((width * s) / TILE) * Math.ceil((height * s) / TILE);
  }

  const zip = new JSZip();
  const tileCanvas = document.createElement("canvas");
  tileCanvas.width = TILE;
  tileCanvas.height = TILE;
  const tctx = tileCanvas.getContext("2d");

  let source = bitmap; // current level's pixels
  let srcW = width;
  let srcH = height;
  let done = 0;

  for (let z = maxZoom; z >= 0; z--) {
    const levelW = Math.max(1, Math.round(width * Math.pow(2, z - maxZoom)));
    const levelH = Math.max(1, Math.round(height * Math.pow(2, z - maxZoom)));

    // For lower levels, downscale from the previous (larger) source.
    if (z < maxZoom) {
      const scaled = document.createElement("canvas");
      scaled.width = levelW;
      scaled.height = levelH;
      const sctx = scaled.getContext("2d");
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = "high";
      sctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, levelW, levelH);
      if (source.close) source.close(); // free the previous bitmap if any
      source = scaled;
      srcW = levelW;
      srcH = levelH;
    }

    const tilesX = Math.ceil(levelW / TILE);
    const tilesY = Math.ceil(levelH / TILE);
    for (let x = 0; x < tilesX; x++) {
      for (let y = 0; y < tilesY; y++) {
        const sx = x * TILE;
        const sy = y * TILE;
        const sw = Math.min(TILE, levelW - sx);
        const sh = Math.min(TILE, levelH - sy);

        tctx.clearRect(0, 0, TILE, TILE);
        tctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);

        const blob = await new Promise((r) => tileCanvas.toBlob(r, "image/png"));
        zip.file(`tiles/${z}/${x}/${y}.png`, blob);

        if (++done % 16 === 0) {
          setProgress((done / totalTiles) * 0.9);
          els.status.textContent = `Slicing tiles… ${done}/${totalTiles}`;
          await nextFrame();
        }
      }
    }
  }

  const ppb = parseFloat(els.ppb.value) || 1;
  const meta = {
    width,
    height,
    tileSize: TILE,
    minZoom: 0,
    maxZoom,
    blocksPerPixel: 1 / ppb,
    originBlockX: Math.round(parseFloat(els.ox.value) || 0),
    originBlockZ: Math.round(parseFloat(els.oz.value) || 0),
  };
  zip.file("map.json", JSON.stringify(meta, null, 2));

  els.status.textContent = "Packaging zip…";
  await nextFrame();
  const out = await zip.generateAsync(
    { type: "blob", compression: "STORE" }, // PNGs are already compressed
    (m) => setProgress(0.9 + (m.percent / 100) * 0.1)
  );

  download(out, "mapsite-tiles.zip");
  setProgress(1);
  els.status.textContent =
    `Done — ${done} tiles, ${width}×${height}px. Unzip "mapsite-tiles.zip" next to index.html, then open the map.`;
  els.go.disabled = false;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
