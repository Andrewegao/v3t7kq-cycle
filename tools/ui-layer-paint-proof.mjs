// Diagnostic predicate only. The exact controller supplies its reviewed native surface proofs.
export function strictPaintReceipt(expected, temperatureProof, windProof) {
  const api = window.__atmos, state = api?.store.getState(), manifest = state?.manifest;
  const ledger = api?.renderCausalDiagnostics?.(), latest = ledger?.events.at(-1);
  if (!expected || !Number.isInteger(expected.beforeIntentGeneration) || !Number.isInteger(expected.beforeSequence)
    || !manifest || !ledger?.enabled || ledger.errors || !state.layers[expected.layer]?.visible
    || document.body.dataset.wlSwap || manifest.model !== expected.model || manifest.init_time !== expected.run
    || manifest.base !== expected.base || state.cursorMs !== expected.cursorMs) return false;
  const targetGeneration = expected.beforeIntentGeneration + 1;
  if (latest?.data.intentKey !== expected.layer || latest.data.intentGeneration !== targetGeneration) return false;
  const same = event => event.sequence > expected.beforeSequence && event.data.intentKey === expected.layer
    && event.data.intentGeneration === targetGeneration && event.data.model === expected.model
    && event.data.run === expected.run && event.data.base === expected.base && event.data.cursor === expected.cursorMs
    && event.data.swap === 'idle';
  const receipt = ledger.events.findLast(event => event.stage === 'layer-receipt' && same(event)
    && (event.data.path === 'preview' && expected.layer === 'temp'
      || event.data.path === 'deck' && event.data.painted?.split('|').includes(expected.layer)));
  if (!receipt) return false;
  const id = expected.layer === 'wind' ? 'wind-field' : `${expected.layer}-raster`;
  const rendered = api.deckRenderedLayers?.()?.find(layer => layer.id === id);
  const authoritativeDeck = Boolean(rendered?.isLoaded && rendered.props?.visible !== false
    && rendered.props?.opacity > 0 && rendered.state?.imageTexture && rendered.state?.imageTexture2);
  let owner = 'deck';
  if (expected.layer === 'temp') {
    const proof = temperatureProof({afterSequence:expected.beforeSequence,
      manifest:{model:expected.model,init:expected.run,base:expected.base},cursorMs:expected.cursorMs});
    if (!proof || proof.paintReceipt.sequence !== receipt.sequence) return false;
    owner = receipt.data.path === 'preview' ? 'native' : 'deck';
  }
  if (expected.layer === 'wind') {
    const proof = windProof();
    if (!proof) return false;
    owner = proof.owner;
  }
  if (receipt.data.path === 'deck') {
    const generation = receipt.data.overlayGeneration;
    const flush = ledger.events.findLast(event => event.sequence < receipt.sequence && same(event)
      && event.stage === 'receipt-flush' && event.data.accepted === true && event.data.renderedGeneration === generation);
    const draw = ledger.events.findLast(event => event.sequence < (flush?.sequence ?? 0) && same(event)
      && event.stage === 'deck-after' && event.data.renderedGeneration === generation);
    if (!Number.isInteger(generation) || !flush || !draw || (owner === 'deck' && !authoritativeDeck)) return false;
  }
  return {layer:expected.layer,owner,authoritativeDeck,intentGeneration:targetGeneration,
    receiptSequence:receipt.sequence,overlayGeneration:receipt.data.overlayGeneration ?? null};
}
