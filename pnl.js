/* pnl.js — P&L, Costs and inventory-loss screens for Shelf Ledger.
 * Loaded BEFORE the main script; every function runs after boot, so it can use the page's globals
 * ($, esc, S, I, NOW, ms, ls, sb, MODE, unitVol, analyse, loadAll, reindex, render, locChip, fmtN).
 */
"use strict";
const PNL = (function () {
  const Q = window.QCCost;
  const OPT = ["sku_costs", "cost_rates", "cost_lines", "bag_types", "write_offs"];
  const st = { win: 28, auth: false, email: "", err: "", note: "" };
  const LS = { rates: "shelfledger.rates", lines: "shelfledger.lines", sku: "shelfledger.skucost", dist: "shelfledger.dist", bags: "shelfledger.bags" };
  const inr = x => (x < 0 ? "−₹" : "₹") + Math.abs(Math.round(x)).toLocaleString("en-IN");
  const inr1 = x => (x < 0 ? "−₹" : "₹") + Math.abs(x).toFixed(1);
  const SRC_CLASS = { ledger: "good", entered: "good", research: "neutral", derived: "neutral", assumed: "warn" };
  const srcPill = s => `<span class="pill ${SRC_CLASS[s] || "neutral"}">${s}</span>`;
  const num = (x, d) => (x == null || x === "" || isNaN(+x)) ? d : +x;

  // ---------- data access (database when signed in, this browser otherwise) ----------
  function dbRates() { const m = {}; for (const r of (S.cost_rates || [])) m[r.key] = +r.value; return m; }
  function R() { return Q.rates(Object.assign({}, st.auth ? {} : ls.get(LS.rates, {}), dbRates())); }
  function lines() { return (st.auth || (S.cost_lines && S.cost_lines.length)) ? (S.cost_lines || []).filter(l => l.active !== false) : ls.get(LS.lines, []); }
  function bags() { return (S.bag_types && S.bag_types.length) ? S.bag_types.map(b => ({ id: b.id, name: b.name, cm3: +b.cm3, price: +b.price, src: "entered" })) : (ls.get(LS.bags, null) || Q.DEFAULT_BAGS); }
  function costRow(id) { const d = (S.sku_costs || []).find(r => r.sku_id === id); return d || (st.auth ? null : (ls.get(LS.sku, {})[id] || null)); }
  const localEdits = () => Object.keys(ls.get(LS.rates, {})).length + Object.keys(ls.get(LS.sku, {})).length + ls.get(LS.lines, []).length;
  function ctx(r) {
    const sku = new Map(), row = new Map();
    for (const s of S.skus) { sku.set(s.sku_id, Q.skuCost(s, costRow(s.sku_id))); row.set(s.sku_id, s); }
    return { R: r || R(), bags: bags(), sku, skuRow: row, vol: s => unitVol(s).v, customLines: lines() };
  }
  const distOf = o => { const l = ls.get(LS.dist, {}); return o.distance_km != null ? o.distance_km : l[o.order_id]; };
  const withDist = o => Object.assign({}, o, { distance_km: distOf(o) });

  // ---------- loading ----------
  async function loadOpt() {
    for (const t of OPT) { try { S[t] = await fetchAll(t); } catch (e) { S[t] = []; } }
    try { const { data } = await sb.auth.getSession(); st.auth = !!(data && data.session); st.email = st.auth ? data.session.user.email : ""; } catch (e) { st.auth = false; }
    WHO = st.email || WHO;
  }
  async function signIn(email, pw) {
    st.err = "";
    const { error } = await sb.auth.signInWithPassword({ email, password: pw });
    if (error) { st.err = error.message; renderCosts(); return; }
    await loadAll(true); render();
  }
  async function signOut() { await sb.auth.signOut(); st.auth = false; st.email = ""; await loadAll(true); render(); }

  // ---------- stock value and expiry (uses the page's own reorder analysis) ----------
  function stockRows() {
    const an = analyse(), c = ctx();
    return an.rows.map(r => {
      const k = c.sku.get(r.sku.sku_id), u = unitVol(r.sku).v, on = Math.max(0, r.onHand);
      const bs = batches(r.sku.sku_id); let ex;
      if (bs.length) {          // simulate selling oldest-expiry-first at today's rate; what cannot sell before its own expiry is at risk
        let consumed = 0, atRisk = 0;
        for (const b of bs) { const cap = Math.max(0, (b.exp - NOW) / DAY * r.avg - consumed), sold = Math.min(b.qty, cap); atRisk += b.qty - sold; consumed += sold; }
        ex = { atRiskUnits: atRisk, atRiskValue: atRisk * k.cost, daysCover: r.avg > 0 ? on / r.avg : Infinity };
      } else ex = Q.expiryRisk(on, r.avg, k.shelf, k.cost);
      return { r, k, on, value: on * k.cost, litres: on * u / 1000, avg: r.avg, ex, sku: r.sku };
    });
  }

  // ---------- P&L ----------
  function compute(win) {
    const c = ctx(), since = NOW - win * DAY, rs = c.R;
    const ords = S.sales_orders.filter(o => o.status === "dispatched" && o.dispatched_at && ms(o.dispatched_at) >= since)
      .map(o => ({ order: withDist(o), lines: I.linesByOrder.get(o.order_id) || [] }));
    const wo = (S.write_offs || []).filter(w => ms(w.written_at) >= since);
    const woCost = wo.reduce((t, w) => t + w.qty * (+w.unit_cost_inr), 0);
    let shrink = 0; const cc = (S.cycle_counts || []).filter(x => ms(x.counted_at) >= since);
    for (const x of cc) { const k = c.sku.get(x.sku_id); shrink += Math.max(0, x.system_qty - x.counted_qty) * (k ? k.cost : 0); }   // only shortages are loss
    // returns: the customer is refunded the item; restocked (sellable) units give their cost back; damaged/expired units stay a loss
    let refunds = 0, cogsReturned = 0; const rets = (S.customer_returns || []).filter(r => ms(r.received_at) >= since);
    for (const r of rets) { const k = c.sku.get(r.sku_id); if (!k) continue; const ln = (I.linesByOrder.get(r.order_id) || []).find(l => l.sku_id === r.sku_id);
      const price = ln && ln.unit_price_inr != null ? +ln.unit_price_inr : k.price; refunds += r.qty * price / (1 + k.gst / 100); if (r.condition === "sellable") cogsReturned += r.qty * k.cost; }
    const sr = stockRows(), inv = sr.reduce((t, x) => t + x.value, 0);
    const P = Q.periodPnL({ orders: ords, days: win, R: rs, ctx: c, customLines: lines(), invValueCost: inv, writeOffCost: woCost, shrinkCost: shrink, refunds, cogsReturned });
    return { P, c, sr, inv, wo, cc, woCost, shrink, rets };
  }

  function renderPnl() {
    if (!S.skus.length) { $("#pnlBanner").innerHTML = `<div class="msg warn"><span class="ic">!</span><span>No data yet. Connect to the store database.</span></div>`; return; }
    const { P, c, sr, inv, wo, rets } = compute(st.win), n = P.n, rs = c.R;
    const k = (l, v, d, sv) => `<div class="kpi ${sv || ""}"><span class="l">${l}</span><span class="v">${v}</span><span class="d">${d}</span></div>`;
    const pc = n ? P.contribution / n : 0, sp = n ? P.storeProfit / n : 0;
    const be = P.breakevenOrdersPerDay;
    const perDay = n / st.win;
    const meas = P.measuredShare;
    const assumedKm = P.rows.filter(r => r.kmSrc === "assumed").length;
    $("#pnlKpis").innerHTML =
      k("Orders / day", perDay.toFixed(1), `${n} dispatched in ${st.win} days`)
      + k("Contribution / order", inr1(pc), "revenue minus every cost that moves with an order", pc < 0 ? "sev-bad" : "sev-good")
      + k("Store profit", inr(P.storeProfit), `${inr1(sp)} per order after fixed costs and inventory carrying`, P.storeProfit < 0 ? "sev-bad" : "sev-good")
      + k("Break-even", be == null ? "never" : be.toFixed(0) + " orders/day", be == null ? "contribution per order is negative: more orders lose more money" : `needed to cover ₹${fmtN((P.fixed + P.carrying) / st.win)}/day fixed + carrying`, be == null ? "sev-bad" : be > perDay ? "sev-warn" : "sev-good");
    const share = x => P.revenue ? (x / P.revenue * 100).toFixed(1) + "%" : "—";
    const allCostAssumed = S.skus.every(s => c.sku.get(s.sku_id).costSrc === "assumed"), anyCostEntered = S.skus.some(s => c.sku.get(s.sku_id).costSrc === "entered");
    const cogsSrc = allCostAssumed ? "assumed" : anyCostEntered ? "entered" : "assumed";
    const riderSrc = assumedKm > n / 2 ? "assumed" : "research";
    const line = (label, amt, src, opt) => {
      opt = opt || {}; const cls = opt.total ? ' style="font-weight:700;background:var(--surface-2)"' : "";
      return `<tr${cls}><td>${opt.indent ? "&nbsp;&nbsp;&nbsp;" : ""}${label}</td><td class="n">${opt.neg ? inr(-amt) : inr(amt)}</td><td class="n">${n ? inr1((opt.neg ? -amt : amt) / n) : "—"}</td><td class="n">${opt.noPct ? "" : share(amt)}</td><td>${src ? srcPill(src) : ""}</td></tr>`;
    };
    let rows = "";
    rows += `<tr class="muted"><td>Memo: sales at MRP (incl. GST)</td><td class="n">${inr(P.gross)}</td><td class="n">${n ? inr1(P.gross / n) : "—"}</td><td></td><td>${srcPill("ledger")}</td></tr>`;
    rows += `<tr class="muted"><td>Memo: discounts given vs MRP</td><td class="n">${inr(-P.promo)}</td><td class="n">${n ? inr1(-P.promo / n) : "—"}</td><td></td><td>${srcPill("entered")}</td></tr>`;
    rows += line("Revenue before refunds (net of GST, incl. delivery fee)", P.revenue + P.refunds, "ledger", { indent: 1 });
    rows += line(`Refunds on returns (${rets.length} returns)`, P.refunds, "ledger", { neg: true, indent: 1 });
    rows += line("Revenue", P.revenue, null, { total: true });
    rows += line("Cost of goods sold (net of restocked returns)", P.cogs, cogsSrc, { neg: true, indent: 1 });
    rows += line("Gross profit", P.gp, null, { total: true });
    rows += line("Rider pay", P.rider, riderSrc, { neg: true, indent: 1 });
    rows += line("Bags", P.bags, "research", { neg: true, indent: 1 });
    rows += line("Payment fees", P.pay, "assumed", { neg: true, indent: 1 });
    if (P.other) rows += line("Other per-order costs you added", P.other, "entered", { neg: true, indent: 1 });
    rows += line(`Damaged / expired write-offs (${wo.length} entries)`, P.writeOff, "ledger", { neg: true, indent: 1 });
    rows += line("Shrinkage found by counts (shortages only)", P.shrink, "ledger", { neg: true, indent: 1 });
    rows += line("Contribution", P.contribution, null, { total: true });
    for (const f of P.fixedLines) rows += line(esc(f.label), f.amt, f.src, { neg: true, indent: 1 });
    rows += line(`Inventory carrying (₹${fmtN(inv)} stock at cost × ${rs.cost_of_funds_pct + rs.insurance_pct}%/yr)`, P.carrying, "assumed", { neg: true, indent: 1 });
    rows += line("Store profit", P.storeProfit, null, { total: true });
    $("#pnlBanner").innerHTML = `<div class="msg ${meas != null && meas > 0.5 ? "info" : "warn"}"><span class="ic">${meas != null && meas > 0.5 ? "i" : "!"}</span><span>${meas == null ? "No dispatched orders in this window." : `About <b>${Math.round(meas * 100)}%</b> of the cost stack in this P&amp;L comes from your ledger or numbers you entered; the rest is research or placeholder. ${assumedKm ? `${assumedKm} of ${n} orders have no delivery distance, so rider pay uses the default ${rs.avg_distance_km} km. ` : ""}Open <a href="#costs">Costs</a> and replace the tagged numbers with invoices and payslips.`}</span></div>`;
    $("#pnlTable").innerHTML = rows;

    // basket bands
    const bands = [["Under ₹199", 0, 199], ["₹199 – ₹399", 199, 400], ["₹400 and above", 400, 1e9]];
    $("#pnlBands").innerHTML = bands.map(([l, a, b]) => {
      const rr = P.rows.filter(r => r.basket >= a && r.basket < b), m = rr.length;
      if (!m) return `<tr><td>${l}</td><td class="n">0</td><td colspan="4" class="muted">no orders</td></tr>`;
      const avg = f => rr.reduce((t, r) => t + f(r), 0) / m;
      return `<tr><td>${l}</td><td class="n">${m} <span class="small muted">(${(m / n * 100).toFixed(0)}%)</span></td><td class="n">${inr1(avg(r => r.basket))}</td><td class="n">${inr1(avg(r => r.revenue - r.cogs))}</td><td class="n"><b style="color:var(${avg(r => r.contribution) < 0 ? "--bad" : "--good"})">${inr1(avg(r => r.contribution))}</b></td><td class="n">${(rr.filter(r => r.contribution < 0).length / m * 100).toFixed(0)}%</td></tr>`;
    }).join("");

    // products
    const agg = new Map();
    for (const r of P.rows) for (const l of (I.linesByOrder.get(r.order_id) || [])) {
      const k = c.sku.get(l.sku_id); if (!k) continue;
      const a = agg.get(l.sku_id) || { u: 0, rev: 0, cogs: 0 }; a.u += l.qty; a.rev += k.price / (1 + k.gst / 100) * l.qty; a.cogs += k.cost * l.qty; agg.set(l.sku_id, a);
    }
    const prod = sr.map(x => { const a = agg.get(x.sku.sku_id) || { u: 0, rev: 0, cogs: 0 }, gp = a.rev - a.cogs;
      return { x, a, gp, gpu: a.u ? gp / a.u : x.k.price / (1 + x.k.gst / 100) - x.k.cost, gpl: x.litres > 0 ? gp / x.litres / st.win : null }; })
      .sort((a, b) => b.gp - a.gp);
    $("#pnlProd").innerHTML = prod.map(p => `<tr><td><b>${esc(p.x.sku.name)}</b></td><td>${esc(p.x.sku.category)}</td><td class="n">${p.a.u}</td><td class="n">${inr(p.gp)}</td><td class="n">${inr1(p.gpu)}</td><td class="n">${p.a.rev ? (p.gp / p.a.rev * 100).toFixed(0) + "%" : "—"}</td><td class="n">${p.x.k.discount > 0.005 ? (p.x.k.discount * 100).toFixed(0) + "%" : ""}</td><td class="n">${p.gpl == null ? "—" : "₹" + p.gpl.toFixed(2)}</td></tr>`).join("");

    // inventory & expiry
    const exRows = sr.filter(x => x.ex.atRiskUnits > 0.5 && x.avg >= 0).sort((a, b) => b.ex.atRiskValue - a.ex.atRiskValue);
    const exTot = exRows.reduce((t, x) => t + x.ex.atRiskValue, 0);
    const monthlyCarry = inv * (rs.cost_of_funds_pct + rs.insurance_pct) / 100 / 12;
    $("#pnlInv").innerHTML = `<div class="kpis" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:12px">`
      + k("Stock at cost", inr(inv), `${fmtN(sr.reduce((t, x) => t + x.on, 0))} units on book`)
      + k("Carrying cost / month", inr(monthlyCarry), `capital ${rs.cost_of_funds_pct}% + insurance ${rs.insurance_pct}% a year. Storage is already in rent.`)
      + k("Stock that will expire unsold", inr(exTot), `${exRows.length} SKUs hold more than they can sell before expiry`, exTot ? "sev-warn" : "sev-good")
      + k("Written off in this window", inr(P.writeOff), `${wo.length} entries; shrinkage ${inr(P.shrink)}`, P.writeOff ? "sev-warn" : "") + `</div>`;
    $("#pnlExp").innerHTML = exRows.slice(0, 15).map(x => `<tr><td><b>${esc(x.sku.name)}</b></td><td class="n">${x.on}</td><td class="n">${x.avg.toFixed(1)}</td><td class="n">${x.k.shelf} d ${x.k.shelfSrc === "assumed" ? '<span class="pill warn">assumed</span>' : ""}</td><td class="n">${isFinite(x.ex.daysCover) ? x.ex.daysCover.toFixed(1) : "no sales"}</td><td class="n">${Math.round(x.ex.atRiskUnits)}</td><td class="n">${inr(x.ex.atRiskValue)}</td></tr>`).join("")
      || `<tr><td colspan="7" class="muted">Nothing at risk at the current sales rate.</td></tr>`;
    $("#pnlWo").innerHTML = (S.write_offs || []).slice().sort((a, b) => ms(b.written_at) - ms(a.written_at)).slice(0, 15).map(w => { const s = I.sku.get(w.sku_id);
      return `<tr><td class="small muted">${dt(ms(w.written_at))}</td><td>${esc(s ? s.name : w.sku_id)}</td><td><span class="pill ${w.reason === "expired" ? "warn" : "bad"}">${w.reason}</span></td><td class="n">${w.qty}</td><td class="n">${inr(w.qty * w.unit_cost_inr)}</td></tr>`; }).join("")
      || `<tr><td colspan="5" class="muted">No damaged or expired stock recorded yet. Use the form on the Inventory tab.</td></tr>`;
  }

  // ---------- Costs tab ----------
  const GROUPS = [
    ["Delivery fee charged to the customer", ["fee_threshold", "fee_amount", "fee_gst_pct"]],
    ["Rider pay", ["rider_base", "rider_free_km", "rider_per_km", "road_factor", "avg_distance_km", "wh_lat", "wh_lng"]],
    ["Payment and bags", ["payment_pct", "bag_fill"]],
    ["Fixed costs per month", ["staff_count", "staff_salary", "rent", "power", "manager", "security", "internet"]],
    ["Inventory carrying", ["cost_of_funds_pct", "insurance_pct"]],
  ];
  function renderCosts() {
    const host = $("#costsBody");
    const r = R(), meta = Q.DEFAULT_RATES, saveTo = st.auth ? "the database" : "this browser only";
    let h = "";
    h += `<div class="panel"><h3>Sign in to save to the database</h3>${st.auth
      ? `<p class="small">Signed in as <b>${esc(st.email)}</b>. Changes below are saved to the database. <button class="ghost" id="soBtn">Sign out</button></p>
         ${localEdits() ? `<div class="msg warn" style="margin-top:8px"><span class="ic">!</span><span>${localEdits()} edits made while signed out are still in this browser and are ignored now. <button class="ghost" id="upLocal">Upload them to the database</button> <button class="ghost" id="dropLocal">Discard them</button></span></div>` : ""}`
      : `<p class="small muted" style="margin:6px 0 10px">Without signing in, edits are kept in this browser only and damage/count records cannot be written to the ledger. Costs are staff-only: they are not exposed by the public link.</p>
         <div class="row" style="gap:8px;align-items:flex-end"><label class="f">Email<input type="email" id="siEmail" autocomplete="username"></label><label class="f">Password<input type="password" id="siPw" autocomplete="current-password"></label><button class="primary" id="siBtn">Sign in</button></div>
         ${st.err ? `<p class="small" style="color:var(--bad);margin-top:6px">${esc(st.err)}</p>` : ""}`}</div>`;
    h += `<div class="panel"><h3>Rate card <span class="small muted">saved to ${saveTo}</span></h3><p class="small muted" style="margin:4px 0 10px">The tag beside each number says where it came from. Change a number and it becomes <b>entered</b>.</p>`;
    for (const [g, keys] of GROUPS) {
      h += `<h4 style="margin:14px 0 6px;font-size:.85rem;color:var(--ink-2)">${g}</h4><div class="rategrid">`;
      for (const k of keys) h += `<label class="f">${esc(meta[k].label)} ${srcPill(r.src[k])}<input type="number" step="any" data-rate="${k}" value="${r[k]}"></label>`;
      h += `</div>`;
    }
    h += `<p class="small muted" style="margin-top:12px">Rider pay for a trip = base + (km − free km) × per-km. Reported ranges: base ₹15 to ₹35 per order, ₹9 to ₹12 per extra km, with incentives on top. Use your own rate card.</p>`;
    h += `<table id="riderPrev" style="max-width:420px;margin-top:6px"><thead><tr><th>Trip distance</th>${[1, 2, 3, 5, 8].map(d => `<th class="n">${d} km</th>`).join("")}</tr></thead><tbody><tr><td>Rider pay</td>${[1, 2, 3, 5, 8].map(d => `<td class="n">${inr1(Q.riderPay(d, r))}</td>`).join("")}</tr></tbody></table></div>`;

    // extra costs
    const ln = lines();
    h += `<div class="panel"><h3>Add any cost</h3><p class="small muted" style="margin:4px 0 10px">Each line is charged by its basis: per month, per day, per trip (order), per order (inside contribution), or as a % of sales (inside contribution).</p>
      <div class="tw"><table><thead><tr><th>Cost</th><th class="n">Amount</th><th>Charged</th><th></th></tr></thead><tbody>${ln.map((l, i) => `<tr><td>${esc(l.label)}</td><td class="n">${l.basis === "pct_sales" ? l.amount + "%" : inr(l.amount)}</td><td>${esc(BASIS[l.basis] || l.basis)}</td><td><button class="ghost" data-delline="${l.id ?? i}">Remove</button></td></tr>`).join("") || `<tr><td colspan="4" class="muted">Nothing added yet.</td></tr>`}</tbody></table></div>
      <div class="row" style="gap:8px;align-items:flex-end;margin-top:10px"><label class="f">Name<input type="text" id="clLabel" placeholder="Tape, stickers, pest control…"></label><label class="f">Amount<input type="number" step="any" id="clAmt" style="width:110px"></label>
      <label class="f">Charged<select id="clBasis">${Object.entries(BASIS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label><button class="primary" id="clAdd">Add</button></div></div>`;

    // bags
    h += `<div class="panel"><h3>Bags</h3><p class="small muted" style="margin:4px 0 10px">Bought in bulk. Each order gets the smallest bag its items fit into (${Math.round(r.bag_fill * 100)}% of the bag counts as usable). Listings found: kraft ~₹8–9, non-woven ₹5–14 a piece.</p>
      <div class="tw"><table><thead><tr><th>Size</th><th class="n">Volume (L)</th><th class="n">Price per bag (₹)</th></tr></thead><tbody>${bags().map(b => `<tr><td>${esc(b.name)}</td><td class="n">${(b.cm3 / 1000).toFixed(1)}</td><td class="n"><input type="number" step="any" data-bag="${esc(b.id)}" value="${b.price}" style="width:90px"></td></tr>`).join("")}</tbody></table></div></div>`;

    // sku sheet
    h += `<div class="panel"><h3>Product costs, discounts and shelf life <span class="small muted">saved to ${saveTo}</span></h3><p class="small muted" style="margin:4px 0 10px">Barcode must be the EAN printed on the real pack, or the scan screen will refuse it. Unit cost is your average landed cost per unit, excluding GST. Until you enter it, the app uses MRP minus an assumed trade margin and tags it <b>assumed</b>. Discount % sets the selling price to MRP × (1 − d)${st.auth ? ", and updates the shop price" : ""}.</p>
      <div class="tw"><table><thead><tr><th>Product</th><th>Barcode (EAN)</th><th class="n">MRP</th><th class="n">Unit cost</th><th class="n">GST %</th><th class="n">Shelf life (d)</th><th class="n">Discount %</th><th class="n">Sells at</th><th class="n">Margin</th></tr></thead><tbody>
      ${S.skus.map(s => { const row = costRow(s.sku_id), k = Q.skuCost(s, row), net = k.price / (1 + k.gst / 100);
        return `<tr data-skurow="${esc(s.sku_id)}"><td><b>${esc(s.name)}</b></td><td><input type="text" inputmode="numeric" data-f="barcode" value="${esc(s.barcode)}" style="width:130px"></td><td class="n">₹${k.mrp}</td>
        <td class="n"><input type="number" step="any" data-f="unit_cost_inr" value="${k.cost}" style="width:80px"> ${k.costSrc === "assumed" ? '<span class="pill warn">assumed</span>' : ""}</td>
        <td class="n"><input type="number" step="any" data-f="gst_pct" value="${k.gst}" style="width:60px"></td>
        <td class="n"><input type="number" step="1" data-f="shelf_life_days" value="${k.shelf}" style="width:70px"> ${k.shelfSrc === "assumed" ? '<span class="pill warn">assumed</span>' : ""}</td>
        <td class="n"><input type="number" step="any" data-f="discount_pct" value="${row && row.discount_pct != null ? row.discount_pct : ""}" placeholder="${(k.discount * 100).toFixed(0)}" style="width:70px"></td>
        <td class="n sp">₹${k.price}</td><td class="n mg">${net > 0 ? ((net - k.cost) / net * 100).toFixed(0) + "%" : "—"}</td></tr>`; }).join("")}
      </tbody></table></div></div>`;
    host.innerHTML = h;
  }
  const BASIS = { month: "per month", day: "per day", trip: "per trip", order: "per order (variable)", pct_sales: "% of sales (variable)" };

  // ---------- saving ----------
  function refreshRider() { const t = $("#riderPrev"); if (!t) return; const r = R(); t.querySelector("tbody").innerHTML = `<tr><td>Rider pay</td>${[1, 2, 3, 5, 8].map(d => `<td class="n">${inr1(Q.riderPay(d, r))}</td>`).join("")}</tr>`; }
  function refreshRow(id) {
    const tr = document.querySelector(`[data-skurow="${CSS.escape(id)}"]`), s = I.sku.get(id); if (!tr || !s) return;
    const k = Q.skuCost(s, costRow(id)), net = k.price / (1 + k.gst / 100);
    tr.querySelector(".sp").textContent = "₹" + k.price; tr.querySelector(".mg").textContent = net > 0 ? ((net - k.cost) / net * 100).toFixed(0) + "%" : "—";
  }
  async function saveRate(key, val) {
    const v = +val; if (!isFinite(v)) return;
    if (st.auth) { const { error } = await sb.from("cost_rates").upsert({ key, value: v, updated_at: new Date().toISOString() }); if (error) { alert2("Could not save: " + error.message); return; }
      S.cost_rates = (S.cost_rates || []).filter(r => r.key !== key).concat([{ key, value: v }]); }
    else { const m = ls.get(LS.rates, {}); m[key] = v; ls.set(LS.rates, m); }
    refreshRider();
  }
  async function saveSku(id, field, raw) {
    const s = I.sku.get(id);
    if (field === "barcode") {
      if (!st.auth) { popup("Sign in first. Barcodes are saved to the product list, which only staff can change."); renderCosts(); return; }
      const code = String(raw).trim().replace(/\s+/g, ""); if (!/^\d{8,14}$/.test(code)) { popup("A barcode is 8 to 14 digits, as printed under the bars on the pack."); renderCosts(); return; }
      const { error } = await sb.from("skus").update({ barcode: code }).eq("sku_id", id);
      if (error) { popup("Could not save the barcode: " + error.message + (/duplicate|unique/i.test(error.message) ? " Another product already uses this barcode." : "")); renderCosts(); return; }
      s.barcode = code; reindex(); return;
    }
    const cur = costRow(id), k = Q.skuCost(s, cur);
    const row = { sku_id: id, unit_cost_inr: cur && cur.unit_cost_inr != null ? +cur.unit_cost_inr : k.cost, gst_pct: k.gst, shelf_life_days: k.shelf, discount_pct: cur ? cur.discount_pct : null, cost_src: "entered" };
    row[field] = raw === "" ? (field === "discount_pct" ? null : row[field]) : +raw;
    if (field === "unit_cost_inr") row.cost_src = "entered";
    if (st.auth) {
      const { error } = await sb.from("sku_costs").upsert(Object.assign({}, row, { updated_at: new Date().toISOString() })); if (error) { alert2("Could not save: " + error.message); return; }
      if (field === "discount_pct") { const price = row.discount_pct == null ? s.mrp_inr : Math.round(s.mrp_inr * (1 - row.discount_pct / 100)); const e2 = await sb.from("skus").update({ price_inr: price }).eq("sku_id", id); if (e2.error) alert2("Cost saved, but the shop price could not change: " + e2.error.message); else s.price_inr = price; }
      S.sku_costs = (S.sku_costs || []).filter(r => r.sku_id !== id).concat([row]);
    } else { const m = ls.get(LS.sku, {}); m[id] = row; ls.set(LS.sku, m); }
    refreshRow(id);
  }
  async function uploadLocal() {
    const rates = ls.get(LS.rates, {}), skus = ls.get(LS.sku, {}), lns = ls.get(LS.lines, []);
    try {
      const rr = Object.keys(rates).map(key => ({ key, value: +rates[key] })); if (rr.length) { const r = await sb.from("cost_rates").upsert(rr); if (r.error) throw r.error; }
      const sr = Object.values(skus); if (sr.length) { const r = await sb.from("sku_costs").upsert(sr); if (r.error) throw r.error; }
      if (lns.length) { const r = await sb.from("cost_lines").insert(lns.map(l => ({ label: l.label, amount: l.amount, basis: l.basis }))); if (r.error) throw r.error; }
    } catch (e) { popup("Could not upload: " + e.message); return; }
    for (const k of [LS.rates, LS.sku, LS.lines]) { try { localStorage.removeItem(k); } catch (e) { } }
    await loadAll(); render();
  }
  function dropLocal() { for (const k of [LS.rates, LS.sku, LS.lines]) { try { localStorage.removeItem(k); } catch (e) { } } renderCosts(); }
  async function addLine() {
    const label = $("#clLabel").value.trim(), amount = +$("#clAmt").value, basis = $("#clBasis").value; if (!label || !isFinite(amount)) return;
    if (st.auth) { const { error } = await sb.from("cost_lines").insert({ label, amount, basis }); if (error) { alert2(error.message); return; } await loadAll(); }
    else { const l = ls.get(LS.lines, []); l.push({ id: Date.now(), label, amount, basis, active: true }); ls.set(LS.lines, l); }
    render();
  }
  async function delLine(id) {
    if (st.auth && (S.cost_lines || []).some(l => String(l.id) === String(id))) { const { error } = await sb.from("cost_lines").delete().eq("id", id); if (error) { alert2(error.message); return; } await loadAll(); }
    else { ls.set(LS.lines, ls.get(LS.lines, []).filter((l, i) => String(l.id ?? i) !== String(id))); }
    render();
  }
  async function saveBag(id, price) {
    if (st.auth) { const { error } = await sb.from("bag_types").update({ price: +price }).eq("id", id); if (error) { alert2(error.message); return; } const b = (S.bag_types || []).find(x => x.id === id); if (b) b.price = +price; }
    else { const b = bags().map(x => x.id === id ? Object.assign({}, x, { price: +price }) : x); ls.set(LS.bags, b); }
  }
  async function saveDist(orderId, raw) {
    const km = raw === "" ? null : +raw;
    if (st.auth) { const { error } = await sb.from("sales_orders").update({ distance_km: km }).eq("order_id", orderId); if (!error) { await loadAll(); render(); return; } }
    const m = ls.get(LS.dist, {}); if (km == null) delete m[orderId]; else m[orderId] = km; ls.set(LS.dist, m);
    if (I.order.get(orderId)) I.order.get(orderId).distance_km = null;
    render();
  }

  // ---------- inventory forms: damaged / expired, and counts ----------
  function invForms() {
    const host = $("#invForms"); if (!host) return;
    if (host.dataset.built && host.contains(document.activeElement)) return;          // don't wipe a form while typing
    const skuOpts = S.skus.slice().sort((a, b) => a.name.localeCompare(b.name)).map(s => `<option value="${esc(s.sku_id)}">${esc(s.name)}</option>`).join("");
    const keep = {}; host.querySelectorAll("[id]").forEach(e => keep[e.id] = e.value);
    host.innerHTML = `<div class="grid2">
      <div class="panel"><h3>Record damaged or expired stock</h3><p class="small muted" style="margin:4px 0 8px">Takes the units off the shelf in the ledger and books the loss at cost in the P&amp;L.</p>
        <div class="row" style="gap:8px;align-items:flex-end"><label class="f">Product<select id="woSku">${skuOpts}</select></label><label class="f">Units<input type="number" id="woQty" min="1" step="1" style="width:80px"></label>
        <label class="f">Reason<select id="woWhy"><option value="damaged">Damaged</option><option value="expired">Expired</option><option value="other">Other</option></select></label><button class="primary" id="woBtn">Record</button></div>
        <div id="woMsg" class="small" style="margin-top:6px"></div></div>
      <div class="panel"><h3>Record a stock count</h3><p class="small muted" style="margin:4px 0 8px">Count the shelf, type what you counted. A shortfall against the ledger is booked as shrinkage at cost.</p>
        <div class="row" style="gap:8px;align-items:flex-end"><label class="f">Product<select id="ccSku">${skuOpts}</select></label><label class="f">Shelf<select id="ccLoc"></select></label><label class="f">Counted<input type="number" id="ccQty" min="0" step="1" style="width:80px"></label><button class="primary" id="ccBtn">Save count</button></div>
        <div id="ccMsg" class="small" style="margin-top:6px"></div></div></div>
      ${st.auth ? "" : `<p class="small muted">These forms write to the ledger, so they need staff sign-in (Costs tab).</p>`}`;
    for (const id in keep) { const e = host.querySelector("#" + id); if (e && e.tagName !== "BUTTON") e.value = keep[id]; }
    host.dataset.built = "1"; fillLocs();
  }
  function fillLocs() {
    const sel = $("#ccLoc"), sku = $("#ccSku"); if (!sel || !sku) return;
    const arr = (I.stockBySku.get(sku.value) || []).slice().sort((a, b) => b.qty - a.qty);
    sel.innerHTML = arr.map(x => `<option value="${esc(x.location_code)}">${esc(x.location_code)} (ledger ${x.qty})</option>`).join("") || `<option value="">no shelf holds this product</option>`;
  }
  const say = (id, kind, t) => { const e = $(id); if (e) e.innerHTML = t ? `<span style="color:var(--${kind === "ok" ? "good" : "bad"})">${esc(t)}</span>` : ""; };
  async function recordWriteOff() {
    const sku = $("#woSku").value, qty = Math.floor(+$("#woQty").value), why = $("#woWhy").value;
    if (!st.auth) return say("#woMsg", "err", "Sign in on the Costs tab first.");
    if (!(qty > 0)) return say("#woMsg", "err", "Enter how many units.");
    const arr = (I.stockBySku.get(sku) || []).filter(x => x.qty > 0).sort((a, b) => b.qty - a.qty);
    if (!arr.length) return say("#woMsg", "err", "No shelf holds this product in the ledger.");
    // take from the shelf with most stock first; spill over if the damaged units sit in several places
    let left = qty; const taken = [];
    for (const a of arr) { if (left <= 0) break; const t = Math.min(a.qty, left); taken.push([a.location_code, t]); left -= t; }
    if (left > 0) taken[0][1] += left;                                         // more than the ledger shows: this shelf goes negative, which the Scan failures tab will flag
    const cost = Q.skuCost(I.sku.get(sku), costRow(sku)).cost, who = st.email || "web";
    const ev = taken.map(([loc, q]) => ({ station: "OUT", scanner_id: "WEB", event_type: "DAMAGE", sku_id: sku, location_code: loc, qty: q, ref_type: null, ref_id: why, operator: who }));
    let r = await sb.from("scan_events").insert(ev); if (r.error) return say("#woMsg", "err", r.error.message);
    r = await sb.from("write_offs").insert({ sku_id: sku, qty, reason: why, location_code: taken[0][0], unit_cost_inr: cost, operator: who });
    if (r.error) return say("#woMsg", "err", "Shelf updated but the write-off row failed: " + r.error.message);
    $("#woQty").value = ""; await loadAll(); render(); say("#woMsg", "ok", `Recorded ${qty} × ${I.sku.get(sku).name} as ${why}: ${inr(qty * cost)} at cost.`);
  }
  async function recordCount() {
    const sku = $("#ccSku").value, loc = $("#ccLoc").value, counted = Math.floor(+$("#ccQty").value);
    if (!st.auth) return say("#ccMsg", "err", "Sign in on the Costs tab first.");
    if (!loc || $("#ccQty").value === "" || !(counted >= 0)) return say("#ccMsg", "err", "Pick a shelf and type the counted quantity.");
    const sys = (I.stock.get(sku + "|" + loc) || { qty: 0 }).qty, diff = counted - sys, who = st.email || "web";
    let r = await sb.from("cycle_counts").insert({ location_code: loc, sku_id: sku, counted_qty: counted, system_qty: sys, operator: who });
    if (r.error) return say("#ccMsg", "err", r.error.message);
    if (diff !== 0) { r = await sb.from("scan_events").insert({ station: diff > 0 ? "IN" : "OUT", scanner_id: "WEB", event_type: "COUNT_ADJ", sku_id: sku, location_code: loc, qty: Math.abs(diff), ref_type: "COUNT", ref_id: "CNT-" + Date.now(), operator: who }); if (r.error) return say("#ccMsg", "err", "Count saved but the ledger adjustment failed: " + r.error.message); }
    $("#ccQty").value = ""; await loadAll(); render();
    const cost = Q.skuCost(I.sku.get(sku), costRow(sku)).cost;
    say("#ccMsg", "ok", diff === 0 ? "Count matches the ledger." : diff < 0 ? `Short by ${-diff}: ${inr(-diff * cost)} of shrinkage.` : `Found ${diff} more than the ledger: the ledger is corrected. That means an IN scan was missed.`);
  }

  // ---------- order card: distance and rider pay ----------
  function orderLine(o) {
    const c = ctx(), e = Q.orderEconomics(withDist(o), I.linesByOrder.get(o.order_id) || [], c);
    return `<div class="row small" style="align-items:center;gap:8px;flex-wrap:wrap"><label>Distance <input type="number" step="0.1" min="0" class="dkm" data-dist="${esc(o.order_id)}" value="${o.distance_km ?? distOf(o) ?? ""}" placeholder="${c.R.avg_distance_km}" style="width:64px"> km</label>
      <span class="muted">rider ${inr1(e.rider)} · bag ${inr1(e.bagCost)} · contribution <b style="color:var(${e.contribution < 0 ? "--bad" : "--good"})">${inr1(e.contribution)}</b>${e.kmSrc === "assumed" ? " (default distance)" : ""}</span></div>`;
  }

  // ---------- batches: first-expiry-first-out ----------
  // Remaining units per purchase-order line, oldest expiry first. Expiry is po_lines.expiry_date if you entered it,
  // else received date + shelf life (flagged estimated). Units already sold or written off are taken from the earliest batches.
  let bc = { key: null, out: null };
  function outBySku() {
    if (bc.key !== I.order) { const m = new Map(); for (const l of S.order_lines) if (I.order.get(l.order_id)?.status === "dispatched") m.set(l.sku_id, (m.get(l.sku_id) || 0) + l.qty);
      for (const w of (S.write_offs || [])) m.set(w.sku_id, (m.get(w.sku_id) || 0) + w.qty); bc = { key: I.order, out: m }; }
    return bc.out;
  }
  function batches(sku_id) {
    const s = I.sku.get(sku_id); if (!s) return []; const shelf = Q.skuCost(s, costRow(sku_id)).shelf;
    const bs = S.po_lines.filter(l => l.sku_id === sku_id && l.qty_received > 0 && I.po.get(l.po_id) && I.po.get(l.po_id).received_at).map(l => {
      const recv = ms(I.po.get(l.po_id).received_at), real = !!l.expiry_date;
      return { po: l.po_id, qty: l.qty_received, exp: real ? Date.parse(l.expiry_date) : recv + shelf * DAY, real };
    }).sort((a, b) => a.exp - b.exp);
    let out = outBySku().get(sku_id) || 0;
    for (const b of bs) { const t = Math.min(b.qty, out); b.qty -= t; out -= t; }
    return bs.filter(b => b.qty > 0);
  }
  function nextExpiry(sku_id) {
    const b = batches(sku_id)[0]; if (!b) return null;
    const d = new Date(b.exp).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
    return b.exp < NOW ? d + (b.real ? "" : " (est.)") + " — ALREADY EXPIRED, do not ship; write it off" : d + (b.real ? "" : " (est.)");
  }
  async function recordPick(ref) {
    const [order, sku, qty, loc] = ref.split("|");
    if (!st.auth) { alert2("Sign in on the Costs tab to record a pick scan from the web. Scanner apps write these automatically."); return; }
    const { error } = await sb.from("scan_events").insert({ station: "OUT", scanner_id: "WEB", event_type: "PICK", sku_id: sku, location_code: loc, qty: +qty, ref_type: "ORDER", ref_id: order, operator: st.email || "web" });
    if (error) { alert2(error.message); return; } await loadAll(); render();
  }

  // ---------- pop-up message ----------
  function popup(msg, kind) {
    let ov = document.getElementById("msgOv"); if (ov) ov.remove();
    ov = document.createElement("div"); ov.id = "msgOv"; ov.className = "ovl";
    ov.innerHTML = `<div class="ovbox" role="alertdialog" aria-live="assertive"><p style="font-size:1.05rem;font-weight:600;color:var(--${kind === "ok" ? "good" : "bad"})">${kind === "ok" ? "Done" : "Stop"}</p><p style="margin:8px 0 16px">${esc(msg)}</p><button class="primary" id="msgOk">OK</button></div>`;
    document.body.appendChild(ov); const b = ov.querySelector("#msgOk"); b.focus(); b.onclick = () => ov.remove();
  }
  function beep(ok) { try { const A = new (window.AudioContext || window.webkitAudioContext)(), o = A.createOscillator(), g = A.createGain(); o.frequency.value = ok ? 880 : 200; o.connect(g); g.connect(A.destination); g.gain.value = 0.15; o.start(); o.stop(A.currentTime + (ok ? 0.12 : 0.45)); } catch (e) { } }

  // ---------- scan station: scan or type each barcode, in pick order; a wrong product is refused ----------
  const SC = { id: null, flash: null, rejects: 0, busy: false, shelf: null, shelfSku: null };
  function todo(id) {
    return (I.linesByOrder.get(id) || []).map(l => {
      const s = I.sku.get(l.sku_id), st = (I.stockBySku.get(l.sku_id) || []).filter(r => r.qty > 0), loc = st[0] ? st[0].location_code : null;
      return { l, s, loc, walk: loc ? I.loc.get(loc).walk_m : 999, sc: I.byRef.get("PICK|" + id + "|" + l.sku_id) || 0, cold: !!(s && s.temp_class !== "ambient") };
    }).sort((a, b) => (a.cold - b.cold) || (a.walk - b.walk));
  }
  function openScan(id) {
    SC.id = id; SC.flash = null; SC.rejects = 0; SC.busy = false; SC.shelf = null; SC.shelfSku = null;
    let ov = document.getElementById("scanOv"); if (ov) ov.remove();
    ov = document.createElement("div"); ov.id = "scanOv"; ov.className = "ovl"; document.body.appendChild(ov); drawScan();
  }
  function closeScan() { const ov = document.getElementById("scanOv"); if (ov) ov.remove(); SC.id = null; loadAll().then(render).catch(() => render()); }
  function drawScan() {
    const ov = document.getElementById("scanOv"); if (!ov) return;
    const L = todo(SC.id), total = L.reduce((t, x) => t + x.l.qty, 0), done = L.reduce((t, x) => t + Math.min(x.sc, x.l.qty), 0), exp = L.find(x => x.sc < x.l.qty);
    const f = SC.flash;
    let body = "";
    if (!st.auth) {
      body = `<p class="small" style="margin:10px 0">Scans are written to the stock ledger, so staff must sign in first.</p>
        <div class="row" style="gap:8px;align-items:flex-end"><label class="f">Email<input type="email" id="scEmail" autocomplete="username"></label><label class="f">Password<input type="password" id="scPw" autocomplete="current-password"></label><button class="primary" id="scSign">Sign in</button></div>
        ${st.err ? `<p class="small" style="color:var(--bad)">${esc(st.err)}</p>` : ""}`;
    } else if (!exp) {
      body = `<div class="msg ok" style="margin:12px 0"><span class="ic">✓</span><span>All ${total} items scanned. Close this and press Hand to rider.</span></div>`;
    } else {
      const needShelf = !SC.shelf || SC.shelfSku !== exp.s.sku_id;
      body = `<div class="panel" style="margin:12px 0;border-left:4px solid var(--accent)"><span class="small muted">SCAN THIS NEXT · ${needShelf ? "STEP 1: THE SHELF LABEL" : "STEP 2: THE PRODUCT"}</span>
          <div style="font-size:1.25rem;font-weight:700;margin:4px 0">${esc(exp.s.name)}</div>
          <div class="row" style="gap:10px;align-items:center">${exp.loc ? locChip(exp.loc) : '<span class="pill bad">no shelf</span>'} <span class="small muted">barcode ${esc(exp.s.barcode)}</span> <span class="pill neutral">${exp.sc + 1} of ${exp.l.qty}</span></div></div>
        <div class="row" style="gap:8px"><input type="text" id="scIn" autocomplete="off" placeholder="${needShelf ? "Scan the shelf label, or type its code" : "Scan the product barcode, or type it"} and press Enter" style="flex:1;font-size:1.1rem;padding:10px"><button class="primary" id="scGo">Enter</button></div>`;
    }
    const flash = f ? `<div class="msg ${f.ok ? "ok" : "err"}" style="margin-top:10px;font-size:1.05rem"><span class="ic">${f.ok ? "✓" : "✕"}</span><span><b>${esc(f.text)}</b></span></div>` : "";
    ov.innerHTML = `<div class="ovbox" style="max-width:560px;width:100%;text-align:left">
      <div class="row" style="justify-content:space-between;align-items:center"><h3>Scan order ${esc(SC.id)}</h3><span class="pill ${done === total ? "good" : "warn"}">${done} / ${total} scanned</span></div>
      ${body}${flash}${SC.rejects ? `<p class="small" style="color:var(--bad);margin-top:6px">${SC.rejects} wrong scan${SC.rejects > 1 ? "s" : ""} refused this session</p>` : ""}
      <div class="tw" style="margin-top:12px"><table><tbody>${L.map(x => `<tr><td>${x.sc >= x.l.qty ? "✓" : exp && x === exp ? "▶" : ""}</td><td>${esc(x.s ? x.s.name : x.l.sku_id)}</td><td class="n">${Math.min(x.sc, x.l.qty)}/${x.l.qty}</td></tr>`).join("")}</tbody></table></div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" id="scClose">Close</button></div></div>`;
    ov.querySelector("#scClose").onclick = closeScan;
    const si = ov.querySelector("#scSign"); if (si) si.onclick = async () => { const { error } = await sb.auth.signInWithPassword({ email: ov.querySelector("#scEmail").value.trim(), password: ov.querySelector("#scPw").value }); if (error) { st.err = error.message; } else { st.err = ""; await loadAll(); } drawScan(); };
    const inp = ov.querySelector("#scIn");
    if (inp) { inp.focus(); inp.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); submitScan(); } }; inp.onblur = () => setTimeout(() => { const o = document.getElementById("scanOv"), i = o && o.querySelector("#scIn"); if (i && !o.contains(document.activeElement)) i.focus(); }, 50); ov.querySelector("#scGo").onclick = submitScan; }
  }
  async function submitScan() {
    if (SC.busy) return; const inp = document.querySelector("#scIn"); if (!inp) return;
    const code = inp.value.trim().replace(/\s+/g, ""); inp.value = ""; if (!code) return;
    const L = todo(SC.id), exp = L.find(x => x.sc < x.l.qty); if (!exp) return;
    const needShelf = !SC.shelf || SC.shelfSku !== exp.s.sku_id;
    if (needShelf) {            // step 1: the shelf must be one that the ledger says holds this product
      const up = code.toUpperCase(), shelfRow = I.loc.get(up);
      const refuse = text => { SC.rejects++; beep(false); SC.flash = { ok: false, text }; drawScan(); };
      if (!shelfRow) return refuse(I.ean.get(code) ? "Scan the SHELF label first, then the product." : `${code} is not a shelf label. Scan the label on the shelf${exp.loc ? " " + exp.loc : ""}.`);
      const have = (I.stock.get(exp.s.sku_id + "|" + up) || { qty: 0 }).qty;
      if (have <= 0) return refuse(`${up} holds no ${exp.s.name} in the ledger.${exp.loc ? " Go to " + exp.loc + "." : ""} If the stock really is on this shelf, count it on the Inventory tab so the ledger is corrected.`);
      SC.shelf = up; SC.shelfSku = exp.s.sku_id; beep(true); SC.flash = { ok: true, text: `Shelf ${up} is right. Now scan the product.` }; return drawScan();
    }
    if (String(exp.s.barcode) !== code) {
      const other = I.ean.get(code); SC.rejects++; beep(false);
      SC.flash = { ok: false, text: other ? `Wrong product. That is ${other.name}. Scan ${exp.s.name} instead.` : `Barcode ${code} is not a known product. Scan ${exp.s.name}.` };
      return drawScan();
    }
    const loc = SC.shelf;
    SC.busy = true;
    const row = { station: "OUT", scanner_id: "WEB", event_type: "PICK", sku_id: exp.s.sku_id, location_code: loc, qty: 1, ref_type: "ORDER", ref_id: SC.id, operator: st.email || "web" };
    const { error } = await sb.from("scan_events").insert(row); SC.busy = false;
    if (error) { SC.flash = { ok: false, text: "Could not save the scan: " + error.message }; beep(false); return drawScan(); }
    S.scan_events.push(Object.assign({ scanned_at: new Date().toISOString() }, row)); reindex(); beep(true);
    const n = exp.sc + 1; SC.flash = { ok: true, text: `${exp.s.name} ${n}/${exp.l.qty} scanned` };
    if (((I.stock.get(exp.s.sku_id + "|" + loc) || { qty: 0 }).qty) <= 0) SC.shelf = null;      // shelf is empty in the ledger: next unit needs a new shelf scan
    drawScan();
  }

  // ---------- wiring ----------
  function init() {
    document.addEventListener("click", e => {
      if (e.target.closest("#siBtn")) return signIn($("#siEmail").value.trim(), $("#siPw").value);
      if (e.target.closest("#soBtn")) return signOut();
      if (e.target.closest("#upLocal")) return uploadLocal();
      if (e.target.closest("#dropLocal")) return dropLocal();
      if (e.target.closest("#clAdd")) return addLine();
      const d = e.target.closest("[data-delline]"); if (d) return delLine(d.dataset.delline);
      const sc = e.target.closest("[data-scan]"); if (sc) return openScan(sc.dataset.scan);
      if (e.target.closest("#woBtn")) return recordWriteOff();
      if (e.target.closest("#ccBtn")) return recordCount();
    });
    document.addEventListener("change", e => {
      const t = e.target;
      if (t.matches("[data-rate]")) return saveRate(t.dataset.rate, t.value);
      if (t.matches("[data-bag]")) return saveBag(t.dataset.bag, t.value);
      if (t.matches("[data-skurow] input")) return saveSku(t.closest("[data-skurow]").dataset.skurow, t.dataset.f, t.value);
      if (t.matches(".dkm")) return saveDist(t.dataset.dist, t.value);
      if (t.id === "ccSku") fillLocs();
    });
    const w = $("#pnlWin"); if (w) w.onchange = () => { st.win = +w.value; renderPnl(); };
  }
  return { popup, openScan, costRow, batches, nextExpiry, init, loadOpt, renderPnl, renderCosts, invForms, orderLine, st, compute, ctx };
})();
