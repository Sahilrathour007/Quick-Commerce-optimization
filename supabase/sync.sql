-- sync.sql: lets the warehouse site fetch only what changed, instead of every row every minute.
-- Run after schema.sql and costs.sql (Supabase -> SQL Editor -> paste -> Run). Safe to run more than once.
-- The site still works without it; it just falls back to reloading whole tables.

-- 1. A last-changed stamp on every table whose rows change after they are written.
--    The database sets it, so a wrong clock on a staff laptop cannot cause missed changes.
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['skus','locations','purchase_orders','po_lines','sales_orders','customer_returns']
  loop
    execute format('alter table %I add column if not exists updated_at timestamptz not null default now()', t);
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format('create trigger %I before insert or update on %I for each row execute function touch_updated_at()', t || '_touch', t);
    execute format('create index if not exists %I on %I (updated_at)', t || '_updated_idx', t);
  end loop;
end $$;

-- Order lines are never edited, only added: a created stamp is enough.
alter table order_lines add column if not exists created_at timestamptz not null default now();
create index if not exists order_lines_created_idx on order_lines (created_at);

-- 2. Old scans, already totalled: one row per product per shelf for everything scanned before p_before.
--    The site loads this plus the raw scans after p_before, so stock stays exact while the download stays small.
--    security invoker: it shows only what the caller is already allowed to read.
create or replace function scan_balance_before(p_before timestamptz)
returns table (sku_id text, location_code text, qty bigint, last_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select se.sku_id, se.location_code,
         sum(case when se.station = 'IN' then se.qty else -se.qty end) as qty,
         max(se.scanned_at) as last_at
  from scan_events se
  where se.scanned_at < p_before
  group by se.sku_id, se.location_code
  having sum(case when se.station = 'IN' then se.qty else -se.qty end) <> 0
$$;
grant execute on function scan_balance_before(timestamptz) to anon, authenticated;
