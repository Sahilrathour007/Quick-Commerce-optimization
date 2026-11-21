-- costs.sql: cost data for the P&L. Run AFTER schema.sql and seed.sql. Safe to run more than once.
-- Supabase -> SQL Editor -> paste -> Run.
--
-- PRIVACY: these tables are readable/writable by SIGNED-IN staff only. They are NOT covered by
-- open-access.sql, so purchase costs and salaries are not exposed through the public link.
-- Sign in from the Costs tab to read or change them.
--
-- Every number seeded here is an ASSUMPTION unless you replace it with an invoice figure.

-- 1. Per-product cost sheet --------------------------------------------------
create table if not exists sku_costs (
  sku_id          text primary key references skus(sku_id) on delete cascade,
  unit_cost_inr   numeric(10,2) not null,       -- average landed cost per unit, ex-GST (hardcode from invoices)
  gst_pct         numeric(5,2)  not null default 12,
  shelf_life_days int           not null default 180,
  discount_pct    numeric(5,2),                 -- NULL = sell at skus.price_inr; else price = round(MRP x (1 - d))
  cost_src        text not null default 'assumed' check (cost_src in ('entered','assumed')),
  updated_at      timestamptz default now()
);

-- 2. Rate card: one row per setting (rider pay, payment %, rent ...) ----------
create table if not exists cost_rates (
  key        text primary key,
  value      numeric not null,
  updated_at timestamptz default now()
);

-- 3. Any extra cost you want to add. basis: month | day | trip | order | pct_sales
create table if not exists cost_lines (
  id         bigint generated always as identity primary key,
  label      text not null,
  amount     numeric not null,
  basis      text not null default 'month' check (basis in ('month','day','trip','order','pct_sales')),
  active     boolean not null default true,
  created_at timestamptz default now()
);

-- 4. Bags, bought in bulk, price by size -------------------------------------
create table if not exists bag_types (
  id    text primary key,
  name  text not null,
  cm3   numeric not null,
  price numeric not null
);

-- 5. Damaged / expired / other write-offs (valued at cost when written off) ---
create table if not exists write_offs (
  id            bigint generated always as identity primary key,
  sku_id        text not null references skus(sku_id),
  qty           int  not null check (qty > 0),
  reason        text not null check (reason in ('damaged','expired','other')),
  location_code text references locations(code),
  unit_cost_inr numeric(10,2) not null,
  operator      text,
  written_at    timestamptz not null default now()
);
create index if not exists write_offs_time_idx on write_offs (written_at);

-- 6. Where each order is going (for rider pay). Fill distance_km, or the coordinates.
alter table sales_orders add column if not exists dest_lat    numeric(9,6);
alter table sales_orders add column if not exists dest_lng    numeric(9,6);
alter table sales_orders add column if not exists distance_km numeric(6,2);

-- Expiry date per received purchase-order line (enter at goods receipt). Blank = estimated from shelf life.
alter table po_lines add column if not exists expiry_date date;

-- ---------- Seed -------------------------------------------------------------
-- Unit cost = MRP x (1 - category trade margin) / (1 + GST), i.e. ex-GST because input GST is claimed back. Margins are guesses from public kirana margin bands
-- (staples low/high single digit, packaged FMCG high single to mid teens, beverages low to high teens,
-- personal care low teens to 20). Dairy, frozen and baby had no source. REPLACE with invoice costs.
-- GST follows the 22 Sep 2025 rate cuts; confirm per product on the invoice.
insert into sku_costs (sku_id, unit_cost_inr, gst_pct, shelf_life_days)
select sku_id, round(coalesce(mrp, price) * (1 - margin) / (1 + gst / 100.0), 2), gst, shelf
from (
  select s.sku_id, s.mrp_inr as mrp, s.price_inr as price,
    case s.category
      when 'Dairy' then 0.07 when 'Frozen' then 0.15 when 'Bakery' then 0.12 when 'Instant food' then 0.11
      when 'Biscuits' then 0.12 when 'Snacks' then 0.14 when 'Beverages' then 0.13 when 'Staples' then 0.07
      when 'Home care' then 0.15 when 'Personal care' then 0.17 when 'Baby' then 0.10 else 0.12 end as margin,
    case s.category when 'Dairy' then 5 when 'Frozen' then 5 when 'Bakery' then 5 when 'Instant food' then 5
      when 'Biscuits' then 5 when 'Snacks' then 12 when 'Beverages' then 18 when 'Staples' then 5
      when 'Home care' then 18 when 'Personal care' then 18 when 'Baby' then 12 else 12 end as gst,
    case s.category when 'Dairy' then 5 when 'Frozen' then 180 when 'Bakery' then 4 when 'Instant food' then 240
      when 'Biscuits' then 180 when 'Snacks' then 120 when 'Beverages' then 180 when 'Staples' then 270
      when 'Home care' then 540 when 'Personal care' then 730 when 'Baby' then 730 else 180 end as shelf
  from skus s
) t
on conflict (sku_id) do nothing;

-- Egg tray and bread are shorter-lived than their category; milk is 2-3 days. Tune on the pack label.
update sku_costs set shelf_life_days = 21 where sku_id = 'SKU1005';
update sku_costs set shelf_life_days = 3  where sku_id = 'SKU1001';
update sku_costs set shelf_life_days = 30 where sku_id = 'SKU1003';

insert into cost_rates (key, value) values
  ('staff_count', 3), ('staff_salary', 15000)
on conflict (key) do nothing;

insert into bag_types (id, name, cm3, price) values
  ('S', 'Small 20x10x25 cm',  5000,  5),
  ('M', 'Medium 30x15x35 cm', 15750, 8),
  ('L', 'Large 40x20x45 cm',  36000, 12)
on conflict (id) do nothing;

-- ---------- Row-level security: signed-in staff only -------------------------
do $$
declare t text;
begin
  foreach t in array array['sku_costs','cost_rates','cost_lines','bag_types','write_offs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "auth_all" on %I', t);
    execute format('create policy "auth_all" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- Order distance can be edited by signed-in staff (the existing anon grant on sales_orders is unchanged).
