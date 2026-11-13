import { describe, expect, test } from 'bun:test';
import { redactString } from '../../../src/lib/server/diagnostics/redaction';
import { normalizePoyoError, PoyoError } from '../../../src/lib/server/poyo/errors';
import { parseStatusResponse, parseSubmitResponse } from '../../../src/lib/server/poyo/parsers';
import {
  jobProviderDiagnostic,
  providerDiagnostic,
  readJobProviderDiagnostic
} from '../../../src/lib/server/poyo/provider-diagnostic';
import evidence from '../../fixtures/poyo/rejection-diagnostics.json';

describe('bounded provider rejection diagnostics (no retry classification)', () => {
  test('retains documented envelope and failure metadata with explicit provenance', () => {
    expect(evidence.provenance.gate).toBe('exact-authoritative-poll-signature');
    const error = normalizePoyoError('submit', 200, evidence.documentedValidationError);
    expect(error.providerDiagnostic).toMatchObject({
      httpStatus: 200,
      responseCode: 400,
      errorType: 'validation_error',
      errorMessagePresent: true,
      documentedMessage: null
    });
    expect(error).toMatchObject({ category: 'unsupported_configuration', retryable: false });
    const status = parseStatusResponse(evidence.documentedFailedStatus);
    expect(status.providerDiagnostic).toMatchObject({
      responseCode: 200,
      statusRaw: 'failed',
      documentedMessage: evidence.documentedFailedStatus.data.error_message
    });
  });

  test('omits arbitrary prompt/URL echoes that ordinary credential redaction leaves intact', () => {
    const prompt = 'private prompt canary';
    const url = 'https://private.example/secret-path?unrecognized_signature=private-url-canary';
    expect(redactString(prompt)).toBe(prompt);
    expect(redactString(url)).toBe(url);
    const payload = {
      code: 422,
      input: { prompt, seed: 94567812 },
      error: {
        code: 'E_INPUT',
        type: 'validation_error',
        message: `${prompt} ${url} Bearer private-token sk-private_canary_12345`
      },
      raw_payload: { prompt, url }
    };
    const diagnostic = providerDiagnostic(payload, 422);
    expect(diagnostic).toMatchObject({ errorCode: null, errorMessagePresent: true });
    const serialized = JSON.stringify(
      normalizePoyoError('submit', 422, payload).providerDiagnostic
    );
    for (const canary of [prompt, url, 'private-token', 'sk-private', '94567812'])
      expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('raw_payload');
  });

  test('bounds machine tokens and drops unsafe values and unknown properties on reread', () => {
    for (const unsafe of [
      'sk-secret_canary_123456789',
      'Bearer private-token',
      'https://private.example/secret',
      'data:private-url-canary',
      'https:private-url-canary',
      'private prompt',
      'A'.repeat(81),
      'token=private',
      'PrivateCredentialAbCd1234_5678',
      'SingleTokenPromptCanary',
      1234567890123456
    ]) {
      const raw = { code: unsafe, error: { code: unsafe, type: unsafe }, status: unsafe };
      const diagnostic = providerDiagnostic(raw);
      expect(diagnostic).toMatchObject({
        responseCode: null,
        errorCode: null,
        errorType: null,
        statusRaw: null
      });
      const publicDiagnostic = readJobProviderDiagnostic({
        providerDiagnostic: {
          ...jobProviderDiagnostic(diagnostic, 'status', true),
          prompt: unsafe,
          seed: 123456,
          url: unsafe,
          documentedMessage: unsafe
        }
      });
      expect(JSON.stringify(publicDiagnostic)).not.toContain(String(unsafe));
      expect(publicDiagnostic?.documentedMessage).toBeNull();
    }
    expect(readJobProviderDiagnostic({ providerDiagnostic: { version: 2 } })).toBeNull();
  });

  test('retains both cancellation spellings and terminal submit-ack observations', () => {
    for (const raw of ['cancelled', 'canceled', 'failed']) {
      const payload = {
        ...evidence.documentedFailedStatus,
        data: { ...evidence.documentedFailedStatus.data, status: raw, error_code: 'E_TASK' }
      };
      expect(parseStatusResponse(payload)).toMatchObject({
        status: 'failed',
        statusRaw: raw,
        providerDiagnostic: { statusRaw: raw, errorCode: null }
      });
      expect(parseSubmitResponse(payload)).toMatchObject({
        status: 'failed',
        statusRaw: raw,
        providerDiagnostic: { statusRaw: raw, errorCode: null }
      });
    }
  });

  test('retains safe metadata even when a submit acknowledgement is malformed', () => {
    try {
      parseSubmitResponse(
        {
          code: 200,
          data: {
            status: 'failed',
            error_code: 'E_INCOMPLETE',
            error_message: 'private prompt canary'
          }
        },
        202
      );
      throw new Error('Expected malformed response');
    } catch (error) {
      expect(error).toMatchObject({
        category: 'malformed_response',
        retryable: false,
        providerDiagnostic: {
          httpStatus: 202,
          responseCode: 200,
          errorCode: null,
          statusRaw: 'failed',
          errorMessagePresent: true,
          documentedMessage: null
        }
      });
      expect(String(error)).not.toContain('private prompt canary');
    }
  });

  test('live upload detail stays useful while logged messages are omitted', () => {
    const error = normalizePoyoError('upload_stream', 422, {
      detail: [{ msg: 'file too large max 10MB' }]
    });
    expect(error.toSafeDto().message).toContain('max 10MB');
    expect(JSON.stringify(error.providerDiagnostic)).not.toContain('10MB');
    const unknown = normalizePoyoError('submit', 422, {
      error: { type: 'PrivateCredentialAbCd1234_5678' }
    });
    expect(unknown.technicalCode).toBe('http_422');
    expect(unknown.providerDiagnostic).toMatchObject({ errorType: null, errorTypePresent: true });
    expect(normalizePoyoError('submit', 200, { code: 0 }).technicalCode).toBe(
      'business_code_error'
    );
  });

  test('diagnostics do not broaden existing content/configuration classification', () => {
    for (const type of ['content_moderation_error', 'content_too_long_error', 'validation_error']) {
      expect(normalizePoyoError('submit', 400, { code: 400, error: { type } })).toMatchObject({
        category: 'unsupported_configuration',
        retryable: false
      });
    }
    expect(providerDiagnostic({ code: '400', data: { error_code: 'E_EXACT' } })).toMatchObject({
      responseCode: '400',
      errorCode: null
    });
  });
  test('empty message fields are absent while nonempty validation detail is present', () => {
    for (const detail of ['', '   ', [], [{ msg: '' }]])
      expect(providerDiagnostic({ detail }).errorMessagePresent).toBe(false);
    expect(providerDiagnostic({ detail: [{ msg: 'max 10MB' }] }).errorMessagePresent).toBe(true);
    expect(providerDiagnostic({ data: { credits_amount: 0 } }).observedCreditsAmount).toBe(0);
    for (const credits_amount of [NaN, Infinity, -1, '0'])
      expect(providerDiagnostic({ data: { credits_amount } }).observedCreditsAmount).toBeNull();
  });
  test('parser enrichment preserves the internal cause and retry timing without exposing them', () => {
    const cause = new Error('PrivateCredentialAbCd1234_5678');
    const original = new PoyoError({
      category: 'malformed_response',
      technicalCode: 'malformed_response',
      operation: 'submit',
      message: 'Invalid task identity',
      retryable: false,
      retryAfterMs: 2500,
      cause
    });
    const payload = {
      data: {
        status: 'failed',
        get task_id() {
          throw original;
        },
        created_time: 'now'
      }
    };
    try {
      parseSubmitResponse(payload, 202);
      throw new Error('Expected parser failure');
    } catch (error) {
      expect(error).toBeInstanceOf(PoyoError);
      if (!(error instanceof PoyoError)) throw error;
      expect(error.cause).toBe(cause);
      expect(error.retryAfterMs).toBe(2500);
      expect(error.httpStatus).toBe(202);
      expect(JSON.stringify(error.toSafeDto())).not.toContain('PrivateCredential');
    }
  });
});
