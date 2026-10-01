export const COMBINED_UPLOAD_CONSENT = Object.freeze({ version: 'private-archive-openai-v1', privateRetention: true, boundedOpenAIProcessing: true })

export function hasCombinedUploadConsent(consent) {
  return consent?.version === COMBINED_UPLOAD_CONSENT.version && consent.privateRetention === true && consent.boundedOpenAIProcessing === true
}

export function requireCombinedUploadConsent(consent) {
  if (!hasCombinedUploadConsent(consent)) throw new Error('private_upload_consent_required')
}
