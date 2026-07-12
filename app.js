/*
 * ChunkMapper 2D map viewer.
 *
 * Loads a tile pyramid (tiles/{z}/{x}/{y}.png) described by map.json and shows it with Leaflet's
 * Simple (pixel) CRS, so the whole 10000x10000 image streams in as tiles instead of one huge file.
 * Adds a live block-coordinate readout and toggleable chunk (16) and region (512) grid overlays.
 */

// 1x1 transparent PNG, used for tiles that don't exist (edges / missing zoom levels).
const BLANK_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQAB3qkAAAAASUVORK5CYII=";

let map = null;
let meta = null;
let biomes = null; // { originChunkX, originChunkZ, chunksX, chunksZ, blocksPerCell, palette, grid:Int32Array }
let gridCanvas = null;
let gridCtx = null;
let places = []; // labelled boxes: { id, name, x, z, w, h, color }
let placeLayer = null;
let highlightBiome = null; // { index, name } while a biome-search highlight is showing

// ── Owner-only editing ─────────────────────────────────────────────────────────
// The published site is read-only for visitors: nobody but you can add/edit/delete places or change
// what everyone sees (the public boxes live in the committed places.json, which only you can push to
// GitHub). To unlock the editing tools on YOUR OWN computer, open the site with #edit in the URL —
// e.g.  https://…/index.html#edit  — and it's remembered on this device afterwards.
// For a little extra privacy, set OWNER_SECRET below and unlock with  #edit=yoursecret  instead.
const OWNER_SECRET = ""; // e.g. "my-secret"; leave "" to unlock with just #edit
const EDIT_KEY = "chunkmapper_edit";
let editMode = false;

function initEditMode() {
  const hash = location.hash || "";
  if (hash === "#lock") {
    localStorage.removeItem(EDIT_KEY);
  } else {
    const m = hash.match(/^#edit(?:=(.*))?$/);
    if (m && (OWNER_SECRET ? m[1] === OWNER_SECRET : true)) {
      localStorage.setItem(EDIT_KEY, "1");
    }
  }
  if (hash) history.replaceState(null, "", location.pathname + location.search); // hide token from URL
  editMode = localStorage.getItem(EDIT_KEY) === "1";
}

init();

async function init() {
  initEditMode();
  let res = null;
  try {
    res = await fetch("map.json", { cache: "no-store" });
  } catch (e) {
    /* fetch fails when opened via file:// in some browsers — handled below */
  }
  if (!res || !res.ok) {
    document.getElementById("noMap").hidden = false;
    return;
  }
  meta = await res.json();
  await loadBiomes();
  setupMap();
}

/** Loads the optional biomes.json sidecar (older exports won't have it) and decodes its RLE grid. */
async function loadBiomes() {
  try {
    const res = await fetch("biomes.json", { cache: "no-store" });
    if (!res || !res.ok) return;
    const b = await res.json();
    const grid = new Int32Array(b.chunksX * b.chunksZ);
    const rle = b.rle || [];
    let at = 0;
    for (let i = 0; i + 1 < rle.length; i += 2) {
      const count = rle[i];
      const value = rle[i + 1];
      grid.fill(value, at, at + count);
      at += count;
    }
    b.grid = grid;
    biomes = b;
  } catch (e) {
    /* no biome data — coordinates still work, biome shows as unavailable */
  }
}

/** Biome id (e.g. "minecraft:plains") at a world block, or null if unknown / no biome data. */
function biomeAt(blockX, blockZ) {
  if (!biomes) return null;
  const col = Math.floor(blockX / biomes.blocksPerCell) - biomes.originChunkX;
  const row = Math.floor(blockZ / biomes.blocksPerCell) - biomes.originChunkZ;
  if (col < 0 || col >= biomes.chunksX || row < 0 || row >= biomes.chunksZ) return null;
  const slot = biomes.grid[row * biomes.chunksX + col];
  if (!slot) return null; // 0 = unknown
  return biomes.palette[slot] || null;
}

/** Escapes text for safe insertion into HTML (place names go into a DivIcon's innerHTML). */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/** "minecraft:snowy_taiga" -> "Snowy Taiga". */
function prettyBiome(id) {
  return id
    .replace(/^.*:/, "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function setupMap() {
  const tileSize = meta.tileSize || 256;
  const maxZoom = meta.maxZoom;

  map = L.map("map", {
    crs: L.CRS.Simple,
    minZoom: meta.minZoom || 0,
    maxZoom: maxZoom + 4, // over-zoom levels for getting right up close (crisp, pixelated upscaling)
    zoomControl: true,
    attributionControl: false,
    zoomSnap: 0,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 120,
  });

  // In Simple CRS, a pixel (x, y) of the full-resolution image maps to this lat/lng.
  const sw = map.unproject([0, meta.height], maxZoom);
  const ne = map.unproject([meta.width, 0], maxZoom);
  const bounds = new L.LatLngBounds(sw, ne);

  // Tiles are served from "tiles/" next to this page by default, or from an external store (e.g.
  // Cloudflare R2 / Backblaze B2) when map.json sets "tilesBaseUrl" — used for very large maps that
  // are too big for GitHub Pages but whose viewer page can still live there.
  const tileBase = (meta.tilesBaseUrl || "tiles").replace(/\/+$/, "");
  // Cache-buster: appending the export version means updating the map serves fresh tiles instead of
  // browser-cached old ones (which otherwise show stale/duplicated tiles after an update).
  const ver = meta.version ? "?v=" + encodeURIComponent(meta.version) : "";
  L.tileLayer(tileBase + "/{z}/{x}/{y}.png" + ver, {
    tileSize,
    minZoom: meta.minZoom || 0,
    maxNativeZoom: maxZoom,
    bounds,
    noWrap: true,
    keepBuffer: 4,
    crossOrigin: true,
    errorTileUrl: BLANK_TILE,
  }).addTo(map);

  map.setMaxBounds(bounds.pad(0.25));
  map.fitBounds(bounds);
  // Don't let the map be zoomed out smaller than "whole map fills the view" — otherwise it shrinks
  // into a small island surrounded by black.
  map.setMinZoom(map.getBoundsZoom(bounds));

  setupGrid();
  setupReadout();
  setupContextPopup();
  setupPlaces();
  setupSearch();
}

/** Leaflet lat/lng (pixel point) of a world block coordinate — inverse of toBlock. */
function blockToLatLng(x, z) {
  const px = (x - meta.originBlockX) / meta.blocksPerPixel;
  const pz = (z - meta.originBlockZ) / meta.blocksPerPixel;
  return map.unproject([px, pz], meta.maxZoom);
}

/* ----------------------------------------------------------------------- Right-click popup */

/** Right-click anywhere to pin a popup with the block coordinates, chunk and biome at that point. */
function setupContextPopup() {
  map.on("contextmenu", (e) => {
    const b = toBlock(e.latlng);
    const bx = Math.floor(b.x);
    const bz = Math.floor(b.z);
    const cx = Math.floor(bx / 16);
    const cz = Math.floor(bz / 16);
    const biome = biomeAt(bx, bz);
    const biomeLine = biomes
      ? biome
        ? `<div class="cp-biome">${prettyBiome(biome)}</div>`
        : `<div class="cp-biome cp-muted">Biome unknown here</div>`
      : `<div class="cp-biome cp-muted">No biome data in this map</div>`;

    const html =
      `<div class="cp-coord">X ${bx}, Z ${bz}</div>` +
      `<div class="cp-chunk">chunk ${cx}, ${cz}</div>` +
      biomeLine +
      (editMode
        ? `<button class="cp-add" onclick="addPlaceHere(${bx}, ${bz})">+ Add place here</button>`
        : "");

    L.popup({ className: "coordPopup", closeButton: true, autoPan: false })
      .setLatLng(e.latlng)
      .setContent(html)
      .openOn(map);
  });
}

/** Called from the right-click popup: opens the Places panel with the clicked coords pre-filled. */
window.addPlaceHere = function (bx, bz) {
  map.closePopup();
  openPlacesPanel();
  document.getElementById("pX").value = bx;
  document.getElementById("pZ").value = bz;
  document.getElementById("pName").focus();
};

/* ----------------------------------------------------------------------- Coordinates */

/** World block coordinates of a Leaflet lat/lng (pixel) point. */
function toBlock(latlng) {
  const p = map.project(latlng, meta.maxZoom); // p.x in [0,width], p.y in [0,height]
  return {
    x: meta.originBlockX + p.x * meta.blocksPerPixel,
    z: meta.originBlockZ + p.y * meta.blocksPerPixel,
  };
}

function setupReadout() {
  const readout = document.getElementById("readout");
  const show = (latlng) => {
    const b = toBlock(latlng);
    const bx = Math.floor(b.x);
    const bz = Math.floor(b.z);
    const cx = Math.floor(bx / 16);
    const cz = Math.floor(bz / 16);
    readout.textContent = `X ${bx}, Z ${bz}   ·   chunk ${cx}, ${cz}`;
  };
  map.on("mousemove", (e) => show(e.latlng));
  map.on("mouseout", () => (readout.textContent = "—"));
}

/* ----------------------------------------------------------------------- Grid overlay */

function setupGrid() {
  gridCanvas = document.createElement("canvas");
  gridCanvas.id = "gridCanvas";
  document.body.appendChild(gridCanvas);
  gridCtx = gridCanvas.getContext("2d");

  const redraw = () => drawGrid();
  map.on("move zoom zoomend moveend viewreset resize", redraw);
  document.getElementById("chunkGrid").addEventListener("change", redraw);
  document.getElementById("regionGrid").addEventListener("change", redraw);
  drawGrid();
}

/** Container x-pixel of a vertical line at world block X (constant for all Z in Simple CRS). */
function blockToContainerX(blockX) {
  const pixelX = (blockX - meta.originBlockX) / meta.blocksPerPixel;
  return map.latLngToContainerPoint(map.unproject([pixelX, 0], meta.maxZoom)).x;
}

/** Container y-pixel of a horizontal line at world block Z. */
function blockToContainerY(blockZ) {
  const pixelY = (blockZ - meta.originBlockZ) / meta.blocksPerPixel;
  return map.latLngToContainerPoint(map.unproject([0, pixelY], meta.maxZoom)).y;
}

function drawGrid() {
  const wantChunk = document.getElementById("chunkGrid").checked;
  const wantRegion = document.getElementById("regionGrid").checked;

  const size = map.getSize();
  gridCanvas.width = size.x;
  gridCanvas.height = size.y;
  gridCtx.clearRect(0, 0, size.x, size.y);
  if (!wantChunk && !wantRegion && !highlightBiome) return;

  // Visible block range, from the two screen corners (padded by one step).
  const tl = map.project(map.containerPointToLatLng([0, 0]), meta.maxZoom);
  const br = map.project(map.containerPointToLatLng([size.x, size.y]), meta.maxZoom);
  const bx0 = meta.originBlockX + Math.min(tl.x, br.x) * meta.blocksPerPixel;
  const bx1 = meta.originBlockX + Math.max(tl.x, br.x) * meta.blocksPerPixel;
  const bz0 = meta.originBlockZ + Math.min(tl.y, br.y) * meta.blocksPerPixel;
  const bz1 = meta.originBlockZ + Math.max(tl.y, br.y) * meta.blocksPerPixel;

  // Pixels on screen between two blocks at the current zoom.
  const pxPerBlock = (1 / meta.blocksPerPixel) * Math.pow(2, map.getZoom() - meta.maxZoom);

  if (highlightBiome) {
    drawBiomeHighlight(bx0, bx1, bz0, bz1);
  }
  if (wantRegion && pxPerBlock * 512 >= 6) {
    drawLines(512, bx0, bx1, bz0, bz1, "rgba(224,165,42,0.55)", 1.5);
  }
  if (wantChunk && pxPerBlock * 16 >= 5) {
    drawLines(16, bx0, bx1, bz0, bz1, "rgba(120,140,160,0.40)", 1);
  }
}

/** Fills every visible chunk cell belonging to the highlighted biome with a translucent wash. */
function drawBiomeHighlight(bx0, bx1, bz0, bz1) {
  if (!biomes) return;
  const cell = biomes.blocksPerCell;
  const cx0 = Math.floor(bx0 / cell);
  const cx1 = Math.floor(bx1 / cell);
  const cz0 = Math.floor(bz0 / cell);
  const cz1 = Math.floor(bz1 / cell);
  gridCtx.fillStyle = "rgba(224,165,42,0.40)";
  for (let cz = cz0; cz <= cz1; cz++) {
    const row = cz - biomes.originChunkZ;
    if (row < 0 || row >= biomes.chunksZ) continue;
    for (let cx = cx0; cx <= cx1; cx++) {
      const col = cx - biomes.originChunkX;
      if (col < 0 || col >= biomes.chunksX) continue;
      if (biomes.grid[row * biomes.chunksX + col] !== highlightBiome.index) continue;
      const x = blockToContainerX(cx * cell);
      const y = blockToContainerY(cz * cell);
      const w = blockToContainerX((cx + 1) * cell) - x;
      const h = blockToContainerY((cz + 1) * cell) - y;
      gridCtx.fillRect(x, y, Math.ceil(w) + 1, Math.ceil(h) + 1);
    }
  }
}

function drawLines(step, bx0, bx1, bz0, bz1, color, lineWidth) {
  const size = map.getSize();
  gridCtx.strokeStyle = color;
  gridCtx.lineWidth = lineWidth;
  gridCtx.beginPath();

  for (let bx = Math.ceil(bx0 / step) * step; bx <= bx1; bx += step) {
    const x = Math.round(blockToContainerX(bx)) + 0.5;
    gridCtx.moveTo(x, 0);
    gridCtx.lineTo(x, size.y);
  }
  for (let bz = Math.ceil(bz0 / step) * step; bz <= bz1; bz += step) {
    const y = Math.round(blockToContainerY(bz)) + 0.5;
    gridCtx.moveTo(0, y);
    gridCtx.lineTo(size.x, y);
  }
  gridCtx.stroke();
}

/* ----------------------------------------------------------------------- Search */

function setupSearch() {
  const input = document.getElementById("search");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSearch(input.value);
    } else if (e.key === "Escape") {
      clearBiomeHighlight();
    }
  });
}

/** Runs a search: coordinates ("X Z"), then a place name, then a biome. */
function doSearch(raw) {
  const q = raw.trim();
  if (!q) return;
  clearBiomeHighlight(true);

  const coords = parseCoords(q);
  if (coords) {
    goToCoords(coords[0], coords[1]);
    return;
  }
  const place =
    places.find((p) => p.name.toLowerCase() === q.toLowerCase()) ||
    places.find((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  if (place) {
    goToPlace(place);
    showMsg(`Went to place “${place.name}”`);
    return;
  }
  const biome = findBiome(q);
  if (biome) {
    highlightBiomeSearch(biome);
    return;
  }
  showMsg(`No coordinate, place or biome matches “${q}”.`);
}

/** Two signed integers (with optional x/z, commas, spaces) => [x, z]; otherwise null. */
function parseCoords(q) {
  const nums = q.match(/-?\d+/g);
  if (!nums || nums.length !== 2) return null;
  // Reject if anything other than digits / minus / x,z / separators remains (so named places win).
  const rest = q.replace(/-?\d+/g, "").replace(/[xzXZ,;:\s]/g, "");
  if (rest.length) return null;
  return [parseInt(nums[0], 10), parseInt(nums[1], 10)];
}

function goToCoords(x, z) {
  const ll = blockToLatLng(x + 0.5, z + 0.5);
  map.setView(ll, Math.min(map.getMaxZoom(), meta.maxZoom + 1));
  pulseAt(ll);
  const biome = biomeAt(x, z);
  showMsg(`Went to X ${x}, Z ${z}` + (biome ? ` · ${prettyBiome(biome)}` : ""));
}

let pulseMarker = null;
/** Briefly rings a location so a searched coordinate is easy to spot. */
function pulseAt(ll) {
  if (pulseMarker) map.removeLayer(pulseMarker);
  pulseMarker = L.circleMarker(ll, { radius: 11, color: "#ffd54a", weight: 3, fill: false }).addTo(map);
  setTimeout(() => {
    if (pulseMarker) {
      map.removeLayer(pulseMarker);
      pulseMarker = null;
    }
  }, 2600);
}

/** Finds a palette biome whose name matches the query, preferring an exact name over a partial one. */
function findBiome(q) {
  if (!biomes) return null;
  const ql = q.toLowerCase();
  let partial = null;
  for (let i = 1; i < biomes.palette.length; i++) {
    const id = biomes.palette[i];
    if (!id) continue;
    const pretty = prettyBiome(id).toLowerCase();
    if (pretty === ql) {
      return { index: i, name: prettyBiome(id) };
    }
    if (!partial && (pretty.includes(ql) || id.toLowerCase().includes(ql))) {
      partial = { index: i, name: prettyBiome(id) };
    }
  }
  return partial;
}

function highlightBiomeSearch(b) {
  highlightBiome = b;
  const target = nearestBiomeCell(b.index);
  if (target) {
    map.setView(blockToLatLng(target.x, target.z), Math.max(map.getZoom(), meta.maxZoom - 3));
  }
  drawGrid();
  showMsg(`Highlighting “${b.name}”. Press Esc to clear.`);
}

/** The matching biome cell nearest the current view centre (world block coords of its middle). */
function nearestBiomeCell(index) {
  const cb = toBlock(map.getCenter());
  const cCol = Math.floor(cb.x / biomes.blocksPerCell) - biomes.originChunkX;
  const cRow = Math.floor(cb.z / biomes.blocksPerCell) - biomes.originChunkZ;
  let best = null;
  let bestD = Infinity;
  for (let row = 0; row < biomes.chunksZ; row++) {
    for (let col = 0; col < biomes.chunksX; col++) {
      if (biomes.grid[row * biomes.chunksX + col] !== index) continue;
      const d = (col - cCol) ** 2 + (row - cRow) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { col, row };
      }
    }
  }
  if (!best) return null;
  const half = biomes.blocksPerCell / 2;
  return {
    x: (best.col + biomes.originChunkX) * biomes.blocksPerCell + half,
    z: (best.row + biomes.originChunkZ) * biomes.blocksPerCell + half,
  };
}

function clearBiomeHighlight(silent) {
  if (!highlightBiome) return;
  highlightBiome = null;
  drawGrid();
  if (!silent) showMsg("Cleared biome highlight.");
}

let msgTimer = null;
function showMsg(text) {
  const el = document.getElementById("searchMsg");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => (el.hidden = true), 3800);
}

/* ----------------------------------------------------------------------- Places (labelled boxes) */

const PLACES_KEY = "chunkmapper_places";
let placeSeq = 1;

function setupPlaces() {
  placeLayer = L.layerGroup().addTo(map);
  loadPlaces();
  renderPlaces();

  // Only the owner (edit mode) sees the add/edit/delete/export controls.
  document.getElementById("placesEdit").hidden = !editMode;

  document.getElementById("placesBtn").addEventListener("click", () => {
    const panel = document.getElementById("placesPanel");
    panel.hidden = !panel.hidden;
  });
  document.getElementById("placesClose").addEventListener("click", () => {
    document.getElementById("placesPanel").hidden = true;
  });

  if (editMode) {
    document.getElementById("placeForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = document.getElementById("pName").value.trim();
      const x = parseInt(document.getElementById("pX").value, 10);
      const z = parseInt(document.getElementById("pZ").value, 10);
      const w = Math.max(1, parseInt(document.getElementById("pW").value, 10) || 64);
      const h = Math.max(1, parseInt(document.getElementById("pH").value, 10) || 64);
      const color = document.getElementById("pColor").value;
      if (!name || Number.isNaN(x) || Number.isNaN(z)) {
        showMsg("A box needs a name — use “Select area on the map” or type centre X and Z.");
        return;
      }
      addPlace({ name, x, z, w, h, color });
      resetPlaceForm(color);
    });
    document.getElementById("pSelect").addEventListener("click", startAreaSelect);
    document.getElementById("placesExport").addEventListener("click", exportPlaces);
    document.getElementById("editLock").addEventListener("click", () => {
      localStorage.removeItem(EDIT_KEY);
      location.reload();
    });
    map.on("mousedown", onSelectDown);
    map.on("mousemove", onSelectMove);
    map.on("mouseup", onSelectUp);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && selecting) {
        endAreaSelect();
        showMsg("Selection cancelled.");
      }
    });
  }
}

function resetPlaceForm(keepColor) {
  document.getElementById("placeForm").reset();
  document.getElementById("pW").value = 64;
  document.getElementById("pH").value = 64;
  document.getElementById("pColor").value = keepColor || "#e0a52a";
  document.getElementById("pSelected").hidden = true;
}

function openPlacesPanel() {
  document.getElementById("placesPanel").hidden = false;
}

function normalizePlace(p) {
  const w = p.w || p.size || 64; // `size` = older square-box format
  const h = p.h || p.size || 64;
  return {
    id: p.id || "p" + placeSeq++ + "_" + Date.now(),
    name: String(p.name || "?"),
    x: p.x | 0,
    z: p.z | 0,
    w: w,
    h: h,
    color: p.color || "#e0a52a",
  };
}

/* Pick a box by dragging a rectangle on the map (instead of typing coordinates). */
let selecting = false;
let selStart = null;
let selRect = null;

function startAreaSelect() {
  selecting = true;
  map.dragging.disable();
  document.body.classList.add("selecting");
  document.getElementById("pSelect").classList.add("arming");
  showMsg("Drag on the map to mark the box (or click a spot for a default 64×64 box).");
}

function endAreaSelect() {
  selecting = false;
  map.dragging.enable();
  document.body.classList.remove("selecting");
  document.getElementById("pSelect").classList.remove("arming");
  if (selRect) {
    map.removeLayer(selRect);
    selRect = null;
  }
  selStart = null;
}

function onSelectDown(e) {
  if (!selecting) return;
  selStart = e.latlng;
  selRect = L.rectangle([selStart, selStart], {
    color: "#ffd54a",
    weight: 1,
    dashArray: "4",
    fillOpacity: 0.1,
  }).addTo(map);
}

function onSelectMove(e) {
  if (selecting && selStart && selRect) {
    selRect.setBounds(L.latLngBounds(selStart, e.latlng));
  }
}

function onSelectUp(e) {
  if (!selecting || !selStart) return;
  const a = toBlock(selStart);
  const b = toBlock(e.latlng);
  let w = Math.round(Math.abs(a.x - b.x));
  let h = Math.round(Math.abs(a.z - b.z));
  let cx, cz;
  if (w < 2 && h < 2) {
    // Treated as a click: a default box centred on the clicked block.
    cx = Math.floor(b.x);
    cz = Math.floor(b.z);
    w = 64;
    h = 64;
  } else {
    cx = Math.round((a.x + b.x) / 2);
    cz = Math.round((a.z + b.z) / 2);
  }
  document.getElementById("pX").value = cx;
  document.getElementById("pZ").value = cz;
  document.getElementById("pW").value = w;
  document.getElementById("pH").value = h;
  const note = document.getElementById("pSelected");
  note.textContent = `Selected: centre ${cx}, ${cz} · ${w}×${h} blocks`;
  note.hidden = false;
  endAreaSelect();
  document.getElementById("pName").focus();
  showMsg("Area captured — name it and click “Add box”.");
}

function loadPlaces() {
  try {
    const s = localStorage.getItem(PLACES_KEY);
    if (s) {
      places = JSON.parse(s).map(normalizePlace);
      return;
    }
  } catch (e) {
    /* ignore */
  }
  // No local edits yet — load a committed places.json if the site has one.
  fetch("places.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (Array.isArray(d) && places.length === 0) {
        places = d.map(normalizePlace);
        renderPlaces();
      }
    })
    .catch(() => {});
}

function savePlaces() {
  try {
    localStorage.setItem(PLACES_KEY, JSON.stringify(places));
  } catch (e) {
    /* ignore */
  }
}

function addPlace(p) {
  const place = normalizePlace(p);
  places.push(place);
  savePlaces();
  renderPlaces();
  goToPlace(place);
}

function removePlace(id) {
  places = places.filter((p) => p.id !== id);
  savePlaces();
  renderPlaces();
}

function goToPlace(p) {
  const halfW = Math.max(p.w / 2, 8);
  const halfH = Math.max(p.h / 2, 8);
  map.fitBounds([blockToLatLng(p.x - halfW, p.z - halfH), blockToLatLng(p.x + halfW, p.z + halfH)], {
    maxZoom: meta.maxZoom + 1,
    padding: [50, 50],
  });
}

/** Rebuilds both the on-map boxes and the panel list from `places`. */
function renderPlaces() {
  if (!placeLayer) return;
  placeLayer.clearLayers();
  for (const p of places) {
    const halfW = p.w / 2;
    const halfH = p.h / 2;
    const rect = L.rectangle(
      [blockToLatLng(p.x - halfW, p.z - halfH), blockToLatLng(p.x + halfW, p.z + halfH)],
      { color: p.color, weight: 2, fillColor: p.color, fillOpacity: 0.18 }
    );
    rect.on("click", () => goToPlace(p));
    rect.addTo(placeLayer);
    // Label as a DivIcon marker (cleans up with clearLayers, unlike a permanent tooltip).
    L.marker(blockToLatLng(p.x, p.z), {
      icon: L.divIcon({ className: "place-label", iconSize: [0, 0], html: `<span>${escapeHtml(p.name)}</span>` }),
      interactive: false,
      keyboard: false,
    }).addTo(placeLayer);
  }

  const list = document.getElementById("placesList");
  list.innerHTML = "";
  for (const p of places) {
    const row = document.createElement("div");
    row.className = "place-item";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = p.color;
    const nm = document.createElement("span");
    nm.className = "pname";
    nm.textContent = p.name;
    nm.title = "Go to " + p.name;
    nm.addEventListener("click", () => goToPlace(p));
    row.append(sw, nm);
    if (editMode) {
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "✕";
      del.title = "Delete";
      del.addEventListener("click", () => removePlace(p.id));
      row.append(del);
    }
    list.appendChild(row);
  }
  const empty = document.getElementById("placesEmpty");
  if (empty) empty.hidden = places.length > 0;
}

function exportPlaces() {
  const data = JSON.stringify(places.map(({ id, ...rest }) => rest), null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "places.json";
  a.click();
  URL.revokeObjectURL(a.href);
  showMsg("Downloaded places.json — commit it next to index.html to share your boxes.");
}
