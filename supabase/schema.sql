-- =====================================================================
-- Dark-store WMS — Supabase schema
-- Run in Supabase: Dashboard → SQL Editor → paste → Run.
-- Ledger model: stock is NEVER stored as a number you overwrite.
-- Every unit that moves is a row in scan_events. Stock = SUM of the ledger.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Master data ----------------------------------------------
create table if not exists skus (
  sku_id        text primary key,                 -- your internal code
  barcode       text unique not null,             -- EAN-13 printed on the pack
  name          text not null,
  category      text,
  temp_class    text not null default 'ambient'
                check (temp_class in ('ambient','cold','frozen')),
  unit_weight_kg numeric(8,3) not null default 0.1,
  unit_volume_cm3 numeric(10,1),                 -- NULL = estimate from weight ÷ category density
  case_qty      int not null default 1,
  lead_time_days numeric(5,1),
  price_inr     numeric(10,2),                   -- selling price in the shop (NULL = not sold online)
  mrp_inr       numeric(10,2),
  pack          text,                            -- e.g. '500 ml', '6 pcs'
  art           text,                            -- illustration style when there is no photo
  image_url     text,                            -- your own product photo (e.g. Supabase Storage)                   -- NULL = use the app's default lead time
  created_at    timestamptz default now()
);

-- Address format: ZONE-AISLE-BAY-SHELF-SLOT, e.g. A-03-2-B-04
-- The shelf label barcode encodes exactly this code.
create table if not exists locations (
  code          text primary key,
  zone          text not null,           -- A fast, B medium, C slow, H heavy, K cold, R reserve
  aisle         int, bay int, shelf text, slot int,
  temp_class    text not null default 'ambient'
                check (temp_class in ('ambient','cold','frozen')),
  capacity_cm3  numeric(12,1) not null,
  max_weight_kg numeric(8,2) not null default 40,
  walk_m        numeric(6,1) not null,   -- walking distance from pack/dispatch point
  is_reserve    boolean default false,
  is_active     boolean default true
);

-- ---------- Inbound (what you ORDERED and what the dock COUNTED) ------
create table if not exists purchase_orders (
  po_id        text primary key,
  supplier     text,
  ordered_at   timestamptz default now(),
  received_at  timestamptz,                     -- set when GRN is done
  receiver     text                             -- who owns putaway for this PO (attribution for missed scans)
);
create table if not exists po_lines (
  po_id        text references purchase_orders(po_id) on delete cascade,
  sku_id       text references skus(sku_id),
  qty_ordered  int not null,
  qty_received int,                             -- counted at the dock (GRN). NULL = not received yet
  primary key (po_id, sku_id)
);

-- ---------- Outbound (from your order system / OMS) -------------------
create table if not exists sales_orders (
  order_id      text primary key,
  placed_at     timestamptz default now(),
  dispatched_at timestamptz,                     -- set by OMS when the rider leaves
  status        text default 'placed'
                check (status in ('placed','picking','packed','dispatched','cancelled')),
  picker        text,                            -- who was assigned the pick (attribution for missed scans)
  source        text default 'oms',              -- 'shop' for orders from the website
  customer_name text,
  customer_phone text,
  address       text,
  total_inr     numeric(10,2)
);
create table if not exists order_lines (
  order_id  text references sales_orders(order_id) on delete cascade,
  sku_id    text references skus(sku_id),
  qty       int not null,
  primary key (order_id, sku_id)
);

create table if not exists customer_returns (
  return_id   text primary key default gen_random_uuid()::text,
  order_id    text references sales_orders(order_id),
  sku_id      text references skus(sku_id),
  qty         int not null,
  condition   text default 'sellable' check (condition in ('sellable','damaged','expired')),
  received_at timestamptz default now(),
  received_by text
);

-- ---------- The ledger: every scan from both scanners ----------------
-- station IN  = putaway / return putaway / move-in   (qty adds to location)
-- station OUT = pick / move-out / damage write-off   (qty leaves location)
create table if not exists scan_events (
  id           bigint generated always as identity primary key,
  station      text not null check (station in ('IN','OUT')),
  scanner_id   text not null,                    -- e.g. IN-01, OUT-01 (one device per station)
  event_type   text not null check (event_type in
               ('PUTAWAY','RETURN_PUTAWAY','MOVE_IN','PICK','MOVE_OUT','DAMAGE','COUNT_ADJ')),
  sku_id       text not null references skus(sku_id),
  location_code text not null references locations(code),
  qty          int not null check (qty > 0),
  ref_type     text check (ref_type in ('PO','ORDER','RETURN','MOVE','COUNT')),
  ref_id       text,                             -- po_id / order_id / return_id
  operator     text not null,
  scanned_at   timestamptz not null default now()
);
create index if not exists scan_events_ref_idx on scan_events (ref_type, ref_id, sku_id);
create index if not exists scan_events_loc_idx on scan_events (location_code, sku_id);
create index if not exists scan_events_time_idx on scan_events (scanned_at);

-- Physical truth. Detectors 1 and 2 are inference; a count is evidence.
create table if not exists cycle_counts (
  id            bigint generated always as identity primary key,
  location_code text references locations(code),
  sku_id        text references skus(sku_id),
  counted_qty   int not null,
  system_qty    int not null,                    -- what the ledger said at count time
  operator      text,
  counted_at    timestamptz default now()
);

-- =====================================================================
-- VIEWS
-- =====================================================================

-- Where every SKU is, right now, according to scans.
create or replace view location_stock as
select se.sku_id, se.location_code,
       sum(case when se.station = 'IN' then se.qty else -se.qty end)::int as qty,
       max(se.scanned_at) as last_scan_at
from scan_events se
group by se.sku_id, se.location_code
having sum(case when se.station = 'IN' then se.qty else -se.qty end) <> 0;
-- NOTE: a NEGATIVE qty here is itself a scan failure signal:
-- stock left a location that was never scanned in.

-- DETECTOR 1 — inbound: dock counted X, shelves got Y scanned.
create or replace view inbound_scan_gap as
select pl.po_id, pl.sku_id, po.received_at,
       pl.qty_ordered, pl.qty_received,
       coalesce(s.scanned, 0)                          as qty_putaway_scanned,
       pl.qty_received - coalesce(s.scanned, 0)        as missed_in_units,
       pl.qty_ordered  - coalesce(pl.qty_received, 0)  as supplier_short_units,
       po.receiver as assigned_to,
       (po.received_at < now() - interval '4 hours') as past_putaway_sla,  -- inside 4h = still pending, not missed
       s.operators
from po_lines pl
join purchase_orders po using (po_id)
left join (
  select ref_id, sku_id, sum(qty) as scanned, string_agg(distinct operator, ', ') as operators
  from scan_events where event_type = 'PUTAWAY' and ref_type = 'PO'
  group by ref_id, sku_id
) s on s.ref_id = pl.po_id and s.sku_id = pl.sku_id
where pl.qty_received is not null;

-- DETECTOR 2 — outbound: OMS says dispatched X, locations dropped by Y.
create or replace view outbound_scan_gap as
select ol.order_id, ol.sku_id, so.dispatched_at,
       ol.qty                                   as qty_dispatched,
       coalesce(s.scanned, 0)                   as qty_pick_scanned,
       ol.qty - coalesce(s.scanned, 0)          as missed_out_units,
       so.picker as assigned_to,
       s.operators
from order_lines ol
join sales_orders so using (order_id)
left join (
  select ref_id, sku_id, sum(qty) as scanned, string_agg(distinct operator, ', ') as operators
  from scan_events where event_type = 'PICK' and ref_type = 'ORDER'
  group by ref_id, sku_id
) s on s.ref_id = ol.order_id and s.sku_id = ol.sku_id
where so.status = 'dispatched';

-- SKU-level reconciliation: book stock (documents) vs scanned stock (shelves).
create or replace view sku_reconciliation as
with book as (
  select sku_id, sum(qty) as q from (
    select sku_id, qty_received as qty from po_lines where qty_received is not null
    union all
    select sku_id, qty from customer_returns where condition = 'sellable'
    union all
    select ol.sku_id, -ol.qty from order_lines ol join sales_orders so using (order_id)
     where so.status = 'dispatched'
  ) x group by sku_id
), shelf as (
  select sku_id, sum(qty) as q from location_stock group by sku_id
)
select s.sku_id, s.name,
       coalesce(b.q,0)::int as book_qty,
       coalesce(sh.q,0)::int as scanned_qty,
       (coalesce(sh.q,0) - coalesce(b.q,0))::int as gap   -- + = missed OUT scans, - = missed IN scans (or shrinkage)
from skus s
left join book b using (sku_id)
left join shelf sh using (sku_id);

-- =====================================================================
-- ROW LEVEL SECURITY
-- Demo policy: any signed-in user (authenticated) can read & write.
-- Do NOT leave anon write access on in production.
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['skus','locations','purchase_orders','po_lines','sales_orders',
    'order_lines','customer_returns','scan_events','cycle_counts']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "auth_all" on %I', t);
    execute format('create policy "auth_all" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- Ledger rows are append-only: no one edits or deletes a scan. Corrections are new COUNT_ADJ rows.
drop policy if exists "auth_all" on scan_events;
drop policy if exists "scan_read" on scan_events;
drop policy if exists "scan_insert" on scan_events;
create policy "scan_read"   on scan_events for select to authenticated using (true);
create policy "scan_insert" on scan_events for insert to authenticated with check (true);

-- =====================================================================
-- SHOP: what customers can see and do (anon role, no login)
-- Customers never read tables directly. They read one view and call two functions.
-- =====================================================================

-- Sellable now = book stock − units on every order not cancelled (dispatched or still open).
create or replace view shop_catalog as
with q as (
  select sku_id, sum(qty) as q from (
    select sku_id, qty_received as qty from po_lines where qty_received is not null
    union all
    select sku_id, qty from customer_returns where condition = 'sellable'
    union all
    select ol.sku_id, -ol.qty from order_lines ol join sales_orders so using (order_id) where so.status <> 'cancelled'
  ) x group by sku_id
)
select s.sku_id, s.name, s.category, s.temp_class, s.pack, s.art, s.image_url,
       s.price_inr, s.mrp_inr, greatest(0, coalesce(q.q, 0))::int as available
from skus s left join q using (sku_id)
where s.price_inr is not null;

create sequence if not exists web_order_seq start 100001;

-- Places an order atomically. Prices come from the database, never from the browser.
create or replace function place_order(p_items jsonb, p_customer jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare v_id text; it jsonb; v_avail int; v_price numeric; v_total numeric := 0;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Your cart is empty'; end if;
  if coalesce(trim(p_customer->>'name'),'') = '' or coalesce(trim(p_customer->>'address'),'') = ''
     or coalesce(p_customer->>'phone','') !~ '^[6-9][0-9]{9}$' then
    raise exception 'Name, a 10-digit mobile number and an address are required';
  end if;
  perform pg_advisory_xact_lock(4242);            -- one checkout at a time, so two customers cannot buy the last unit
  for it in select * from jsonb_array_elements(p_items) loop
    select available, price_inr into v_avail, v_price from shop_catalog where sku_id = it->>'sku_id';
    if v_avail is null then raise exception 'A product in your cart is no longer sold'; end if;
    if (it->>'qty')::int < 1 or (it->>'qty')::int > v_avail then
      raise exception 'Only % left of %', greatest(v_avail,0), (select name from skus where sku_id = it->>'sku_id');
    end if;
    v_total := v_total + v_price * (it->>'qty')::int;
  end loop;
  v_id := 'WEB-' || nextval('web_order_seq');
  insert into sales_orders (order_id, status, source, customer_name, customer_phone, address, total_inr)
  values (v_id, 'placed', 'shop', trim(p_customer->>'name'), p_customer->>'phone', trim(p_customer->>'address'),
          v_total + case when v_total >= 199 then 0 else 25 end);
  insert into order_lines (order_id, sku_id, qty)
  select v_id, x->>'sku_id', (x->>'qty')::int from jsonb_array_elements(p_items) x;
  return v_id;
end $$;

-- Order tracking: status only, no customer details.
create or replace function order_status(p_ids text[])
returns table (order_id text, status text, placed_at timestamptz, dispatched_at timestamptz)
language sql security definer set search_path = public as $$
  select order_id, status, placed_at, dispatched_at from sales_orders where order_id = any(p_ids) and source = 'shop'
$$;

grant select on shop_catalog to anon, authenticated;
grant execute on function place_order(jsonb, jsonb) to anon, authenticated;
grant execute on function order_status(text[]) to anon, authenticated;
