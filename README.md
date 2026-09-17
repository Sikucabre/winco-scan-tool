# WinCo Scan Tool

A mobile-first web app: scan grocery barcodes with your phone camera, look up
the price from a CSV price list, and track a running cart total as you shop.

No framework, no build step, no bundler — just static HTML/CSS/JS.

## How it works

1. Tap "Start scanning" and point your camera at a barcode.
2. Barcode decoding runs client-side via [html5-qrcode](https://github.com/mebjas/html5-qrcode)
   (UPC-A, UPC-E, EAN-13, EAN-8, Code128).
3. The decoded barcode is looked up in `winco-price-list.csv` by the
   `full_barcode` column. A match adds the item and price to the cart and
   updates the running total at the top.
4. Tap any item in the cart to remove it, or use "Clear cart" to start over.
5. If a barcode isn't in the list, the app shows **"Not found — add price
   manually"** with a box to type in a price, so it stays usable for
   anything not yet in your price list.

## Files

```
index.html              App shell
app.js                  Scan flow, CSV parsing/lookup, cart state and rendering
styles.css               Mobile-first styling
winco-price-list.csv    Price list: full_barcode, item_name, price (+ any extra columns)
```

## Updating the price list

`winco-price-list.csv` must have a `full_barcode` column. The app also
recognizes `name`/`description`/`product_name` and `price`/`unit_price`/
`retail_price`/`cost` as alternates for the item-name/price columns, and
ignores any other columns. Rows with no scannable barcode (e.g. bulk/produce
items marked `N/A`) are skipped automatically — add those to the cart with
the manual "Not found" flow instead.

## Running locally

Camera access requires HTTPS or `localhost`. Any static file server works:

```sh
npx serve .
# or
python3 -m http.server 8000
```

Then open the printed URL on your phone (same network) or in a desktop
browser for testing (camera permission prompt still applies).

## Deploying

Any static host works — GitHub Pages, Cloudflare Pages, Netlify, etc. There's
nothing server-side: point the host at this repo's root.
