// Local fixtures only. The mock deliberately has no write/RPC implementation.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(import.meta.dirname, '..');
const fixtures = {
  products:[{ id:'p1', name:'Roteador de teste', code:'P1', tracking_mode:'serializado', category:'Equipamentos', stock:5, minimum_stock:1, unit_of_measure:'unidade', average_cost:10 }, { id:'p2', name:'Conector de teste', code:'P2', category:'Insumos', stock:10, minimum_stock:1, tracking_mode:'quantidade' }],
  profiles:[{ full_name:'Teste local', role:'admin' }],
  serial_items:Array.from({ length:6823 }, (_, i) => ({ id:'s'+i, product_id:'p1', mac_address:'TESTE'+i, status:i?'instalado_cliente':'disponivel', created_at:'2026-08-01T12:00:00Z' })),
  movements:Array.from({ length:6000 }, (_, i) => ({ id:`m${String(i).padStart(6,'0')}`, product_id:'p2', movement_type:i % 2 ? 'entrada' : 'saida', quantity:1, recipient:'Teste', holder_type:'outro', created_at:new Date(1780000000000+i*1000).toISOString(), stock_impact:i%2?1:-1 })),
  client_loans:Array.from({ length:6823 }, (_, i) => ({ id:`c${String(i).padStart(6,'0')}`, serial_item_id:'s'+i, customer_name:`Cliente ${i}`, equipment_name_original:'Roteador de teste', record_status:'ativo', asset_tag_original:`TESTE${i}`, issued_at:new Date(1780000000000+i*1000).toISOString(), location_original:'Local fictício' })),
  collaborators:[], vehicles:[], stock_locations:[], suppliers:[], receipts:[], receipt_items:[], tool_loans:[], inventory_sessions:[], inventory_counts:[], dashboard_reminders:[], material_requests:[], technician_pendencies:[], technician_pending_events:[], technician_pending_items:[], vehicle_tool_kits:[], vehicle_tool_kit_requirements:[], vehicle_tool_kit_items:[], vehicle_tool_kit_events:[]
};
fixtures.receipts=Array.from({length:300},(_,i)=>({id:'r'+i,supplier:'Fornecedor local',received_at:'2025-01-01T10:00:00Z',invoice_number:'TESTE'+i}));
fixtures.receipt_items=fixtures.receipts.map((receipt,i)=>({id:'ri'+i,receipt_id:receipt.id,product_id:'p2',product_name:'Conector de teste',quantity:2,unit_of_measure:'unidade',created_at:receipt.received_at}));
const mock = `
const fixtures=${JSON.stringify(fixtures)};
window.__reads=[];
class Query {
  constructor(table) { this.table=table; this.from=0; this.to=Infinity; this.filters=[]; this.orders=[]; }
  select(columns, options={}) { this.columns=columns; this.options=options; return this; }
  eq(key,value) { this.filters.push(row=>row[key]===value); return this; }
  in(key,values) { this.filters.push(row=>values.includes(row[key])); return this; }
  not(key,operator,value) { this.filters.push(row=>row[key]!=value); return this; }
  or() { return this; }
  limit(n) { this.to=n-1; return this; }
  range(from,to) { this.from=from; this.to=to; return this; }
  order(key,options={}) { this.orders.push([key,options.ascending]); return this; }
  abortSignal(signal) { this.signal=signal; return this; }
  maybeSingle() { this.single=true; return this; }
  then(resolve,reject) {
    const request={table:this.table,from:this.from,to:this.to,head:this.options?.head};
    window.__reads.push(request);
    if(this.signal?.aborted) return Promise.resolve({data:null,error:{message:'Aborted'}}).then(resolve,reject);
    let rows=(fixtures[this.table]||[]).filter(row=>this.filters.every(filter=>filter(row)));
    rows.sort((a,b)=>{for(const [key,ascending] of this.orders){const cmp=String(a[key]??'').localeCompare(String(b[key]??''));if(cmp)return ascending?cmp:-cmp;}return 0;});
    const count=rows.length;
    rows=rows.slice(this.from, this.to+1);
    request.returned=this.options?.head?0:rows.length;
    return Promise.resolve({data:this.single?rows[0]??null:this.options?.head?null:rows,count,error:null}).then(resolve,reject);
  }
}
export function createClient() { return {
  from:table=>new Query(table),
  auth:{onAuthStateChange(){},getSession:async()=>({data:{session:{user:{id:'local-test',email:'local@example.invalid'}}}})},
  functions:{invoke:async()=>({data:{users:[]},error:null})},
  storage:{from:()=>({getPublicUrl:()=>({data:{publicUrl:''}})})}
}; }`;
const server=createServer(async(req,res)=>{
  try {
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/mock-client.js'){res.setHeader('content-type','text/javascript');res.end(mock);return;}
    const file=resolve(root, pathname==='/'?'index.html':'.'+pathname);
    if(!file.startsWith(root)) throw Error('path');
    let content=await readFile(file);
    if(pathname==='/app.js') content=content.toString().replace("from '@supabase/supabase-js'", "from './mock-client.js'").replace('import.meta.env.VITE_SUPABASE_URL','undefined').replace('import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY','undefined');
    res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'})[extname(file)]||'application/octet-stream');
    res.end(content);
  }catch{res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const devtools=await page.context().newCDPSession(page);
  await devtools.send('Emulation.setCPUThrottlingRate',{rate:4});
  page.setDefaultTimeout(15000);
  const errors=[];
  page.on('pageerror',error=>{errors.push(error.message);console.error(error);});
  page.on('dialog',dialog=>{errors.push(dialog.message());dialog.dismiss();});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>document.querySelector('#dashboard-items-count').textContent==='2'&&!document.querySelector('#dashboard').inert);
  const boot=await page.evaluate(()=>window.__reads);
  assert.equal(boot.filter(read=>read.table==='movements'&&!read.head).length,0);
  for(const table of ['serial_items','serial_movements','receipts','inventory_counts','vehicle_tool_kit_events','client_loans']) assert.equal(boot.some(read=>read.table===table),false,table+' loaded at boot');
  assert.equal(await page.locator('#movement-history .history-card').count(),0);
  await page.locator('[data-view="client-loans"]:visible').first().click();
  await page.waitForFunction(()=>document.querySelector('#client-loan-page-label').textContent.includes('137'));
  assert.equal(await page.locator('#client-loans-table tr').count(),50);
  await page.locator('#client-loan-next').click();
  await page.waitForFunction(()=>document.querySelector('#client-loan-page-label').textContent.includes('2 de'));
  const pages=await page.evaluate(()=>window.__reads.filter(read=>read.table==='client_loans'&&!read.head&&Number.isFinite(read.to)&&read.to-read.from===49));
  assert.equal(pages.length,2);
  assert.deepEqual(pages.map(read=>[read.from,read.to]),[[0,49],[50,99]]);
  const unitPages=await page.evaluate(()=>window.__reads.filter(read=>read.table==='serial_items'&&!read.head));
  assert.deepEqual(unitPages.map(read=>read.returned),[50,50]);
  await page.locator('[data-view="movement"]:visible').first().click();
  await page.waitForFunction(()=>document.querySelector('#movement-history .history-card'));
  await page.evaluate(()=>{window.scrollTo(0,0);document.querySelector('main').scrollTop=0;});
  await page.waitForFunction(()=>document.querySelector('[data-history-entry="movement-m005999"]'));
  const cards=await page.locator('#movement-history .history-card').count();
  assert.ok(cards<=80, 'too many history cards: '+cards);
  const first=await page.locator('[data-history-entry]').first().getAttribute('data-history-entry');
  assert.equal(first,'movement-m005999');
  await page.locator('#history-search').fill('Fornecedor local');
  await page.waitForFunction(()=>document.querySelector('[data-history-entry^="receipt-"]'));
  assert.equal(await page.locator('[data-history-entry^="movement-"]').count(),0);
  await page.locator('#history-search').fill('');
  await page.waitForFunction(()=>document.querySelector('[data-history-entry^="movement-"]'));
  const initialRequests=await page.evaluate(()=>window.__reads.filter(read=>read.table==='movements'&&!read.head).length);
  await page.locator('[data-view="products"]:visible').first().click();
  await page.locator('[data-view="movement"]:visible').first().click();
  await page.waitForFunction(()=>!document.querySelector('#movement').inert);
  assert.equal(await page.evaluate(()=>window.__reads.filter(read=>read.table==='movements'&&!read.head).length),initialRequests);
  for(const name of ['receipts','serials','laboratory','loans','vehicle-kits','inventory','registry','epis','statement','users']){
    const button=page.locator('[data-view="'+name+'"]:visible').first();
    if(await button.count()) {
      await button.click();await page.waitForFunction(id=>!document.getElementById(id).inert,name);
      if(name==='serials') {
        assert.ok(await page.locator('[data-history-serial]').count()<=160);
        await page.locator('[data-history-serial]:visible').first().click();
        await page.waitForFunction(()=>document.querySelector('#serial-history-dialog').open);
        await page.locator('#serial-history-dialog [data-close-dialog]').click();
      }
      if(name==='receipts') {
        await page.waitForFunction(()=>document.querySelector('[data-receipt-details]'));
        assert.ok(await page.locator('[data-receipt-details]').count()<=80);
        await page.locator('[data-receipt-details]:visible').first().click();
        await page.waitForFunction(()=>document.querySelector('#receipt-details-dialog').open);
        assert.match(await page.locator('#receipt-details-list').innerText(),/Conector de teste/);
        await page.locator('#receipt-details-dialog [data-close-dialog]').click();
      }
    }
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({bootRequests:boot.length,historyRecords:6000,mountedCards:cards,clientLoans:6823,pageSize:50,errors},null,2));
} finally { await browser.close(); server.close(); }
