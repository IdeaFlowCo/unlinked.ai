const REASONS = new Set(['build_timeout', 'aborted', 'stale', 'worker_timeout', 'worker_unavailable', 'worker_refused', 'clone_failed', 'exception', 'reader_exception', 'snapshot_invalid', 'install_timeout', 'input_invalid', 'reader_refused'])

export const indexFailureReason = value => REASONS.has(value) ? value : undefined
