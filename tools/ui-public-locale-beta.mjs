// A separate, UI-only public beta. It retains the existing production account and
// purchase-closed backend contract without changing the production mutation lane.
export const PUBLIC_LOCALE_BETA_REQUEST = 'production-account-ru-kk-beta-v1';
export const PUBLIC_LOCALE_BETA_APPROVAL = PUBLIC_LOCALE_BETA_REQUEST;
export const PUBLIC_LOCALE_BETA_RECEIPT = 'ru-kk-public-beta-v1';

// Replace with the exact reviewed Atmos master SHA after the candidate is final.
// The all-zero pin makes selection and publication fail closed in the meantime.
export const PUBLIC_LOCALE_BETA_ATMOS_SHA = '0000000000000000000000000000000000000000';

export function assertPublicLocaleBetaReady() {
  if (!/^[a-f0-9]{40}$/.test(PUBLIC_LOCALE_BETA_ATMOS_SHA)
    || /^0+$/.test(PUBLIC_LOCALE_BETA_ATMOS_SHA)) {
    throw new Error('public RU/KK beta requires an exact reviewed Atmos source and controller SHA');
  }
  return PUBLIC_LOCALE_BETA_ATMOS_SHA;
}
