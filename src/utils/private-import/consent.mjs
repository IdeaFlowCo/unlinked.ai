export const COMBINED_UPLOAD_CONSENT = Object.freeze({ version: 'private-archive-openai-v1', privateRetention: true, boundedOpenAIProcessing: true })

export const PUBLIC_UPLOAD_CONSENT = Object.freeze({ version: 'public-professional-archive-openai-v2', privateRetention: true, boundedOpenAIProcessing: true, publicProfessionalSearch: true })

export function hasCombinedUploadConsent(consent) {
  return (consent?.version === COMBINED_UPLOAD_CONSENT.version || (consent?.version === PUBLIC_UPLOAD_CONSENT.version && consent.publicProfessionalSearch === true)) && consent.privateRetention === true && consent.boundedOpenAIProcessing === true
}

export function requireCombinedUploadConsent(consent) {
  if (!hasCombinedUploadConsent(consent)) throw new Error('private_upload_consent_required')
}
