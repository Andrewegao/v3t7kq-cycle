// Public diagnostics are an allowlisted projection, never provider text, keys, URLs or causes.
const tagged = new WeakMap();
const stages = new Set(['workflow', 'transport', 'prepare-local', 'prepare-payload', 'prepare-manifest', 'prepare-completion',
  'activate-completion', 'activate-manifest', 'activate-payload', 'activate-pointer']);
const operations = new Set(['validate', 'get', 'put', 'check-bytes', 'check-metadata', 'check-identity']);
const categories = new Set(['http', 'timeout', 'network', 'validation', 'integrity', 'unknown']);
const statuses = new Set([400, 401, 403, 404, 408, 409, 412, 413, 429, 500, 502, 503, 504]);
const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
function classify(error) {
  // Exact known codes only. In particular, never inspect error.message or serialize error.
  try {
    const status = error?.$metadata?.httpStatusCode;
    if (statuses.has(status)) return { category: 'http', httpStatus: status };
    if (['TimeoutError', 'AbortError'].includes(error?.name) || ['ETIMEDOUT', 'ABORT_ERR'].includes(error?.code)) return { category: 'timeout' };
    if (networkCodes.has(error?.code)) return { category: 'network' };
    if (error?.code === 'ERR_ASSERTION') return { category: 'validation' };
  } catch { /* Malformed provider properties must not affect publication semantics. */ }
  return { category: 'unknown' };
}
function projection(row) {
  const safe = { stage: stages.has(row.stage) ? row.stage : 'workflow', operation: operations.has(row.operation) ? row.operation : 'validate',
    category: categories.has(row.category) ? row.category : 'unknown' };
  if (statuses.has(row.httpStatus)) safe.httpStatus = row.httpStatus;
  if (Number.isSafeInteger(row.totalPayloads) && row.totalPayloads >= 0 && row.totalPayloads <= 20000
    && Number.isSafeInteger(row.completedPayloads) && row.completedPayloads >= 0 && row.completedPayloads <= row.totalPayloads) {
    safe.completedPayloads = row.completedPayloads; safe.totalPayloads = row.totalPayloads;
  }
  return safe;
}
export function tagPlaceError(error, context = {}) {
  const target = error && (typeof error === 'object' || typeof error === 'function') ? error : new Error('staging place operation failed');
  const previous = tagged.get(target);
  tagged.set(target, projection({ ...classify(error), ...previous, ...context })); return target;
}
export function placeFailureDiagnostic(error) {
  return { schemaVersion: 1, kind: 'staging-place-failure', ...projection(tagged.get(error) ?? classify(error)) };
}
export async function placeOperation(stage, operation, progress, task) {
  try { return await task(); } catch (error) {
    const previous = tagged.get(error);
    // Keep a more specific integrity operation detected inside a get/readback.
    throw tagPlaceError(error, { stage, operation: previous && ['check-bytes', 'check-metadata'].includes(previous.operation) ? previous.operation : operation, ...progress?.() });
  }
}
export function placeProgress(stage, totalPayloads, report) {
  stage = stages.has(stage) ? stage : 'workflow';
  let completedPayloads = 0;
  const snapshot = () => ({ completedPayloads, totalPayloads });
  const emit = () => { const row = { schemaVersion: 1, kind: 'staging-place-progress', stage, ...snapshot() };
    try { report?.(row); } catch { /* Observability must not become a write or quality gate. */ } };
  emit();
  return { snapshot, completed() { completedPayloads++; if (completedPayloads % 500 === 0 || completedPayloads === totalPayloads) emit(); } };
}
