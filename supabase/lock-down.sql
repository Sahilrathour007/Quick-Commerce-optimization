-- lock-down.sql: undoes open-access.sql. After this, only signed-in staff can see warehouse data.
-- The shop keeps working: customers use shop_catalog, place_order and order_status, which this does not touch.
-- Supabase -> SQL Editor -> paste -> Run. Safe to run more than once.

do $$
declare t text;
begin
  foreach t in array array['skus','locations','purchase_orders','po_lines','sales_orders',
    'order_lines','customer_returns','scan_events','cycle_counts']
  loop
    execute format('drop policy if exists "open_read" on %I', t);
  end loop;
end $$;

drop policy if exists "open_update_status" on sales_orders;
drop policy if exists "open_update_lead" on skus;
revoke update (status, dispatched_at) on sales_orders from anon;
revoke update (lead_time_days) on skus from anon;
