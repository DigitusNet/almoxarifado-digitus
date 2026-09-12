import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseAst } from 'rollup/parseAst';
import { createReadCache, InvalidatedReadError } from '../read-performance.js';
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const ast = parseAst(source);
const fn = name => { const node = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name); return source.slice(node.start, node.end); };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('reloads during preparation are consolidated and deliver latest snapshot', async () => {
  let finish; let snapshots = 0;
  const ctx = vm.createContext({loadInFlight:null,reloadRequested:false,coreReadPromise:Promise.resolve(),loadSnapshot:async()=>{ snapshots++; },prepareActiveView:()=>snapshots===1?new Promise(r=>finish=r):Promise.resolve()});
  vm.runInContext(fn('load'),ctx);
  const first=ctx.load(); await tick();
  const queued=Array.from({length:8},()=>ctx.load());
  finish(); await Promise.all([first,...queued]);
  assert.equal(snapshots,2); assert.equal(ctx.reloadRequested,false); assert.equal(ctx.loadInFlight,null);
});

test('modal awaits fresh complete list after invalidation; errors still block', async()=>{
  const cache=createReadCache(); let finish; let calls=0;
  const ctx=vm.createContext({currentUser:{id:'test'},coreReadPromise:Promise.resolve(),lazyReads:cache,lazyTables:{units:['units','id']},state:{units:[]},InvalidatedReadError,selectAllPages:()=>++calls===1?new Promise(r=>finish=r):Promise.resolve({data:['fresh'],error:null})});
  vm.runInContext(fn('ensureReadData'),ctx);
  let opened=false; const request=ctx.ensureReadData(['units']).then(()=>{opened=true;assert.deepEqual(ctx.state.units,['fresh']);});
  await tick(); cache.invalidate(); assert.equal(opened,false);
  finish({data:['old'],error:null}); await request;
  assert.equal(calls,2); assert.equal(opened,true);
  cache.invalidate(); ctx.selectAllPages=async()=>({error:new Error('offline')});
  await assert.rejects(ctx.ensureReadData(['units']),/offline/);
});

test('dirty inventory DOM is not rebuilt; successful simulated save releases draft',async()=>{
  const table={_draftDirty:true,_draftRevision:1,_draftSession:'session',innerHTML:'unsaved 12.50'};
  const input={value:'12.50',dataset:{inventoryCount:'p'}};
  let refreshed=false;
  const ctx=vm.createContext({$:()=>table,activeInventory:()=>({id:'session'}),document:{querySelectorAll:()=>[input],querySelector:()=>({value:'note'})},supabase:{rpc:async()=>({error:null})},load:async()=>{refreshed=true;assert.equal(table._draftDirty,false);},alert:()=>{}});
  vm.runInContext(fn('renderInventory')+'\n'+fn('saveInventoryCounts'),ctx);
  ctx.renderInventory(); ctx.renderInventory();
  assert.equal(table.innerHTML,'unsaved 12.50');
  await ctx.saveInventoryCounts(); assert.equal(refreshed,true);
  table._draftDirty=true;
  ctx.supabase.rpc=async()=>({error:new Error('failed')});
  await assert.rejects(ctx.saveInventoryCounts(),/failed/); assert.equal(table._draftDirty,true);
  ctx.supabase.rpc=async()=>{table._draftRevision++;return {error:null};};
  ctx.load=async()=>{}; await ctx.saveInventoryCounts();assert.equal(table._draftDirty,true);
});
