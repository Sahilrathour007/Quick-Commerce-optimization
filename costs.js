/* costs.js — dark-store contribution P&L model. Pure functions, no DOM, no network.
 * Works in the browser (window.QCCost) and in Node (module.exports) so it can be tested.
 *
 * Every number carries a SOURCE TAG so the P&L can say how much of it is measured:
 *   ledger   = computed from your scans / orders / counts
 *   entered  = you typed it (invoice, payslip, rent agreement)
 *   research = from public sources, a range; replace with your own rate card
 *   assumed  = a placeholder guess. Replace before you trust the margin.
 */
(function (root) {
  "use strict";
  const DAY = 86400e3;

  // ---------- Rate card (all editable in the Costs tab) ----------------------
  // src: where the default came from. unit: how it is charged.
  const DEFAULT_RATES = {
    // Delivery fee charged to the customer (matches place_order() in schema.sql)
    fee_threshold:   { v: 199,   src: "entered",  label: "Free delivery above basket (₹)", unit: "₹" },
    fee_amount:      { v: 25,    src: "entered",  label: "Delivery fee below that (₹, incl. GST)", unit: "₹" },
    fee_gst_pct:     { v: 18,    src: "research", label: "GST on delivery fee (%)", unit: "%" },
    // Rider pay: base + per-km beyond free km.  Reported: Blinkit base cut Rs50 -> 25 -> 15 per order with a
    // distance component; older structure Rs25 + Rs2.5/km after 2 km; recent reports Rs9–12/km.
    rider_base:      { v: 25,    src: "research", label: "Rider base pay per order (₹)", unit: "₹" },
    rider_free_km:   { v: 2,     src: "research", label: "Km covered by base pay", unit: "km" },
    rider_per_km:    { v: 9,     src: "research", label: "Rider pay per km beyond that (₹)", unit: "₹" },
    road_factor:     { v: 1.35,  src: "assumed",  label: "Road km ÷ straight-line km", unit: "x" },
    avg_distance_km: { v: 1.8,   src: "assumed",  label: "Distance used when an order has no location (km)", unit: "km" },
    wh_lat:          { v: 26.9124, src: "assumed", label: "Warehouse latitude", unit: "°" },
    wh_lng:          { v: 75.7873, src: "assumed", label: "Warehouse longitude", unit: "°" },
    // Payment: UPI/RuPay debit = 0 MDR; cards ~1.5–2.2%; gateways list ~2% + GST. Blend assumes mostly UPI.
    payment_pct:     { v: 0.6,   src: "assumed",  label: "Blended payment fee (% of order value)", unit: "%" },
    bag_fill:        { v: 0.6,   src: "assumed",  label: "Usable share of a bag's volume", unit: "x" },
    // Fixed, per month
    staff_count:     { v: 3,     src: "entered",  label: "Pick/pack staff (count)", unit: "#" },
    staff_salary:    { v: 15000, src: "entered",  label: "Salary per staff per month (₹)", unit: "₹" },
    rent:            { v: 120000, src: "assumed", label: "Rent per month (₹)", unit: "₹" },
    power:           { v: 35000, src: "assumed",  label: "Electricity incl. cold chain (₹/month)", unit: "₹" },
    manager:         { v: 35000, src: "assumed",  label: "Store manager (₹/month)", unit: "₹" },
    security:        { v: 20000, src: "assumed",  label: "Security + housekeeping (₹/month)", unit: "₹" },
    internet:        { v: 3000,  src: "assumed",  label: "Internet + devices (₹/month)", unit: "₹" },
    // Inventory carrying: Christopher (2011) puts total carrying near 25% of stock value a year.
    cost_of_funds_pct: { v: 12,  src: "assumed",  label: "Cost of funds (% a year)", unit: "%" },
    insurance_pct:   { v: 0.5,   src: "assumed",  label: "Insurance (% of stock value a year)", unit: "%" },
  };

  // Bags bought in bulk. Capacity = outer volume. Prices from listings: kraft ~₹8–9.2/pc (100 pack, MOQ),
  // non-woven ₹5–14/pc. Small 20x10x25, Medium 30x15x35, Large 40x20x45 cm are the usual paper-bag sizes.
  const DEFAULT_BAGS = [
    { id: "S", name: "Small 20×10×25 cm", cm3: 5000,  price: 5,  src: "research" },
    { id: "M", name: "Medium 30×15×35 cm", cm3: 15750, price: 8,  src: "research" },
    { id: "L", name: "Large 40×20×45 cm",  cm3: 36000, price: 12, src: "research" },
  ];

  // Trade margin by category (gross, as % of MRP, which includes GST). Source: kirana margin bands (staples low-single to high-single,
  // packaged FMCG high-single to mid-teens, beverages low to high teens, personal care low-teens to 20, general
  // merchandise mid-teens up). No dairy / baby / frozen numbers found: those are guesses.
  const CAT_MARGIN = { Dairy: 0.07, Frozen: 0.15, Bakery: 0.12, "Instant food": 0.11, Biscuits: 0.12, Snacks: 0.14,
    Beverages: 0.13, Staples: 0.07, "Home care": 0.15, "Personal care": 0.17, Baby: 0.1 };
  // Typical shelf life (days) when you have not set one. Check against pack labels.
  const CAT_SHELF = { Dairy: 5, Frozen: 180, Bakery: 4, "Instant food": 240, Biscuits: 180, Snacks: 120,
    Beverages: 180, Staples: 270, "Home care": 540, "Personal care": 730, Baby: 730 };
  // GST on goods, % (from 22 Sep 2025 cuts; carbonated drinks 40%). Milk/bread/eggs/atta ~0 — confirm on invoice.
  const GST_DEFAULT = { Dairy: 5, Frozen: 5, Bakery: 5, "Instant food": 5, Biscuits: 5, Snacks: 12, Beverages: 18,
    Staples: 5, "Home care": 18, "Personal care": 18, Baby: 12 };

  // ---------- Helpers ---------------------------------------------------------
  const num = (x, d) => (x == null || x === "" || isNaN(+x)) ? d : +x;
  const r2 = x => Math.round(x * 100) / 100;

  function rates(overrides) {                 // -> {key: number}, plus .src map
    const out = {}, src = {};
    for (const k in DEFAULT_RATES) { out[k] = DEFAULT_RATES[k].v; src[k] = DEFAULT_RATES[k].src; }
    for (const k in (overrides || {})) { if (k in out && overrides[k] != null && overrides[k] !== "" && !isNaN(+overrides[k])) { out[k] = +overrides[k]; src[k] = "entered"; } }
    Object.defineProperty(out, "src", { value: src, enumerable: false });
    return out;
  }

  function haversineKm(la1, lo1, la2, lo2) {
    const R = 6371, t = x => x * Math.PI / 180, dLa = t(la2 - la1), dLo = t(lo2 - lo1);
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(t(la1)) * Math.cos(t(la2)) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  // Returns {km, src}. src: entered (order.distance_km) | derived (coordinates) | assumed (default)
  function distanceOf(order, R) {
    if (order && order.distance_km != null && order.distance_km !== "" && +order.distance_km >= 0) return { km: +order.distance_km, src: "entered" };
    if (order && order.dest_lat != null && order.dest_lng != null && isFinite(+order.dest_lat) && isFinite(+order.dest_lng))
      return { km: haversineKm(R.wh_lat, R.wh_lng, +order.dest_lat, +order.dest_lng) * R.road_factor, src: "derived" };
    return { km: R.avg_distance_km, src: "assumed" };
  }
  function riderPay(km, R) { return R.rider_base + Math.max(0, km - R.rider_free_km) * R.rider_per_km; }

  // Smallest single bag that fits; else as many largest bags as needed.
  function bagsFor(volCm3, R, bags) {
    const list = (bags && bags.length ? bags : DEFAULT_BAGS).slice().sort((a, b) => a.cm3 - b.cm3);
    for (const b of list) if (volCm3 <= b.cm3 * R.bag_fill) return { bag: b, n: 1, cost: +b.price };
    const big = list[list.length - 1], n = Math.ceil(volCm3 / (big.cm3 * R.bag_fill));
    return { bag: big, n, cost: n * big.price };
  }

  // ---------- Per-SKU cost sheet ---------------------------------------------
  // costRow from sku_costs: {sku_id, unit_cost_inr, gst_pct, shelf_life_days, discount_pct}
  function skuCost(sku, costRow) {
    const mrp = num(sku.mrp_inr, num(sku.price_inr, 0));
    const hasCost = costRow && costRow.unit_cost_inr != null;
    const gst = costRow && costRow.gst_pct != null ? +costRow.gst_pct : (GST_DEFAULT[sku.category] ?? 12);
    // MRP includes GST and the trade margin is quoted on MRP, so the invoice price is MRP x (1 - margin) INCLUDING GST.
    // Unit cost here is ex-GST (GST on purchases is claimed back), so divide the GST out.
    const cost = hasCost ? +costRow.unit_cost_inr : r2(mrp * (1 - (CAT_MARGIN[sku.category] ?? 0.12)) / (1 + gst / 100));
    const shelf = costRow && costRow.shelf_life_days != null ? +costRow.shelf_life_days : (CAT_SHELF[sku.category] ?? 180);
    // selling price: explicit price_inr wins; discount_pct (if set on the cost row) is applied to MRP
    const price = costRow && costRow.discount_pct != null && costRow.discount_pct !== ""
      ? Math.round(mrp * (1 - +costRow.discount_pct / 100)) : num(sku.price_inr, mrp);
    return { sku_id: sku.sku_id, mrp, price, cost, gst, shelf, costSrc: hasCost ? "entered" : "assumed",
             shelfSrc: costRow && costRow.shelf_life_days != null ? "entered" : "assumed",
             discount: mrp > 0 ? 1 - price / mrp : 0 };
  }

  // ---------- Per-order contribution -----------------------------------------
  // ctx: {R, bags, sku: Map(sku_id -> skuCost), vol: fn(skuRow)->cm3, skuRow: Map, customLines: [..]}
  function orderEconomics(order, lines, ctx) {
    const R = ctx.R; let gross = 0, items = 0, itemsIncl = 0, rev = 0, cogs = 0, vol = 0, promo = 0;
    for (const l of lines) {
      const c = ctx.sku.get(l.sku_id); if (!c) continue;
      gross += c.mrp * l.qty; itemsIncl += c.price * l.qty; items += l.qty;
      rev += (c.price / (1 + c.gst / 100)) * l.qty;      // revenue net of GST
      promo += Math.max(0, c.mrp - c.price) * l.qty;      // discount given vs MRP (incl. GST)
      cogs += c.cost * l.qty;
      const row = ctx.skuRow && ctx.skuRow.get(l.sku_id); vol += (row ? ctx.vol(row) : 150) * l.qty;
    }
    // delivery fee: use what the order recorded if it did, else apply the rule
    let feeIncl = order && order.total_inr != null ? Math.max(0, +order.total_inr - itemsIncl) : (itemsIncl < R.fee_threshold ? R.fee_amount : 0);
    if (feeIncl < 0.5) feeIncl = 0;
    const feeNet = feeIncl / (1 + R.fee_gst_pct / 100);
    const orderValue = itemsIncl + feeIncl;
    const dist = distanceOf(order, R), rider = riderPay(dist.km, R), bag = bagsFor(vol, R, ctx.bags);
    const payment = orderValue * R.payment_pct / 100;
    let other = 0;
    for (const c of (ctx.customLines || [])) {
      if (c.basis === "order") other += +c.amount || 0;
      else if (c.basis === "pct_sales") other += (rev + feeNet) * (+c.amount || 0) / 100;
    }
    const revenue = rev + feeNet, variable = cogs + rider + bag.cost + payment + other;
    return { order_id: order && order.order_id, items, lines: lines.length, basket: itemsIncl, feeIncl, orderValue, gross, promo,
      rev, feeNet, revenue, cogs, rider, bagCost: bag.cost, bagN: bag.n, bagId: bag.bag.id, payment, other,
      contribution: revenue - variable, km: dist.km, kmSrc: dist.src, vol };
  }

  // ---------- Period P&L ------------------------------------------------------
  // inp: {orders: [{order, lines}], days, R, customLines, invValueCost, writeOffCost, shrinkCost, ctx}
  function periodPnL(inp) {
    const R = inp.R, days = Math.max(1, inp.days), months = days / 30;
    const rows = inp.orders.map(o => orderEconomics(o.order, o.lines, inp.ctx));
    const S = f => rows.reduce((t, r) => t + f(r), 0);
    const n = rows.length;
    const gross = S(r => r.gross), promo = S(r => r.promo), rev = S(r => r.rev), fee = S(r => r.feeNet);
    const cogs = S(r => r.cogs), rider = S(r => r.rider), bags = S(r => r.bagCost), pay = S(r => r.payment), oth = S(r => r.other);
    const writeOff = inp.writeOffCost || 0, shrink = inp.shrinkCost || 0;
    const revenue = rev + fee, gp = revenue - cogs;
    const contribution = gp - rider - bags - pay - oth - writeOff - shrink;
    // fixed (per month -> period)
    const fixedLines = [
      { id: "staff", label: `Pick/pack staff (${R.staff_count} × ₹${R.staff_salary.toLocaleString("en-IN")})`, amt: R.staff_count * R.staff_salary * months, src: R.src.staff_salary },
      { id: "rent", label: "Rent", amt: R.rent * months, src: R.src.rent },
      { id: "power", label: "Electricity", amt: R.power * months, src: R.src.power },
      { id: "manager", label: "Store manager", amt: R.manager * months, src: R.src.manager },
      { id: "security", label: "Security + housekeeping", amt: R.security * months, src: R.src.security },
      { id: "internet", label: "Internet + devices", amt: R.internet * months, src: R.src.internet },
    ];
    let customVar = 0;
    for (const c of (inp.customLines || [])) {
      const a = +c.amount || 0; if (c.basis === "order" || c.basis === "pct_sales") continue;
      const amt = c.basis === "day" ? a * days : c.basis === "trip" ? a * n : a * months;   // month default
      fixedLines.push({ id: c.id, label: c.label, amt, src: "entered", custom: true });
    }
    const fixed = fixedLines.reduce((t, f) => t + f.amt, 0);
    const carrying = (inp.invValueCost || 0) * (R.cost_of_funds_pct + R.insurance_pct) / 100 * days / 365;
    const storeProfit = contribution - fixed - carrying;
    // How much of the cost stack is measured vs guessed
    const meas = cogs + (rows.filter(r => r.kmSrc !== "assumed").reduce((t, r) => t + r.rider, 0)) + writeOff + shrink;
    const totalCost = cogs + rider + bags + pay + oth + writeOff + shrink + fixed + carrying;
    const guessed = fixedLines.filter(f => f.src === "assumed").reduce((t, f) => t + f.amt, 0)
      + rows.filter(r => r.kmSrc === "assumed").reduce((t, r) => t + r.rider, 0) + bags + pay + carrying
      + (inp.assumedCogs || 0);
    return { n, days, rows, gross, promo, rev, fee, revenue, cogs, gp, rider, bags, pay, other: oth, writeOff, shrink,
      contribution, fixedLines, fixed, carrying, storeProfit, totalCost, guessed, measuredShare: totalCost > 0 ? 1 - guessed / totalCost : null,
      perOrder: n ? { revenue: revenue / n, contribution: contribution / n, storeProfit: storeProfit / n } : null,
      breakevenOrdersPerDay: (rows.length && contribution > 0) ? ((fixed + carrying) / (contribution / n)) / days : null };
  }

  // ---------- Expiry risk -----------------------------------------------------
  // For each sku: units that cannot sell before they expire at the current sales rate.
  function expiryRisk(onHand, avgDaily, shelfDays, unitCost) {
    const canSell = avgDaily * shelfDays, atRisk = Math.max(0, onHand - canSell);
    return { atRiskUnits: atRisk, atRiskValue: atRisk * unitCost, daysCover: avgDaily > 0 ? onHand / avgDaily : Infinity };
  }

  root.QCCost = { DEFAULT_RATES, DEFAULT_BAGS, CAT_MARGIN, CAT_SHELF, GST_DEFAULT, rates, haversineKm, distanceOf, riderPay, bagsFor,
    skuCost, orderEconomics, periodPnL, expiryRisk };
  if (typeof module !== "undefined" && module.exports) module.exports = root.QCCost;
})(typeof window !== "undefined" ? window : globalThis);
