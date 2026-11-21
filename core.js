// Shared by the warehouse (index.html) and the shop (shop.html).
// Demo data generator, stock maths, and the demo link between shop and warehouse (same-origin localStorage).
(function(g){
"use strict";
const HOUR=3600e3, DAY=24*HOUR;
const ms = v => typeof v === "number" ? v : Date.parse(v);
function mulberry(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function ean13(b){ let s=0; for(let i=0;i<12;i++) s+=(+b[i])*(i%2?3:1); return b+((10-s%10)%10); }

function buildDemo(NOW, cfg){
  cfg = cfg || {inId:"IN-01", outId:"OUT-01"};
  const R = mulberry(20261121), pick = a => a[Math.floor(R()*a.length)], rint=(a,b)=>a+Math.floor(R()*(b-a+1));
  // name, category, temp, kg, cm3, popularity
  const cat = [
    ["Amul Taaza Toned Milk 500 ml","Dairy","cold",0.52,560,10,28,28,"500 ml","pouch"],["Amul Butter 100 g","Dairy","cold",0.1,140,4,60,58,"100 g","bar"],
    ["Mother Dairy Curd 400 g","Dairy","cold",0.42,480,5,50,47,"400 g","tub"],["Amul Cheese Slices 200 g","Dairy","cold",0.2,260,2,155,145,"10 slices","box"],
    ["Farm Eggs, 6 pack","Dairy","cold",0.36,900,6,60,54,"6 pcs","tray"],["McCain French Fries 420 g","Frozen","frozen",0.42,1600,1.5,130,115,"420 g","bag"],
    ["Kwality Wall's Cornetto","Frozen","frozen",0.11,350,2.5,40,40,"1 cone","cone"],["Britannia Bread 400 g","Bakery","ambient",0.4,2600,8,50,48,"400 g","loaf"],
    ["Maggi 2-Minute Noodles 70 g","Instant food","ambient",0.07,260,9,15,14,"70 g","packet"],["Parle-G Biscuits 250 g","Biscuits","ambient",0.25,420,6,25,25,"250 g","packet"],
    ["Britannia Good Day 200 g","Biscuits","ambient",0.2,380,3,40,36,"200 g","packet"],["Sunfeast Dark Fantasy 75 g","Biscuits","ambient",0.08,220,2,40,38,"75 g","box"],
    ["Lay's Classic Salted 52 g","Snacks","ambient",0.05,1400,7,20,20,"52 g","bag"],["Kurkure Masala Munch 90 g","Snacks","ambient",0.09,1500,5,20,20,"90 g","bag"],
    ["Haldiram's Aloo Bhujia 400 g","Snacks","ambient",0.4,1300,2.5,115,105,"400 g","bag"],["Coca-Cola 750 ml","Beverages","ambient",0.8,900,5,40,38,"750 ml","bottle"],
    ["Thums Up 750 ml","Beverages","ambient",0.8,900,4,40,38,"750 ml","bottle"],["Real Mixed Fruit Juice 1 L","Beverages","ambient",1.05,1100,2,130,117,"1 L","carton"],
    ["Tata Tea Gold 500 g","Staples","ambient",0.5,1200,2.5,330,299,"500 g","box"],["Nescafé Classic 50 g","Staples","ambient",0.12,240,2,180,170,"50 g","jar"],
    ["Tata Salt 1 kg","Staples","ambient",1.0,900,3,28,28,"1 kg","pouch"],["Fortune Sunflower Oil 1 L","Staples","ambient",0.95,1150,3,165,149,"1 L","bottle"],
    ["Aashirvaad Atta 5 kg","Staples","ambient",5.1,7200,3.5,285,259,"5 kg","sack"],["Daawat Basmati Rice 5 kg","Staples","ambient",5.05,6800,1.2,699,599,"5 kg","sack"],
    ["Sugar 5 kg","Staples","ambient",5.0,6000,1.5,260,239,"5 kg","sack"],["Bisleri Water 5 L","Beverages","ambient",5.2,6200,2,85,80,"5 L","bottle"],
    ["Kissan Tomato Ketchup 950 g","Staples","ambient",1.0,1050,1.2,145,129,"950 g","bottle"],["Surf Excel Easy Wash 1 kg","Home care","ambient",1.0,1700,1.5,135,125,"1 kg","pouch"],
    ["Vim Dishwash Bar 300 g","Home care","ambient",0.3,380,2,30,30,"300 g","bar"],["Harpic Toilet Cleaner 1 L","Home care","ambient",1.1,1300,1,210,189,"1 L","bottle"],
    ["Colgate Strong Teeth 200 g","Personal care","ambient",0.22,420,2,115,105,"200 g","tube"],["Dettol Soap 125 g, 4 pack","Personal care","ambient",0.5,700,1.5,190,169,"4 × 125 g","box"],
    ["Dove Shampoo 180 ml","Personal care","ambient",0.2,300,0.8,235,209,"180 ml","bottle"],["Lifebuoy Handwash 185 ml","Personal care","ambient",0.2,320,0.8,99,89,"185 ml","bottle"],
    ["Whisper Ultra XL 15 pads","Personal care","ambient",0.3,1800,1,199,185,"15 pads","packet"],["Pampers Pants M, 20","Baby","ambient",0.9,5400,0.7,399,359,"20 pcs","bag"],
  ];
  const skus = cat.map((c,i)=>({ sku_id:"SKU"+String(1001+i), barcode: ean13("890"+String(1063000000+i*7919).slice(0,9)),
    name:c[0], category:c[1], temp_class:c[2], mrp_inr:c[6], price_inr:c[7], pack:c[8], art:c[9], image_url:null, unit_weight_kg:c[3], unit_volume_cm3: (i%6===4 ? null : c[4]), case_qty:1, _pop:Math.pow(c[5],2) }));

  // Locations: A fast (aisles 1-2), B medium (3-4), C slow (5-6), H heavy floor (7), K cold (8), F frozen (9)
  const locations=[];
  const addZone=(zone,aisles,bays,shelves,slots,base,temp,cap,maxkg)=>{
    for(const a of aisles) for(let b=1;b<=bays;b++) for(const sh of shelves) for(let s=1;s<=slots;s++){
      locations.push({ code:`${zone}-${String(a).padStart(2,"0")}-${b}-${sh}-${String(s).padStart(2,"0")}`, zone, aisle:a, bay:b, shelf:sh, slot:s,
        temp_class:temp, capacity_cm3:cap, max_weight_kg:maxkg,
        walk_m: +(base + (a - aisles[0])*4 + b*2.2 + s*0.4).toFixed(1), is_reserve:false, is_active:true });
    }};
  addZone("K",[8],2,["A","B","C"],3,2,"cold",50000,40);
  addZone("F",[9],1,["A","B"],3,4,"frozen",40000,40);
  addZone("A",[1,2],3,["A","B","C","D"],3,4,"ambient",50000,40);
  addZone("H",[7],3,["A"],4,7,"ambient",300000,250);
  addZone("B",[3,4],3,["A","B","C","D"],3,13,"ambient",50000,40);
  addZone("C",[5,6],3,["A","B","C","D"],3,22,"ambient",50000,40);

  const heavy = s => s.unit_weight_kg>=4;
  const eligible = s => locations.filter(l => l.temp_class===s.temp_class && (heavy(s) ? l.zone==="H" : l.zone!=="H"));
  // Deliberately messy starting layout (homes picked at random) so the 80/20 placement check has real cases.
  const used=new Set(), home={};
  for(const s of skus){ const opts=eligible(s).filter(l=>!used.has(l.code)); const l=pick(opts); used.add(l.code); home[s.sku_id]=l.code; }
  const altLoc = s => { const opts=eligible(s).filter(l=>l.code!==home[s.sku_id]); return pick(opts).code; };

  const P = { purchase_orders:[], po_lines:[], sales_orders:[], order_lines:[], customer_returns:[], scan_events:[] };
  let sid=1;
  const scan=(station,type,sku,loc,qty,refType,refId,op,t)=>{ if(t>NOW) return; P.scan_events.push({ id:sid++, station, scanner_id: station==="IN"?cfg.inId:cfg.outId,
    event_type:type, sku_id:sku, location_code:loc, qty, ref_type:refType, ref_id:refId, operator:op, scanned_at:new Date(t).toISOString() }); };
  const totalPop = skus.reduce((a,s)=>a+s._pop,0);
  const dayDemand = s => 175*s._pop/totalPop;        // ≈ units/day
  const phys = new Map();                                       // physical truth by sku|loc
  const addPhys=(sku,loc,q)=>{ const k=sku+"|"+loc; phys.set(k,(phys.get(k)||0)+q); };

  const inOps=[{n:"Ravi",miss:.015},{n:"Priya",miss:.01},{n:"Imran",miss:.10}];
  const outOps=[{n:"Asha",miss:.006,eve:0},{n:"Karan",miss:.015,eve:.11},{n:"Meera",miss:.01,eve:.02}];
  const midnight = new Date(); midnight.setHours(0,0,0,0);
  const start = midnight.getTime() - 28*DAY;

  // Opening stock, 15 days before start, fully scanned
  const t0 = start - 2*DAY;
  P.purchase_orders.push({po_id:"PO-OPEN", supplier:"Opening stock", ordered_at:new Date(t0-DAY).toISOString(), received_at:new Date(t0).toISOString(), receiver:"Ravi"});
  for(const s of skus){ const q=Math.ceil(dayDemand(s)*4)+6; P.po_lines.push({po_id:"PO-OPEN", sku_id:s.sku_id, qty_ordered:q, qty_received:q});
    addPhys(s.sku_id,home[s.sku_id],q); scan("IN","PUTAWAY",s.sku_id,home[s.sku_id],q,"PO","PO-OPEN","Ravi",t0+HOUR); }

  const hourW=[0,0,0,0,0,0,0,2,4,5,4,4,5,5,4,4,5,6,8,10,11,9,6,3];
  const sumW=hourW.reduce((a,b)=>a+b,0);
  const sampleHour=()=>{ let r=R()*sumW; for(let h=0;h<24;h++){ r-=hourW[h]; if(r<=0) return h; } return 21; };
  const popPick=()=>{ let r=R()*totalPop; for(const s of skus){ r-=s._pop; if(r<=0) return s; } return skus[0]; };
  let oid=50001, rid=1;

  let soldPrev={}, soldToday={};
  for(let d=0; d<29; d++){
    soldPrev=soldToday; soldToday={};
    const ds = start + d*DAY; if(ds>NOW) break;
    // Morning PO: replenish every SKU with ~1 day of demand
    const poId = "PO-"+new Date(ds).toISOString().slice(2,10).replace(/-/g,"");
    const recv = ds + 7.5*HOUR; const rop = inOps[d%3];
    if(recv < NOW){
      P.purchase_orders.push({po_id:poId, supplier:pick(["HUL Distributor","Amul Depot","ITC Stockist","Metro Cash & Carry"]), ordered_at:new Date(ds-DAY).toISOString(), received_at:new Date(recv).toISOString(), receiver:rop.n});
      for(const s of skus){
        const ord=Math.max(2, d===0 ? Math.round(dayDemand(s)) : (soldPrev[s.sku_id]||0));   // "sell one, buy one": reorder yesterday's sales
        const rec = R()<.06 ? Math.max(0,ord-rint(1,3)) : ord;           // supplier short-ship (not a scan failure)
        P.po_lines.push({po_id:poId, sku_id:s.sku_id, qty_ordered:ord, qty_received:rec});
        if(!rec) continue;
        const wrong = R()<.03; const loc = wrong ? altLoc(s) : home[s.sku_id];
        addPhys(s.sku_id,loc,rec);
        const t = recv + (20+R()*100)*60e3;
        if(R()<rop.miss){ if(R()<.4 && rec>1) scan("IN","PUTAWAY",s.sku_id,loc,rec-rint(1,Math.min(3,rec-1)),"PO",poId,rop.n,t); }
        else if(R()<.004) { scan("IN","PUTAWAY",s.sku_id,loc,rec,"PO",poId,rop.n,t); scan("IN","PUTAWAY",s.sku_id,loc,rec,"PO",poId,rop.n,t+4000); } // double scan
        else scan("IN","PUTAWAY",s.sku_id,loc,rec,"PO",poId,rop.n,t);
      }
    }
    // Orders
    const n = 95 + Math.floor(R()*35);
    const ordersToday=[];
    for(let k=0;k<n;k++){
      const h=sampleHour(); const placed = ds + h*HOUR + R()*HOUR; if(placed>NOW) continue;
      ordersToday.push(placed);
    }
    ordersToday.sort((a,b)=>a-b);
    for(const placed of ordersToday){
      const h = new Date(placed).getHours();
      const op = h<15 ? outOps[0] : (R()<.5 ? outOps[1] : outOps[2]);
      const id = "ORD-"+(oid++);
      const live = placed > NOW - 25*60e3;
      const disp = placed + (8+R()*9)*60e3;
      const status = live ? "picking" : "dispatched";
      P.sales_orders.push({order_id:id, placed_at:new Date(placed).toISOString(), dispatched_at: status==="dispatched"?new Date(Math.min(disp,NOW-60e3)).toISOString():null, status, picker:op.n});
      const nl = 1+Math.floor(R()*R()*4.2); const chosen=new Set();
      for(let j=0;j<nl;j++){ const s=popPick(); if(chosen.has(s.sku_id)) continue; chosen.add(s.sku_id);
        const q = s.category==="Dairy" ? rint(1,3) : (R()<.8?1:2);
        P.order_lines.push({order_id:id, sku_id:s.sku_id, qty:q}); soldToday[s.sku_id]=(soldToday[s.sku_id]||0)+q;
        if(live) continue;
        // physically pick from wherever it really is (home first)
        let loc=home[s.sku_id];
        if((phys.get(s.sku_id+"|"+loc)||0) < q){ for(const [k,v] of phys){ const [sk,lc]=k.split("|"); if(sk===s.sku_id && v>=q){ loc=lc; break; } } }
        addPhys(s.sku_id,loc,-q);
        const missP = op.miss + (h>=18 && h<=21 ? op.eve : 0);
        if(R()>=missP) scan("OUT","PICK",s.sku_id,loc,q,"ORDER",id,op.n,placed+(2+R()*5)*60e3);
        // returns
        if(R()<.028){
          const rt = disp + (3+R()*20)*HOUR; if(rt>NOW) continue;
          const cond = R()<.8 ? "sellable" : (R()<.5?"damaged":"expired");
          const rop2 = pick(inOps); const retId="RET-"+String(rid++).padStart(4,"0");
          P.customer_returns.push({return_id:retId, order_id:id, sku_id:s.sku_id, qty:1, condition:cond, received_at:new Date(rt).toISOString(), received_by:rop2.n});
          if(cond==="sellable"){ addPhys(s.sku_id,home[s.sku_id],1);
            if(R()>=.12) scan("IN","RETURN_PUTAWAY",s.sku_id,home[s.sku_id],1,"RETURN",retId,rop2.n,rt+(10+R()*50)*60e3); }
        }
      }
    }
  }
  // A truck that just arrived: received 20 minutes ago, nothing put away yet (work for the IN station)
  const liveRecv = NOW - 20*60e3;
  P.purchase_orders.push({po_id:"PO-LIVE", supplier:"HUL Distributor", ordered_at:new Date(NOW-DAY).toISOString(), received_at:new Date(liveRecv).toISOString(), receiver:"Priya"});
  for(const s of skus.filter((_,i)=>i%5===2)) P.po_lines.push({po_id:"PO-LIVE", sku_id:s.sku_id, qty_ordered:12, qty_received:12});
  // Ordered this morning, not delivered yet (counts as "on order" in the reorder list)
  P.purchase_orders.push({po_id:"PO-NEXT", supplier:"Amul Depot", ordered_at:new Date(NOW-3*HOUR).toISOString(), received_at:null, receiver:"Ravi"});
  for(const s of skus.filter((_,i)=>i%7===1)) P.po_lines.push({po_id:"PO-NEXT", sku_id:s.sku_id, qty_ordered:Math.ceil(dayDemand(s)*2), qty_received:null});

  P.scan_events.sort((a,b)=>ms(a.scanned_at)-ms(b.scanned_at)); P.scan_events.forEach((e,i)=>e.id=i+1);
  return { skus: skus.map(({_pop,...s})=>s), locations, ...P, cycle_counts:[] };
}


const SHOP_KEY="shelfledger.shopOrders";
function loadShopOrders(){ try{ return JSON.parse(localStorage.getItem(SHOP_KEY)||"[]"); }catch(e){ return []; } }
function saveShopOrders(a){ try{ localStorage.setItem(SHOP_KEY, JSON.stringify(a)); }catch(e){} }
// Put shop orders (placed in this browser) into a warehouse dataset, or refresh their status.
function mergeShopOrders(S){
  const byId=new Map(S.sales_orders.map(o=>[o.order_id,o]));
  for(const o of loadShopOrders()){
    const ex=byId.get(o.order_id);
    if(ex){ ex.status=o.status; ex.dispatched_at=o.dispatched_at||null; continue; }
    S.sales_orders.push({order_id:o.order_id, placed_at:o.placed_at, dispatched_at:o.dispatched_at||null, status:o.status, picker:null,
      customer_name:o.customer?.name||null, customer_phone:o.customer?.phone||null, address:o.customer?.address||null, total_inr:o.total||null, source:"shop"});
    for(const it of o.items) S.order_lines.push({order_id:o.order_id, sku_id:it.sku_id, qty:it.qty});
  }
  return S;
}
// Units a customer can still buy = book stock − units on open (not yet dispatched) orders.
function availability(S){
  const book=new Map(S.skus.map(s=>[s.sku_id,0])), status=new Map(S.sales_orders.map(o=>[o.order_id,o.status]));
  for(const l of S.po_lines) if(l.qty_received!=null && book.has(l.sku_id)) book.set(l.sku_id, book.get(l.sku_id)+l.qty_received);
  for(const r of S.customer_returns) if(r.condition==="sellable" && book.has(r.sku_id)) book.set(r.sku_id, book.get(r.sku_id)+r.qty);
  for(const l of S.order_lines){ const st=status.get(l.order_id); if(!book.has(l.sku_id) || st==="cancelled") continue; book.set(l.sku_id, book.get(l.sku_id)-l.qty); }
  return book;   // dispatched AND open orders both reduce what is sellable
}
g.WMSCore={ buildDemo, loadShopOrders, saveShopOrders, mergeShopOrders, availability, SHOP_KEY };
})(window);
