// Grocery Scanner — camera barcode scan -> price-list lookup -> running cart total.
// No build step, no framework. Barcode decoding via the html5-qrcode CDN script
// loaded in index.html (window.Html5Qrcode).

const CSV_PATH = "./winco-price-list.csv";
const BARCODE_COLUMN = "full_barcode";
const NAME_COLUMNS = ["item_name", "name", "description", "product_name", "item", "product"];
const PRICE_COLUMNS = ["price", "unit_price", "retail_price", "cost"];
const SCAN_COOLDOWN_MS = 1200;

const els = {
  total: document.getElementById("total"),
  itemCount: document.getElementById("item-count"),
  listStatus: document.getElementById("list-status"),
  clearBtn: document.getElementById("clear-btn"),
  reader: document.getElementById("reader"),
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
  debugStatus: document.getElementById("debug-status"),
};

const state = {
  priceList: new Map(), // normalized barcode -> { name, price }
  cart: [], // { id, barcode, name, price }
  scanning: false,
  paused: false,
  html5QrCode: null,
};

init();

async function init() {
  await loadPriceList();
  bindEvents();
  render();
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

async function toggleScanning() {
  if (state.scanning) {
    await stopScanning();
  } else {
    await startScanning();
  }
}

async function startScanning() {
  if (!window.Html5Qrcode) {
    showToast("Camera scanner failed to load. Check your connection.", "error");
    return;
  }
  try {
    state.html5QrCode = new Html5Qrcode("reader", {
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128,
      ],
      verbose: false,
    });
    let framesSeen = 0;
    await state.html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10 },
      onDecoded,
      () => {
        // Fires on every frame that didn't decode -- a rising count here
        // proves the scan loop is actually running frame-to-frame.
        framesSeen++;
        els.debugStatus.textContent = `Scanning… ${framesSeen} frames checked`;
      }
    );
    state.scanning = true;
    els.scanToggle.textContent = "Stop scanning";
  } catch (err) {
    console.error("Camera start failed:", err);
    showToast("Couldn't access the camera. Check permissions.", "error");
  }
}

async function stopScanning() {
  if (state.html5QrCode) {
    try {
      await state.html5QrCode.stop();
      state.html5QrCode.clear();
    } catch (err) {
      console.error("Camera stop failed:", err);
    }
  }
  state.html5QrCode = null;
  state.scanning = false;
  els.scanToggle.textContent = "Start scanning";
  els.debugStatus.textContent = "";
}

function onDecoded(decodedText, decodedResult) {
  if (state.paused) return;
  state.paused = true;
  els.debugStatus.textContent = `Decoded: "${decodedText}" (${decodedResult?.result?.format?.formatName || "unknown format"})`;

  const match = lookupBarcode(decodedText);
  if (match) {
    addToCart(decodedText, match.name, match.price);
    showToast(`Added: ${match.name} — ${formatPrice(match.price)}`, "found");
    setTimeout(() => {
      state.paused = false;
    }, SCAN_COOLDOWN_MS);
  } else {
    openManualPanel(decodedText);
    // stays paused until the manual panel is closed
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
  state.paused = false;
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
  addToCart(barcode, name, price);
  showToast(`Added: ${name} — ${formatPrice(price)}`, "found");
  closeManualPanel();
}

// ---------- cart ----------

function addToCart(barcode, name, price) {
  state.cart.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    barcode,
    name,
    price,
  });
  render();
}

function removeFromCart(id) {
  state.cart = state.cart.filter((item) => item.id !== id);
  render();
}

function clearCart() {
  if (state.cart.length === 0) return;
  if (!confirm("Clear the cart?")) return;
  state.cart = [];
  render();
}

// ---------- rendering ----------

function render() {
  const total = state.cart.reduce((sum, item) => sum + item.price, 0);
  els.total.textContent = formatPrice(total);
  els.itemCount.textContent = `${state.cart.length} item${state.cart.length === 1 ? "" : "s"}`;

  els.cartList.innerHTML = "";
  const hasItems = state.cart.length > 0;
  els.emptyState.hidden = hasItems;
  els.cartHint.hidden = !hasItems;

  for (const item of state.cart) {
    const li = document.createElement("li");
    li.className = "cart-item";
    li.setAttribute("role", "button");
    li.setAttribute("tabindex", "0");

    const left = document.createElement("div");
    const nameEl = document.createElement("div");
    nameEl.className = "cart-item-name";
    nameEl.textContent = item.name;
    const barcodeEl = document.createElement("div");
    barcodeEl.className = "cart-item-barcode";
    barcodeEl.textContent = item.barcode;
    left.append(nameEl, barcodeEl);

    const priceEl = document.createElement("div");
    priceEl.className = "cart-item-price";
    priceEl.textContent = formatPrice(item.price);

    li.append(left, priceEl);
    li.addEventListener("click", () => removeFromCart(item.id));
    els.cartList.appendChild(li);
  }
}

function formatPrice(value) {
  return `$${value.toFixed(2)}`;
}

function showToast(message, kind) {
  els.toast.textContent = message;
  els.toast.className = `toast ${kind}`;
  els.toast.hidden = false;
}
