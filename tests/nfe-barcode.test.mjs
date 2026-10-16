import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseAst } from 'rollup/parseAst';
import { validateNfeKey, assertNfeNotRegistered } from '../nfe-barcode.js';
const key = '43240401707980000120550030001216501201441562';
test('accepts valid 44-digit key and scanner whitespace; extracts actual invoice number', () => {
  assert.equal(validateNfeKey(key),key);
  assert.equal(validateNfeKey(' '+key.slice(0,22)+' '+key.slice(22)+'\r\n'),key);
  assert.equal(Number(key.slice(25,34)),121650);
});
test('rejects wrong length, letters, punctuation, repeated digits and wrong check digit',()=>{
  for(const value of ['',key.slice(1),key+'0','A'+key.slice(1),key+'.','0'.repeat(44),key.slice(0,43)+'3']) assert.throws(()=>validateNfeKey(value));
});
function client(result) {
  const calls=[];
  const query={select(value){calls.push(['select',value]);return this;},like(column,value){calls.push(['like',column,value]);return this;},async limit(n){calls.push(['limit',n]);return result;}};
  return {calls,from(table){calls.push(['from',table]);return query;}};
}
test('duplicate lookup is read-only and blocks existing keys and failed reads',async()=>{
  const fresh=client({data:[],error:null}); await assertNfeNotRegistered(fresh,key);
  assert.deepEqual(fresh.calls,[['from','receipts'],['select','id,note'],['like','note',`%${key}%`],['limit',1]]);
  await assert.rejects(assertNfeNotRegistered(client({data:[{id:'existing'}]}),key),/já consta/);
  await assert.rejects(assertNfeNotRegistered(client({error:new Error('offline')}),key),/Não foi possível/);
});
test('XML importer and database write calls remain unchanged',()=>{
  const before=execFileSync('git',['show','HEAD:app.js'],{encoding:'utf8',maxBuffer:5e6});
  const after=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  function extract(source){ const calls=[],xml=[];
    function visit(node){if(!node||typeof node!=='object')return;
      if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&['rpc','insert','update','upsert','delete'].includes(node.callee.property?.name))calls.push(source.slice(node.start,node.end).replace(/\r/g,''));
      if(node.type==='FunctionDeclaration'&&['parseInvoiceXml','registerXmlReceipt','openXmlImportDialog'].includes(node.id.name))xml.push(source.slice(node.start,node.end).replace(/\r/g,''));
      if(node.type==='AssignmentExpression'&&source.slice(node.left.start,node.left.end).match(/^\$\('#(xml-file-form|confirm-xml-import)'\)/))xml.push(source.slice(node.start,node.end).replace(/\r/g,''));
      Object.values(node).forEach(v=>Array.isArray(v)?v.forEach(visit):v&&typeof v==='object'&&visit(v));
    }visit(parseAst(source));return {calls,xml};
  }assert.deepEqual(extract(after),extract(before));
});
