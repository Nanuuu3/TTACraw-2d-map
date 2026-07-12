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

init();

async function init() {
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
    preferCanvas: true,
  });

  // In Simple CRS, a pixel (x, y) of the full-resolution image maps to this lat/lng.
  const sw = map.unproject([0, meta.height], maxZoom);
  const ne = map.unproject([meta.width, 0], maxZoom);
  const bounds = new L.LatLngBounds(sw, ne);

  // Tiles are served from "tiles/" next to this page by default, or from an external store (e.g.
  // Cloudflare R2 / Backblaze B2) when map.json sets "tilesBaseUrl" — used for very large maps that
  // are too big for GitHub Pages but whose viewer page can still live there.
  const tileBase = (meta.tilesBaseUrl || "tiles").replace(/\/+$/, "");
  L.tileLayer(tileBase + "/{z}/{x}/{y}.png", {
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
      biomeLine;

    L.popup({ className: "coordPopup", closeButton: true, autoPan: false })
      .setLatLng(e.latlng)
      .setContent(html)
      .openOn(map);
  });
}

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
  if (!wantChunk && !wantRegion) return;

  // Visible block range, from the two screen corners (padded by one step).
  const tl = map.project(map.containerPointToLatLng([0, 0]), meta.maxZoom);
  const br = map.project(map.containerPointToLatLng([size.x, size.y]), meta.maxZoom);
  const bx0 = meta.originBlockX + Math.min(tl.x, br.x) * meta.blocksPerPixel;
  const bx1 = meta.originBlockX + Math.max(tl.x, br.x) * meta.blocksPerPixel;
  const bz0 = meta.originBlockZ + Math.min(tl.y, br.y) * meta.blocksPerPixel;
  const bz1 = meta.originBlockZ + Math.max(tl.y, br.y) * meta.blocksPerPixel;

  // Pixels on screen between two blocks at the current zoom.
  const pxPerBlock = (1 / meta.blocksPerPixel) * Math.pow(2, map.getZoom() - meta.maxZoom);

  if (wantRegion && pxPerBlock * 512 >= 6) {
    drawLines(512, bx0, bx1, bz0, bz1, "rgba(224,165,42,0.55)", 1.5);
  }
  if (wantChunk && pxPerBlock * 16 >= 5) {
    drawLines(16, bx0, bx1, bz0, bz1, "rgba(120,140,160,0.40)", 1);
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
