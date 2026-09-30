// Mirror the mandatory tides route before staging build and upload. Header-only: the large
// forecast body is cancelled, never buffered. This does not replace the guarded final verifier.
import assert from 'node:assert/strict';
import {STAGING_ORIGIN} from './ui-staging-models.mjs';

export const REQUIRED_TIDES_URL=new URL('/data-atmos/tides/tides.json',STAGING_ORIGIN).href;
export async function requireStagingTides({fetchImpl=fetch}={}){
  let response;
  try{
    response=await fetchImpl(REQUIRED_TIDES_URL,{redirect:'error',signal:AbortSignal.timeout(20_000),
      headers:{Accept:'application/json','Cache-Control':'no-cache'}});
    assert.equal(response.url,REQUIRED_TIDES_URL,'request redirected');
    assert.equal(response.status,200,`status ${response.status}; expected 200`);
    assert.match(response.headers.get('content-type')??'',/^application\/json(?:\s*;|$)/i,'Content-Type must be application/json');
    const release=response.headers.get('x-weatherx-release')?.trim();
    assert.ok(release,'missing X-WeatherX-Release');
    return {url:REQUIRED_TIDES_URL,status:200,releaseId:release};
  }catch(error){
    throw new Error(`required staging data ${REQUIRED_TIDES_URL} failed: ${error instanceof Error?error.message:String(error)}`);
  }finally{
    // Retain the predicate failure even if the transport is already closed.
    try{await response?.body?.cancel();}catch{}
  }
}
