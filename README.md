# Quick-Commerce-optimization

Warehouse management for a quick-commerce dark store: **Shelf Ledger**. One web page plus a Supabase schema. The customer shop lives in [QC-shop](https://github.com/Sahilrathour007/QC-shop) and sends its orders here.

| File | What it is |
|---|---|
| `index.html` | The app. Tabs: **Orders** (live shop orders with the shelf to pick from), **Warehouse map**, **Inventory**, **Movers & reorder** (80/20 + dynamic reorder point with lead time), **Relocation** (zone moves checked against slot space and weight), **Scan failures**, **Setup**. Runs on demo data until you connect Supabase. |
| `core.js` | Demo data, stock maths and the demo link to the shop. The same file is in QC-shop; keep the two copies identical. |
| `supabase/open-access.sql` / `lock-down.sql` | Turn sign-free access to warehouse data on and off. |
| `supabase/sync.sql` | Lets the site fetch only changed rows and load old scans as totals. Run once after schema.sql and costs.sql. |
| `supabase/seed.sql` | Starter data: products, shelves, opening stock. No orders. |
| `supabase/schema.sql` | Tables, the scan ledger, detector views, the shop catalogue view, the `place_order` and `order_status` functions, and row-level security. |

## Run it
- **Demo:** open `index.html` in a browser. No setup.
- **With GitHub Pages:** turn on Pages for this repo and for QC-shop (Settings → Pages → Deploy from branch → `main`, root). Both sites then live on `sahilrathour007.github.io`, so in demo mode an order placed in the shop shows up in the Orders tab of the same browser.
- **Live (real orders):**
  1. Supabase → SQL Editor: paste `supabase/schema.sql` → Run. Then paste `supabase/seed.sql` → Run. The seed adds 36 products with example prices, 252 shelf slots and opening stock, and no orders. Both files are safe to run again.
  2. **For now there is no staff sign-in.** Paste `supabase/open-access.sql` → Run, so the warehouse site can read the data. ⚠️ While it is on, anyone with the warehouse link can read every order, including customers' names, phone numbers and addresses, and can change order status and lead times. Run `supabase/lock-down.sql` to close it again before real customers order. The shop keeps working either way.
  3. Open the warehouse site. It connects by itself; there is nothing to enter.
  4. The shop is already connected for every visitor (`SHOP_SUPABASE_URL` / `SHOP_SUPABASE_ANON_KEY` in QC-shop's `index.html`).
  5. Your scanner app (or WMS) writes one `scan_events` row per stock movement. The Setup tab lists the fields.

## How it works
- **Stock is never stored as a number.** Every unit movement is a row in `scan_events` (station IN adds, station OUT subtracts). Shelf stock is the sum of those rows. Book stock is received + sellable returns − dispatched.
- **Scan-failure detectors:**
  - inbound: units counted at the dock minus units scanned onto shelves;
  - outbound: units dispatched minus units scanned off shelves;
  - negative shelves: stock scanned out of a slot that never had it scanned in.
- **Reorder point** = average daily sales × lead time + z × daily variation × √lead time. It is recalculated from the last 7, 14 or 28 days every time data loads. Lead time has a default and can be set per SKU (`skus.lead_time_days`).
- **Relocation:**
  - Best movers (the SKUs that make 80% of units) go to zone A; the slow tail leaves it.
  - Every move is checked against the destination slot's space (`capacity_cm3`) and weight (`max_weight_kg`).
  - Space per unit comes from the product's size; when the size is missing, it is estimated from weight ÷ category density.
  - What doesn't fit goes to reserve.
- **Shop connection:** customers never read tables. They read the `shop_catalog` view and call `place_order` (checks stock under a lock, takes prices from the database) and `order_status`.

## Known limits
- The browser loads every table. Fine for one store up to roughly 200k scans; beyond that, move the dashboards onto SQL views.
- No offline queue for scans.
- RLS lets any signed-in user read and write. Tighten it per role before a second store joins.
- No cycle-count screen yet. Book and shelf stock drift apart until someone counts.

## P&L and costs (added)

New files: `costs.js` (cost model), `pnl.js` (P&L, Costs tab, damaged/expired and count forms), `supabase/costs.sql` (cost tables).

1. Run `supabase/costs.sql` in the Supabase SQL Editor. Cost tables are readable by signed-in staff only; they are not covered by `open-access.sql`.
2. Open the **Costs** tab and replace every number tagged `assumed` with an invoice, payslip or rent agreement figure.
3. Without signing in, cost edits stay in the browser. Damaged/expired and count records write to the ledger, so they need sign-in.
4. Every P&L line carries a source tag: ledger, entered, research, assumed. The banner shows how much of the cost stack is measured.

## Review fixes (added)

- **Scan gate:** "Hand to rider" is disabled until every line has a PICK scan. A signed-in user can record a missing pick scan from the order card.
- **Cold last:** pick lists put cold and frozen items last.
- **Reserve shelves:** run `supabase/reserve.sql`; relocation moves now name a real reserve address and show metres of walking saved or added per day.
- **Ranking:** movers are ranked by pick lines, with profit per unit as the tie-break.
- **Lead time:** measured from purchase orders (ordered_at to received_at) when a SKU has any; a typed lead time still wins.
- **Expiry:** `po_lines.expiry_date` (in costs.sql). Order cards show which batch to take first. Order quantity is capped at what can sell before expiry.
- **Not done:** dashboards still download full tables (scale limit), and stock-out censored demand is not corrected.

## Scan station and bug-fix round

**Scan station (Orders → Scan items).** Two steps per unit: scan the shelf label, then the product barcode.
A shelf the ledger says doesn't hold the product, a wrong product or an unknown code is refused with a pop-up and a
low beep, and nothing is written. A correct scan writes one PICK row and moves to the next unit automatically.
"Hand to rider" stays locked until every line is scanned. Enter real EANs on the Costs tab (the seed barcodes are fake).

**Rules now applied everywhere (app, map, SQL views, shop):**
- Book stock = received + sellable returns − dispatched − write-offs − count shortages. Count surpluses only fix the shelf.
- Shrinkage in the P&L counts shortages only. Returns appear as refunds, with restocked units credited back to COGS.
- Order lines save the price paid (`order_lines.unit_price_inr`), so a price change never rewrites history.
- The "measured share" banner counts COGS as a guess until unit costs come from invoices.
- `place_order` merges duplicate lines, caps 10 per line / 40 per order, 3 open orders per phone, 60 shop orders per 10 min.
- When signed in, the database is the source of truth for costs; browser-only edits can be uploaded or discarded.

**Re-run `supabase/costs.sql`** after pulling (safe to repeat), then `lock-down.sql`, and switch off email sign-ups in Supabase.

## Loading and demand (incremental sync, stock-out correction)
- **Run `supabase/sync.sql` once** (safe to repeat). It adds `updated_at` stamps (set by the database) to the tables whose rows change, a `created_at` stamp to `order_lines`, and the `scan_balance_before` function.
- **First load:** scans older than 60 days arrive as one total per product per shelf; newer scans arrive row by row. Stock on every shelf stays exact.
- **Every refresh:** only new or changed rows are fetched, about 50 rows instead of every row of every table. A full reload runs every 30 minutes as a backstop. Without `sync.sql`, the site falls back to reloading whole tables, as before.
- **Stock-out correction:** reorder demand is the average over days the product was in stock. A day counts as out of stock if it ended with nothing to sell, or started empty and sold nothing. Each day's closing stock is rebuilt from today's sellable stock minus every receipt, return, order, write-off and count shortage since. With fewer than 3 in-stock days in the window, it falls back to the plain average. The reorder table shows "N days out · was X" where this changed the number.
