import { describe, expect, test } from 'bun:test';
import {
  RequestSecurityError,
  readSameOriginJson
} from '../../../src/lib/server/platform/request-security';

function request(
  body: string,
  headers: Record<string, string> = {
    origin: 'http://127.0.0.1:3000',
    'content-type': 'application/json'
  }
): Request {
  return new Request('http://127.0.0.1:3000/api/settings', {
    method: 'POST',
    headers,
    body
  });
}

describe('same-origin JSON protection', () => {
  test('SEC-02 accepts bounded same-origin JSON', async () => {
    await expect(
      readSameOriginJson<{ theme: string }>(request('{"theme":"dark"}'))
    ).resolves.toEqual({ theme: 'dark' });
  });

  test('SEC-02 rejects missing/mismatched origins and cross-site requests', async () => {
    await expect(
      readSameOriginJson(request('{}', { 'content-type': 'application/json' }))
    ).rejects.toMatchObject({ code: 'origin_required', status: 403 });
    await expect(
      readSameOriginJson(
        request('{}', { origin: 'https://attacker.test', 'content-type': 'application/json' })
      )
    ).rejects.toMatchObject({ code: 'origin_mismatch', status: 403 });
    await expect(
      readSameOriginJson(
        request('{}', {
          origin: 'http://127.0.0.1:3000',
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site'
        })
      )
    ).rejects.toMatchObject({ code: 'cross_site', status: 403 });
  });

  test('SEC-02 rejects invalid content types, oversized bodies, and invalid JSON', async () => {
    await expect(
      readSameOriginJson(
        request('{}', { origin: 'http://127.0.0.1:3000', 'content-type': 'text/plain' })
      )
    ).rejects.toMatchObject({ code: 'invalid_content_type', status: 415 });
    await expect(
      readSameOriginJson(request('{"large":true}'), { maxBytes: 2 })
    ).rejects.toMatchObject({
      code: 'body_too_large',
      status: 413
    });
    await expect(readSameOriginJson(request('{broken'))).rejects.toBeInstanceOf(
      RequestSecurityError
    );
  });
});
