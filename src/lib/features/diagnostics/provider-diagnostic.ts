/** Bounded metadata only: never a provider envelope or arbitrary error message. */
export interface ProviderDiagnostic {
  version: 1;
  httpStatus: number | null;
  responseCode: string | number | null;
  errorCode: string | number | null;
  errorType: string | null;
  statusRaw: string | null;
  errorMessagePresent: boolean;
  documentedMessage: string | null;
}

export interface JobProviderDiagnostic extends ProviderDiagnostic {
  source: 'submit_error' | 'submit_ack' | 'status' | 'poll_error';
  seed_explicit: boolean;
}
