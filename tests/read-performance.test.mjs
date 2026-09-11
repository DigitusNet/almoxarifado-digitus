import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { createReadCache, debounce, groupBy } from '../read-performance.js';

test('concurrent reads share one request; invalidation discards late results', async () => {
  const cache = createReadCache();
  let calls = 0, applied = 0, finish;
  const read = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const a = cache.get('history', read, () => applied++);
  const b = cache.get('history', read, () => applied++);
  await Promise.resolve();
  assert.equal(calls, 1);
  cache.invalidate();
  finish([]);
  await Promise.all([a, b]);
  assert.equal(applied, 0);
  assert.equal(cache.has('history'), false);
  await cache.get('history', () => [], () => applied++);
  assert.equal(applied, 1);
});

test('failed reads can be retried', async () => {
  const cache = createReadCache();
  await assert.rejects(cache.get('x', () => { throw Error('offline'); }, () => {}));
  await cache.get('x', () => [], () => {});
  assert.equal(cache.has('x'), true);
});

test('debounce executes the latest search once and cancels pending work', async () => {
  const calls = [];
  const search = debounce(value => calls.push(value), 10);
  search('a'); search('ab'); search('abc');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(calls, ['abc']);
  search('discard'); search.cancel();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(calls, ['abc']);
});

const baseline = execFileSync('git', ['show', 'beda936:app.js'], { encoding:'utf8', maxBuffer:4e6 });
const changed = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const extract = (source, name, end) => source.slice(source.indexOf(`function ${name}(`), source.indexOf(end, source.indexOf(`function ${name}(`))).trim();
test('receipt matching produces exactly the same links, including ambiguous candidates', () => {
  const state = { receipts:[], receiptItems:[], movements:[] };
  for (let i = 0; i < 400; i++) {
    const at = new Date(1700000000000 + i * 1800000).toISOString();
    state.receipts.push({ id:`r${i}`, received_at:at, supplier:`Fornecedor ${i % 10}` });
    state.receiptItems.push({ id:`ri${i}`, receipt_id:`r${i}`, product_id:`p${i % 7}`, quantity:i % 5 + 1 });
    state.movements.push({ id:`m${i}`, type:'entrada', person:`Recebimento: Fornecedor ${i % 10}`, productId:`p${i % 7}`, quantity:i % 5 + 1, createdAt:at });
    state.movements.push({ id:`unrelated${i}`, type:'saida', person:'Técnico', quantity:1, productId:'p0', createdAt:at });
  }
  state.movements.push({ ...state.movements[0], id:'duplicate-candidate' });
  const evaluate = source => {
    const context = vm.createContext({ state, groupBy });
    vm.runInContext(extract(source, 'receiptMovementLinks', 'function historyFilters'), context);
    const result = vm.runInContext('receiptMovementLinks()', context);
    return { links:[...result.byItem].map(([key, value]) => [key, value.id]), ids:[...result.movementIds] };
  };
  const before = performance.now();
  const expected = evaluate(baseline);
  const middle = performance.now();
  const actual = evaluate(changed);
  const end = performance.now();
  assert.deepEqual(actual, expected);
  console.log(`Receipt matching fixture: old=${(middle-before).toFixed(1)}ms new=${(end-middle).toFixed(1)}ms`);
});

test('business write handlers and SQL are unchanged', () => {
  const diff = execFileSync('git', ['diff', 'beda936', '--unified=0', '--', 'app.js'], { encoding:'utf8' });
  const changes = diff.split('\n').filter(line => /^[+-](?![+-])/.test(line));
  assert.equal(changes.some(line => /supabase\.rpc\(|\.(insert|update|upsert|delete)\(/.test(line)), false);
  assert.equal(execFileSync('git', ['diff', 'beda936', '--name-only', '--', 'supabase'], { encoding:'utf8' }).trim(), '');
});

test('complete timeline, filters and tied timestamps preserve their original results', () => {
  const at = '2026-09-01T12:00:00Z';
  const state = {
    products:[{id:'p1',name:'Roteador',code:'R1',unit_of_measure:'unidade'}],
    receipts:[{id:'r1',received_at:at,supplier:'Fornecedor',invoice_number:'N1'}],
    receiptItems:[{id:'ri1',receipt_id:'r1',product_id:'p1',quantity:1,product_name:'Roteador'}],
    movements:[{id:'m1',type:'entrada',person:'Recebimento: Fornecedor',productId:'p1',quantity:1,createdAt:at,stockBefore:0,stockAfter:1},{id:'m2',type:'saida',person:'Outro',productId:'p1',quantity:1,createdAt:at}],
    serialItems:[{id:'s1',product_id:'p1',receipt_id:'r1',mac_address:'MAC1',serial_number:'SERIAL1',asset_tag:'001'}],
    serialMovements:['instalacao','retorno','transferencia'].map((action,i)=>({id:'sm'+i,serial_item_id:'s1',action,created_at:at,previous_status:'com_colaborador',new_status:'disponivel'})),
    technicianPendencies:[{id:'pending1',product_id:'p1',quantity:1,technician_name:'Técnico',work_order:'OS1'}],
    technicianPendingItems:[{pending_id:'pending1',serial_item_id:'s1'}],
    technicianPendingEvents:['retirada','transferencia','prorrogacao','devolucao','utilizacao'].map((event_type,i)=>({id:'event'+i,pending_id:'pending1',event_type,occurred_at:at,from_technician:'A',to_technician:'B',customer_name:'Cliente'})),
    locations:[]
  };
  const evaluate = source => {
    const context = vm.createContext({state,groupBy,product:id=>state.products.find(p=>p.id===id),quantity:String,unitName:String,date:String,holderTypeName:String,serialStatusName:String,serialActionName:String});
    vm.runInContext(extract(source,'receiptMovementLinks','function historyFilters'),context);
    vm.runInContext(extract(source,'buildHistoryEntries','function getFieldStockItems'),context);
    return JSON.parse(JSON.stringify(vm.runInContext('buildHistoryEntries()',context)));
  };
  assert.deepEqual(evaluate(changed),evaluate(baseline));
});
