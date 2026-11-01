import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {parseAst} from 'rollup/parseAst';
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8').replace(/\r/g,'');
const before=execFileSync('git',['show','606f3b5:app.js'],{encoding:'utf8',maxBuffer:5e6}).replace(/\r/g,'');
test('kit navigation, page, dialogs and exclusive handlers are removed',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/data-view="vehicle-kits"|id="vehicle-kit/);
  assert.doesNotMatch(source,/renderVehicleKits|openVehicleKit|updateVehicleKitAction|\$\('#vehicle-kit/);
});
test('all other functions and submit handlers remain unchanged, including vehicle movements',()=>{
  const excluded=new Set(['renderVehicleKits','openVehicleKitEditor','openVehicleKitAction','updateVehicleKitAction','openVehicleKitHistory','renderActiveView','view']);
  function collect(text){const result={};
    for(const node of parseAst(text).body){
      if(node.type==='FunctionDeclaration'&&!excluded.has(node.id.name))result[node.id.name]=text.slice(node.start,node.end);
      if(node.type==='ExpressionStatement'&&node.expression.type==='AssignmentExpression'){
        const left=text.slice(node.expression.left.start,node.expression.left.end);
        if(left.endsWith('.onsubmit')&&!left.includes('vehicle-kit'))result[left]=text.slice(node.start,node.end);
      }
    }return result;
  }assert.deepEqual(collect(source),collect(before));
});
test('database scripts and stylesheet files were not modified',()=>{
  assert.equal(execFileSync('git',['diff','606f3b5','--name-only','--','supabase','*.css'],{encoding:'utf8'}).trim(),'');
});
