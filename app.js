// Grocery Scanner — camera barcode scan -> price-list lookup -> running cart total.
// No build step, no framework. Barcode decoding via the zxing-wasm CDN script
// loaded in index.html (window.ZXingWASM) -- the actual ZXing C++ decoder
// compiled to WebAssembly. Swapped in after html5-qrcode's bundled JS decoder
// proved unable to read any 1D barcode on iOS Safari (a well-known limitation
// of that library, not a resolution/config issue -- camera preview and the
// scan loop both worked fine, decoding itself just never succeeded).

const CSV_PATH = "./winco-price-list.csv";
const STORAGE_KEY = "winco-scan-cart";
const BARCODE_COLUMN = "full_barcode";
const NAME_COLUMNS = ["item_name", "name", "description", "product_name", "item", "product"];
const PRICE_COLUMNS = ["price", "unit_price", "retail_price", "cost"];
const SCAN_INTERVAL_MS = 60;
const MAX_QTY = 999;

const READER_OPTIONS = {
  formats: ["EANUPC", "Code128"],
  tryHarder: true,
  tryRotate: true, // sideways and upside-down barcodes
  tryInvert: true, // light bars on a dark label
  tryDownscale: true,
  maxNumberOfSymbols: 1, // stop at the first hit instead of scanning the whole frame
};

const els = {
  total: document.getElementById("total"),
  itemCount: document.getElementById("item-count"),
  listStatus: document.getElementById("list-status"),
  clearBtn: document.getElementById("clear-btn"),
  reader: document.getElementById("reader"),
  video: document.getElementById("camera-video"),
  scanToggle: document.getElementById("scan-toggle"),
  toast: document.getElementById("toast"),
  manualPanel: document.getElementById("manual-panel"),
  manualBarcodeValue: document.getElementById("manual-barcode-value"),
  manualName: document.getElementById("manual-name"),
  manualPrice: document.getElementById("manual-price"),
  manualError: document.getElementById("manual-error"),
  manualCancel: document.getElementById("manual-cancel"),
  manualAdd: document.getElementById("manual-add"),
  cartHint: document.getElementById("cart-hint"),
  cartList: document.getElementById("cart-list"),
  emptyState: document.getElementById("empty-state"),
};

const state = {
  priceList: new Map(), // normalized barcode -> { name, price }
  cart: [], // { barcode, name, price, qty }
  scanning: false,
  stream: null,
  scanTimer: null,
  canvas: null,
};

init();

async function init() {
  state.cart = loadCart();
  render();
  bindEvents();
  await loadPriceList();
}

// ---------- persistence ----------

// The cart survives leaving the app, locking the phone or reloading mid-trip.
// It's per-device and never leaves the phone.
function loadCart() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Saved by an older version, hand-edited, or half-written: keep only
    // entries that are actually usable rather than rendering garbage.
    return parsed
      .filter(
        (item) =>
          item &&
          typeof item.barcode === "string" &&
          typeof item.name === "string" &&
          Number.isFinite(item.price) &&
          Number.isFinite(item.qty) &&
          item.qty > 0
      )
      .map((item) => ({
        barcode: item.barcode,
        name: item.name,
        price: item.price,
        qty: Math.floor(item.qty),
      }));
  } catch (err) {
    console.error("Couldn't restore the saved cart:", err);
    return [];
  }
}

function saveCart() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cart));
  } catch (err) {
    console.error("Couldn't save the cart:", err);
  }
}

// ---------- price list ----------

async function loadPriceList() {
  try {
    const res = await fetch(CSV_PATH);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCSV(text);
    if (rows.length < 1) throw new Error("empty file");

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const barcodeIdx = header.indexOf(BARCODE_COLUMN);
    const nameIdx = header.findIndex((h) => NAME_COLUMNS.includes(h));
    const priceIdx = header.findIndex((h) => PRICE_COLUMNS.includes(h));

    if (barcodeIdx === -1) throw new Error(`missing "${BARCODE_COLUMN}" column`);

    let loaded = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const rawBarcode = (row[barcodeIdx] || "").trim();
      if (!rawBarcode) continue;
      const name = nameIdx !== -1 ? (row[nameIdx] || "").trim() : "";
      const priceRaw = priceIdx !== -1 ? (row[priceIdx] || "").trim() : "";
      const price = parseFloat(priceRaw.replace(/[^0-9.]/g, ""));
      if (!name || Number.isNaN(price)) continue;

      const variants = barcodeVariants(rawBarcode);
      if (variants.size === 0 || [...variants].every((v) => v === "")) continue; // bulk/produce rows with no scannable barcode

      for (const key of variants) {
        state.priceList.set(key, { name, price });
      }
      loaded++;
    }

    els.listStatus.textContent = `${loaded} items loaded`;
  } catch (err) {
    els.listStatus.textContent = "Price list unavailable — every scan needs a manual price";
    console.error("Failed to load price list:", err);
  }
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // skip
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

// UPC-A (12 digits) and EAN-13 (13 digits, leading 0) are often the same
// physical barcode read differently depending on the scanner/CSV source.
// Index both forms so a lookup succeeds either way.
function barcodeVariants(raw) {
  const digits = raw.replace(/\D/g, "");
  const variants = new Set([digits]);
  if (digits.length === 13 && digits.startsWith("0")) variants.add(digits.slice(1));
  if (digits.length === 12) variants.add(`0${digits}`);
  return variants;
}

function lookupBarcode(raw) {
  for (const key of barcodeVariants(raw)) {
    if (state.priceList.has(key)) return state.priceList.get(key);
  }
  return null;
}

// ---------- scanning ----------

function bindEvents() {
  els.scanToggle.addEventListener("click", toggleScanning);
  els.clearBtn.addEventListener("click", clearCart);
  els.manualAdd.addEventListener("click", submitManualEntry);
  els.manualCancel.addEventListener("click", closeManualPanel);
}

function toggleScanning() {
  if (state.scanning) {
    stopScanning();
  } else {
    startScanning();
  }
}

async function startScanning() {
  if (!window.ZXingWASM) {
    showToast("Barcode scanner failed to load. Check your connection.", "error");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        // Request a high-res stream -- the default camera resolution is
        // often too coarse to resolve a UPC/EAN's fine bars at any real
        // distance.
        width: { min: 640, ideal: 1920, max: 1920 },
        height: { min: 480, ideal: 1080, max: 1080 },
      },
    });
    state.stream = stream;
    els.video.srcObject = stream;
    await els.video.play();

    state.scanning = true;
    els.scanToggle.textContent = "Stop scanning";
    scanLoop();
  } catch (err) {
    console.error("Camera start failed:", err);
    showToast("Couldn't access the camera. Check permissions.", "error");
  }
}

function stopScanning() {
  state.scanning = false;
  if (state.scanTimer) {
    clearTimeout(state.scanTimer);
    state.scanTimer = null;
  }
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  els.video.srcObject = null;
  els.scanToggle.textContent = "Start scanning";
}

async function scanLoop() {
  if (!state.scanning) return;
  try {
    const frame = grabFrame();
    if (frame) {
      const results = await ZXingWASM.readBarcodes(frame, READER_OPTIONS);
      if (!state.scanning) return; // stopped mid-decode
      if (results.length > 0) {
        onDecoded(results[0].text); // stops the scanner, ending this loop
      }
    }
  } catch (err) {
    console.error("Decode error:", err);
  }
  if (state.scanning) {
    state.scanTimer = setTimeout(scanLoop, SCAN_INTERVAL_MS);
  }
}

function grabFrame() {
  const video = els.video;
  if (!video.videoWidth) return null; // stream not ready yet
  if (!state.canvas) {
    state.canvas = document.createElement("canvas");
  }
  const canvas = state.canvas;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// One tap of Start scanning registers exactly one item: the camera shuts off
// the moment something decodes, so nothing can be double-counted while the
// barcode is still in frame.
function onDecoded(decodedText) {
  stopScanning();

  const match = lookupBarcode(decodedText);
  if (match) {
    const qty = addToCart(decodedText, match.name, match.price);
    const suffix = qty > 1 ? ` (×${qty})` : "";
    showToast(`Added: ${match.name} — ${formatPrice(match.price)}${suffix}`, "found");
  } else {
    openManualPanel(decodedText);
  }
}

// ---------- manual entry (barcode not found) ----------

function openManualPanel(barcode) {
  els.manualBarcodeValue.textContent = barcode;
  els.manualName.value = "";
  els.manualPrice.value = "";
  els.manualError.hidden = true;
  els.manualPanel.hidden = false;
  els.manualPanel.dataset.barcode = barcode;
  els.manualPrice.focus();
}

function closeManualPanel() {
  els.manualPanel.hidden = true;
  delete els.manualPanel.dataset.barcode;
}

function submitManualEntry() {
  const barcode = els.manualPanel.dataset.barcode;
  const price = parseFloat(els.manualPrice.value);
  if (Number.isNaN(price) || price < 0) {
    els.manualError.textContent = "Enter a valid price.";
    els.manualError.hidden = false;
    return;
  }
  const name = els.manualName.value.trim() || `Unknown item (${barcode})`;
  const qty = addToCart(barcode, name, price);
  const suffix = qty > 1 ? ` (×${qty})` : "";
  showToast(`Added: ${name} — ${formatPrice(price)}${suffix}`, "found");
  closeManualPanel();
}

// ---------- cart ----------

// Scanning the same barcode again bumps its quantity rather than adding a
// second line, so the price is only ever recorded once per item. Either way
// the item moves to the top of the list, where the last thing scanned is.
function addToCart(barcode, name, price) {
  const existing = state.cart.find((item) => item.barcode === barcode);
  const entry = existing || { barcode, name, price, qty: 0 };
  entry.qty++;
  state.cart = [entry, ...state.cart.filter((item) => item.barcode !== barcode)];
  saveCart();
  render();
  return entry.qty;
}

// Quantity bottoms out at 1 -- the Remove button is the only way to drop an
// item, so a stray tap on - can't silently delete a line.
function setQty(barcode, qty) {
  const item = state.cart.find((entry) => entry.barcode === barcode);
  if (!item) return;
  item.qty = Math.min(Math.max(Math.floor(qty), 1), MAX_QTY);
  saveCart();
  render();
}

function changeQty(barcode, delta) {
  const item = state.cart.find((entry) => entry.barcode === barcode);
  if (!item) return;
  setQty(barcode, item.qty + delta);
}

function removeItem(barcode) {
  state.cart = state.cart.filter((entry) => entry.barcode !== barcode);
  saveCart();
  render();
}

function clearCart() {
  if (state.cart.length === 0) return;
  if (!confirm("Clear the cart?")) return;
  state.cart = [];
  saveCart();
  render();
}

// ---------- rendering ----------

function render() {
  const total = state.cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const count = state.cart.reduce((sum, item) => sum + item.qty, 0);
  els.total.textContent = formatPrice(total);
  els.itemCount.textContent = `${count} item${count === 1 ? "" : "s"}`;

  els.cartList.innerHTML = "";
  const hasItems = state.cart.length > 0;
  els.emptyState.hidden = hasItems;
  els.cartHint.hidden = !hasItems;

  for (const item of state.cart) {
    els.cartList.appendChild(renderCartItem(item));
  }
}

function renderCartItem(item) {
  const li = document.createElement("li");
  li.className = "cart-item";

  const topRow = document.createElement("div");
  topRow.className = "cart-item-row";
  const nameEl = document.createElement("span");
  nameEl.className = "cart-item-name";
  nameEl.textContent = item.name;
  const lineTotalEl = document.createElement("span");
  lineTotalEl.className = "cart-item-price";
  lineTotalEl.textContent = formatPrice(item.price * item.qty);
  topRow.append(nameEl, lineTotalEl);

  const bottomRow = document.createElement("div");
  bottomRow.className = "cart-item-row";
  const unitEl = document.createElement("span");
  unitEl.className = "cart-item-unit";
  unitEl.textContent = `${formatPrice(item.price)} each`;

  const qtyControls = document.createElement("div");
  qtyControls.className = "qty-controls";
  const minus = document.createElement("button");
  minus.type = "button";
  minus.className = "qty-btn";
  minus.textContent = "−";
  minus.setAttribute("aria-label", `One fewer ${item.name}`);
  minus.addEventListener("click", () => changeQty(item.barcode, -1));

  const qtyInput = document.createElement("input");
  qtyInput.className = "qty-input";
  qtyInput.type = "number";
  qtyInput.inputMode = "numeric";
  qtyInput.min = "1";
  qtyInput.max = String(MAX_QTY);
  qtyInput.step = "1";
  qtyInput.value = item.qty;
  qtyInput.setAttribute("aria-label", `Quantity of ${item.name}`);
  // Commit on blur/enter rather than each keystroke: re-rendering mid-typing
  // would tear the field out from under the keyboard.
  qtyInput.addEventListener("change", () => {
    const typed = parseInt(qtyInput.value, 10);
    if (Number.isNaN(typed)) {
      qtyInput.value = item.qty; // leave the quantity alone on junk input
      return;
    }
    setQty(item.barcode, typed);
  });
  qtyInput.addEventListener("focus", () => qtyInput.select());

  const plus = document.createElement("button");
  plus.type = "button";
  plus.className = "qty-btn";
  plus.textContent = "+";
  plus.setAttribute("aria-label", `One more ${item.name}`);
  plus.addEventListener("click", () => changeQty(item.barcode, 1));
  qtyControls.append(minus, qtyInput, plus);

  // Sits on the far left, away from the quantity controls, so reaching for
  // - can't land on it.
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "remove-btn";
  removeBtn.textContent = "×";
  removeBtn.setAttribute("aria-label", `Remove ${item.name} from the cart`);
  removeBtn.addEventListener("click", () => removeItem(item.barcode));

  bottomRow.append(removeBtn, unitEl, qtyControls);
  li.append(topRow, bottomRow);
  return li;
}

function formatPrice(value) {
  return `$${value.toFixed(2)}`;
}

function showToast(message, kind) {
  els.toast.textContent = message;
  els.toast.className = `toast ${kind}`;
  els.toast.hidden = false;
}
