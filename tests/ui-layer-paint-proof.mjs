import assert from 'node:assert/strict';
import test from 'node:test';
import {strictPaintReceipt} from '../tools/ui-layer-paint-proof.mjs';
const expected={layer:'cloud',beforeSequence:10,beforeIntentGeneration:2,model:'ecmwf',run:'2026-09-26T12:00:00Z',base:'/data/ecmwf/runs/2026092612/',cursorMs:1790438400000};
function fixture(layer='cloud') {
 const context={intentKey:layer,intentGeneration:3,model:expected.model,run:expected.run,base:expected.base,cursor:expected.cursorMs,swap:'idle',overlayGeneration:4};
 const events=[{sequence:11,stage:'deck-after',data:{...context,renderedGeneration:4}},
  {sequence:12,stage:'receipt-flush',data:{...context,renderedGeneration:4,accepted:true}},
  {sequence:13,stage:'layer-receipt',data:{...context,path:'deck',painted:layer}}];
 const layers=[{id:layer==='wind'?'wind-field':`${layer}-raster`,isLoaded:true,props:{visible:true,opacity:.85},state:{imageTexture:{},imageTexture2:{}}}];
 globalThis.document={body:{dataset:{}}};
 const state={layers:{[layer]:{visible:true}},manifest:{model:expected.model,init_time:expected.run,base:expected.base},cursorMs:expected.cursorMs};
 globalThis.window={__atmos:{store:{getState:()=>state},renderCausalDiagnostics:()=>({enabled:true,errors:0,events}),deckRenderedLayers:()=>layers}};
 return {events,layers,state,expected:{...expected,layer}};
}
test('requires a new exact accepted scalar Deck paint, not just selection and idle',()=>{
 const x=fixture();assert.equal(strictPaintReceipt(x.expected).owner,'deck');
 x.events.splice(0);assert.equal(strictPaintReceipt(x.expected),false);
});
test('rejects stale or skipped intent generations and changed forecast identities',()=>{
 for(const [key,value] of [['intentGeneration',2],['intentGeneration',4],['intentKey','gust'],['model','gfs'],['run','old'],['base','other'],['cursor',1]]){
  const x=fixture();x.events.forEach(event=>{event.data[key]=value;});assert.equal(strictPaintReceipt(x.expected),false,key);
 }
});
test('rejects stale receipt, wrong field, preview scalar, missing draw/flush and unbound Deck textures',()=>{
 for(const mutate of [x=>x.events[2].sequence=10,x=>x.events[2].data.painted='gust',x=>x.events[2].data.path='preview',
  x=>x.events.shift(),x=>x.events[1].data.accepted=false,x=>x.events[1].data.renderedGeneration=8,
  x=>x.layers[0].state.imageTexture2=null,x=>document.body.dataset.wlSwap='holding']){
  const x=fixture();mutate(x);assert.equal(strictPaintReceipt(x.expected),false);
 }
});
test('accepts exact native Temperature receipt without demanding Deck cache residency',()=>{
 const x=fixture('temp');x.layers.splice(0);x.events[2].data.path='preview';
 let argument;
 const proof=strictPaintReceipt(x.expected,arg=>{argument=arg;return {paintReceipt:x.events[2]};});
 assert.equal(proof.owner,'native');assert.equal(proof.authoritativeDeck,false);
 assert.deepEqual(argument,{afterSequence:10,manifest:{model:expected.model,init:expected.run,base:expected.base},cursorMs:expected.cursorMs});
 assert.equal(strictPaintReceipt(x.expected,()=>false),false);
 assert.equal(strictPaintReceipt(x.expected,()=>({paintReceipt:{sequence:12}})),false);
});
test('accepts exact painted native Wind with new causal receipt but without a Deck wind object',()=>{
 const x=fixture('wind');x.layers.splice(0);
 const proof=strictPaintReceipt(x.expected,()=>false,()=>({owner:'native'}));
 assert.equal(proof.owner,'native');assert.equal(proof.authoritativeDeck,false);
 assert.equal(strictPaintReceipt(x.expected,()=>false,()=>false),false);
 x.events[1].data.accepted=false;assert.equal(strictPaintReceipt(x.expected,()=>false,()=>({owner:'native'})),false);
});
test('Deck Temperature and Wind still require authoritative loaded textures',()=>{
 for(const layer of ['temp','wind']){
  const x=fixture(layer),temp=()=>({paintReceipt:x.events[2]}),wind=()=>({owner:'deck'});
  assert.equal(strictPaintReceipt(x.expected,temp,wind).authoritativeDeck,true);
  x.layers[0].state.imageTexture2=null;assert.equal(strictPaintReceipt(x.expected,temp,wind),false);
 }
});

test('generated serialized predicate has no missing module closures',async()=>{
 const {addDiagnostics,PREFILL_ACTIVATE,PREFILL_WAIT}=await import('../tools/ui-layer-diagnostics.mjs');
 const generated=addDiagnostics('const page = await context.newPage();\n'+PREFILL_ACTIVATE+'\n'+PREFILL_WAIT,'','strict-paint');
 const declaration=generated.slice(generated.indexOf('const diagnosticPaintPredicate ='),generated.indexOf('\n  await diagnosticSnapshot'));
 const compile=new Function('temperatureSurfaceProof','windSurfaceProof',declaration+'\nreturn diagnosticPaintPredicate;');
 // Both helpers are serialized as source, just like the fixed controller's imported functions.
 const predicate=compile(function(){return false;},function(){return {owner:'native'};});
 const x=fixture('wind');x.layers.splice(0);
 assert.equal(predicate(x.expected).owner,'native');
 x.events[2].data.intentGeneration=2;assert.equal(predicate(x.expected),false);
});
