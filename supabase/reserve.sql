-- reserve.sql: real reserve (back-stock) shelves, so relocation moves have an address. Run after seed.sql. Safe to re-run.
-- Reserve sits at the back of the store (walk_m 45+), one SKU per slot. Capacity is generous on purpose.
insert into locations (code, zone, aisle, bay, shelf, slot, temp_class, capacity_cm3, max_weight_kg, walk_m, is_reserve, is_active)
select 'R-' || lpad(a::text, 2, '0') || '-1-' || sh || '-' || lpad(sl::text, 2, '0'), 'R', a, 1, sh, sl,
       case when a = 1 then 'ambient' when a = 2 then 'cold' else 'frozen' end,
       case when a = 1 then 120000 else 80000 end, case when a = 1 then 120 else 60 end, 45 + a * 2, true, true
from generate_series(1, 3) a, unnest(array['A','B']) sh, generate_series(1, 6) sl
on conflict (code) do nothing;
