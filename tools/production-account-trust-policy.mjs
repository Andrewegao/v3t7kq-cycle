// Reviewed, non-secret production trust anchors. Provisional values deliberately make every
// production authority factory fail closed until the owner replaces them in a reviewed commit.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
const deepFreeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))deepFreeze(item);Object.freeze(value);}return value;};

export const PRODUCTION_ACCOUNT_TRUST_POLICY=deepFreeze({
  schemaVersion:1,
  status:'provisional',
  approval:{
    issuer:'UNUSABLE_PROVISIONAL_OWNER_APPROVAL_ISSUER',
    audience:'weatherx-production-account-controller-v1',
    publicKeySpkiSha256:'UNUSABLE_PROVISIONAL_OWNER_APPROVAL_KEY_FINGERPRINT',
  },
  leaseService:{
    issuer:'UNUSABLE_PROVISIONAL_LEASE_SERVICE_ISSUER',
    audience:'weatherx-production-account-controller-v1',
    publicKeySpkiSha256:'UNUSABLE_PROVISIONAL_LEASE_SERVICE_KEY_FINGERPRINT',
  },
  mutationBroker:{
    issuer:'UNUSABLE_PROVISIONAL_MUTATION_BROKER_ISSUER',
    audience:'weatherx-production-account-controller-v1',
    publicKeySpkiSha256:'UNUSABLE_PROVISIONAL_MUTATION_BROKER_KEY_FINGERPRINT',
  },
  cloudflare:{
    accountId:'a89f9a1af485021fbc60a68b163c7c6e',
    environment:'production',
    workerName:'weatherx-platform-edge-production',
    pagesProject:'atmos-platform',
    resourceNamespaces:{
      worker:'cloudflare:a89f9a1af485021fbc60a68b163c7c6e:workers:weatherx-platform-edge-production',
      pages:'cloudflare:a89f9a1af485021fbc60a68b163c7c6e:pages:atmos-platform',
    },
  },
});

export const PRODUCTION_ACCOUNT_TRUST_POLICY_DIGEST=createHash('sha256').update(canonical(PRODUCTION_ACCOUNT_TRUST_POLICY)).digest('hex');

export function assertProductionAccountTrustPolicyReady(){
  assert.equal(PRODUCTION_ACCOUNT_TRUST_POLICY.status,'final','production-account-trust-policy-provisional');
  for(const section of ['approval','leaseService','mutationBroker']){
    const value=PRODUCTION_ACCOUNT_TRUST_POLICY[section];
    for(const field of ['issuer','audience']){
      assert.match(value[field]??'',/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,159}$/,`${section}-${field}-invalid`);
      assert.doesNotMatch(value[field],/UNUSABLE|PROVISIONAL/i,`${section}-${field}-unusable`);
    }
    assert.match(value.publicKeySpkiSha256??'',/^[a-f0-9]{64}$/,`${section}-trust-fingerprint-invalid`);
    assert.doesNotMatch(value.publicKeySpkiSha256,/^0{64}$|UNUSABLE|PROVISIONAL/i,`${section}-trust-fingerprint-unusable`);
  }
  return PRODUCTION_ACCOUNT_TRUST_POLICY;
}
