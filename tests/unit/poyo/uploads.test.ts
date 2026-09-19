import { describe, expect, test } from 'bun:test';
import {
  buildBase64UploadBody,
  buildStreamUploadBody,
  buildUrlUploadBody,
  POYO_BASE64_RECOMMENDED_MAX_BYTES,
  POYO_STREAM_VIDEO_MAX_BYTES,
  selectUploadMethod
} from '../../../src/lib/server/poyo/uploads';

describe('Poyo upload validation and selection', () => {
  test('UP-01 selects URL, explicit small base64, and stream without converting local files', () => {
    expect(
      selectUploadMethod({ kind: 'remote-url', url: 'https://assets.example/source.png' })
    ).toBe('url');
    expect(selectUploadMethod({ kind: 'base64', data: 'AQIDBA==' })).toBe('base64');
    expect(
      selectUploadMethod({
        kind: 'local-file',
        file: new Blob(['image'], { type: 'image/png' }),
        mimeType: 'image/png',
        sizeBytes: 5,
        mediaKind: 'image',
        fileName: 'source.png'
      })
    ).toBe('stream');
  });

  test('UP-02 builds documented snake-case fields and multipart metadata', () => {
    expect(
      buildUrlUploadBody({
        kind: 'remote-url',
        url: 'https://assets.example/source.png',
        uploadPath: 'references/images',
        fileName: 'source.png'
      })
    ).toEqual({
      file_url: 'https://assets.example/source.png',
      upload_path: 'references/images',
      file_name: 'source.png'
    });
    expect(buildBase64UploadBody({ kind: 'base64', data: 'AQIDBA==' })).toEqual({
      base64_data: 'AQIDBA=='
    });
    const form = buildStreamUploadBody({
      kind: 'local-file',
      file: new Blob(['video'], { type: 'video/mp4' }),
      mimeType: 'video/mp4',
      sizeBytes: 5,
      mediaKind: 'video',
      uploadPath: 'videos',
      fileName: 'motion.mp4'
    });
    expect(form.get('upload_path')).toBe('videos');
    expect(form.get('file_name')).toBe('motion.mp4');
    expect(form.get('file')).toBeInstanceOf(File);
  });

  test('UP-03 rejects private URLs, traversal, bad formats, oversized base64, and videos over 100MB', () => {
    expect(() => selectUploadMethod({ kind: 'remote-url', url: 'http://127.0.0.1/a.png' })).toThrow(
      'public HTTP(S)'
    );
    expect(() =>
      selectUploadMethod({
        kind: 'remote-url',
        url: 'https://assets.example/a.png',
        uploadPath: '../private'
      })
    ).toThrow('unsafe');
    expect(() =>
      selectUploadMethod({ kind: 'base64', data: 'AQIDBA==', mimeType: 'application/pdf' })
    ).toThrow('images only');
    expect(() =>
      selectUploadMethod({
        kind: 'base64',
        data: 'AQIDBA==',
        sizeBytes: POYO_BASE64_RECOMMENDED_MAX_BYTES + 1
      })
    ).toThrow('streaming');
    const blob = {
      size: POYO_STREAM_VIDEO_MAX_BYTES + 1,
      type: 'video/mp4'
    } as Blob;
    expect(() =>
      selectUploadMethod({
        kind: 'local-file',
        file: blob,
        mimeType: 'video/mp4',
        sizeBytes: POYO_STREAM_VIDEO_MAX_BYTES + 1,
        mediaKind: 'video'
      })
    ).toThrow('100 MB');
  });
});
