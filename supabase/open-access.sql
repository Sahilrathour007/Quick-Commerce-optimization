-- open-access.sql: TEMPORARY. Lets the warehouse site work without sign-in.
--
-- WARNING: after you run this, ANYONE who has the website link can:
--   - read every table, including customers' names, phone numbers and addresses;
--   - change any order's status and any product's lead time.
-- They still cannot add, delete or edit anything else.
--
-- Run lock-down.sql before real customers order, or as soon as staff sign-in is back.
-- Supabase -> SQL Editor -> paste -> Run. Safe to run more than once.

do $$
declare t text;
begin
  foreach t in array array['skus','locations','purchase_orders','po_lines','sales_orders',
    'order_lines','customer_returns','scan_events','cycle_counts']
  loop
    execute format('drop policy if exists "open_read" on %I', t);
    execute format('create policy "open_read" on %I for select to anon using (true)', t);
    execute format('grant select on %I to anon', t);
  end loop;
end $$;

-- Order buttons (Start packing / Hand to rider): only status and dispatch time can change.
revoke update on sales_orders from anon;
grant update (status, dispatched_at) on sales_orders to anon;
drop policy if exists "open_update_status" on sales_orders;
create policy "open_update_status" on sales_orders for update to anon using (true) with check (true);

-- Lead time per product (Movers & reorder tab): only lead_time_days can change.
revoke update on skus from anon;
grant update (lead_time_days) on skus to anon;
drop policy if exists "open_update_lead" on skus;
create policy "open_update_lead" on skus for update to anon using (true) with check (true);
