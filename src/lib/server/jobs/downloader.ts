import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { StructuredLogger } from '../diagnostics/jsonl-logger';
import { safeErrorSummary } from '../diagnostics/redaction';
import { syncDirectory } from '../media/filesystem-boundary';
import { aspectRatioLabel, readImageDimensionsFromFile } from '../media/image-dimensions';
import { assertSafeSvgFile, isSvgPrefix } from '../media/svg-output';
import { type AppPaths, resolvePathWithin } from '../platform/app-paths';
import {
  type DownloadHostResolver,
  requestPinnedDownload,
  resolveDownloadTarget
} from './download-egress';
import type { JobRepository } from './repository';
import type { OutputRecord, WorkClaim } from './types';

const extensions: Record<string, string> = {
  'image/svg+xml': '.svg',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/quicktime': '.mov'
};
const mediaKinds: Record<string, OutputRecord['mediaKind']> = {
  'image/svg+xml': 'image',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/x-matroska': 'video',
  'video/quicktime': 'video'
};
const genericTypes = new Set(['application/octet-stream', 'binary/octet-stream']);
const RECEIPT_MAX_BYTES = 4_096;
const RECEIPT_TEMP_STALE_MS = 5 * 60_000;
type ReceiptLogger = Pick<StructuredLogger, 'warn'>;

interface DownloadVerification {
  path: string;
  size: number;
  checksum: string;
  signature: string;
  contentType: string;
}

interface PublicationReceipt extends Omit<DownloadVerification, 'path'> {
  version: 1;
  outputId: string;
  fileName: string;
}

async function verifiedDimensions(
  output: OutputRecord,
  path: string
): Promise<{
  pixelWidth: number | null;
  pixelHeight: number | null;
  aspectRatio: string | null;
}> {
  if (output.mediaKind !== 'image') {
    return { pixelWidth: null, pixelHeight: null, aspectRatio: null };
  }
  const dimensions = await readImageDimensionsFromFile(path).catch(() => null);
  return {
    pixelWidth: dimensions?.width ?? null,
    pixelHeight: dimensions?.height ?? null,
    aspectRatio: dimensions ? aspectRatioLabel(dimensions.width, dimensions.height) : null
  };
}

function safeName(output: OutputRecord, contentType: string): string {
  const remote = output.remoteUrl ? basename(new URL(output.remoteUrl).pathname) : '';
  const clean = basename(remote, extname(remote))
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 80);
  const name = `${clean || `output-${output.outputOrder}`}${extensions[contentType]}`;
  return `${output.outputOrder}-${output.id.slice(0, 8)}-${name}`;
}
function signature(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

function collisionName(name: string): string {
  const extension = extname(name);
  return `${basename(name, extension)}-${crypto.randomUUID().slice(0, 8)}${extension}`;
}
function detectedContentType(bytes: Uint8Array): string | null {
  if (isSvgPrefix(bytes)) return 'image/svg+xml';
  const hex = signature(bytes);
  const ascii = new TextDecoder().decode(bytes.slice(0, 12));
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (
      [
        'isom',
        'iso2',
        'iso3',
        'iso4',
        'iso5',
        'iso6',
        'mp41',
        'mp42',
        'avc1',
        'dash',
        'M4V '
      ].includes(brand)
    )
      return 'video/mp4';
  }
  if (hex.startsWith('1a45dfa3')) return ebmlContentType(bytes);
  return null;
}

/** Read the EBML header's DocType instead of conflating Matroska with WebM. */
function ebmlContentType(bytes: Uint8Array): string | null {
  const integer = (offset: number): { value: number; width: number } | null => {
    const first = bytes[offset];
    if (first === undefined || first === 0) return null;
    let width = 1;
    let mask = 0x80;
    while (!(first & mask)) {
      width += 1;
      mask >>= 1;
    }
    if (width > 8 || offset + width > bytes.length) return null;
    let value = first & (mask - 1);
    for (let i = 1; i < width; i += 1) value = value * 256 + (bytes[offset + i] ?? 0);
    return Number.isSafeInteger(value) ? { value, width } : null;
  };
  const headerSize = integer(4);
  if (!headerSize) return null;
  const end = 4 + headerSize.width + headerSize.value;
  if (end > bytes.length) return null;
  let offset = 4 + headerSize.width;
  while (offset < end) {
    const first = bytes[offset];
    if (first === undefined || first === 0) return null;
    let idWidth = 1;
    let mask = 0x80;
    while (!(first & mask)) {
      idWidth += 1;
      mask >>= 1;
    }
    if (idWidth > 4 || offset + idWidth > end) return null;
    const docType = idWidth === 2 && first === 0x42 && bytes[offset + 1] === 0x82;
    const size = integer(offset + idWidth);
    if (!size) return null;
    const start = offset + idWidth + size.width;
    const next = start + size.value;
    if (next > end) return null;
    if (docType) {
      const type = new TextDecoder().decode(bytes.slice(start, next));
      return type === 'matroska' ? 'video/x-matroska' : type === 'webm' ? 'video/webm' : null;
    }
    offset = next;
  }
  return null;
}

function normalizedType(value: string | null): string | null {
  const type = value?.split(';', 1)[0]?.trim().toLowerCase();
  return type || null;
}

function verifiedContentType(
  output: OutputRecord,
  responseType: string | null,
  bytes: Uint8Array
): string {
  const metadataType = normalizedType(output.contentType);
  const headerType = normalizedType(responseType);
  for (const type of [metadataType, headerType]) {
    if (type && !genericTypes.has(type) && !mediaKinds[type]) {
      throw new Error('Remote output Content-Type is not supported media.');
    }
  }
  const detected = detectedContentType(bytes);
  if (!detected) throw new Error('Remote output did not contain a supported media signature.');
  if (mediaKinds[detected] !== output.mediaKind) {
    throw new Error('Remote output signature did not match the expected media kind.');
  }
  if (metadataType && !genericTypes.has(metadataType) && metadataType !== detected) {
    throw new Error('Remote output signature did not match Poyo media metadata.');
  }
  if (headerType && !genericTypes.has(headerType) && headerType !== detected) {
    throw new Error('Remote output signature did not match its Content-Type.');
  }
  return detected;
}

async function safeOutputDirectory(
  mediaRoot: string,
  jobId: string
): Promise<{
  root: string;
  directory: string;
}> {
  await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(mediaRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Media root may not be a symbolic link.');
  }
  const root = await realpath(mediaRoot);
  const directory = resolvePathWithin(root, jobId);
  const existing = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!existing) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Output directory may not be a symbolic link.');
  }
  resolvePathWithin(root, await realpath(directory));
  return { root, directory };
}

async function assertSafeDirectory(root: string, directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Output directory may not be a symbolic link.');
  }
  resolvePathWithin(root, await realpath(directory));
}

function receiptPath(directory: string, outputId: string): string {
  return resolvePathWithin(directory, `.${outputId}.published.json`);
}

function receiptTempName(outputId: string): string {
  return `.${outputId}.published.${crypto.randomUUID()}.tmp`;
}

function receiptQuarantinePath(directory: string, outputId: string): string {
  return resolvePathWithin(directory, `.${outputId}.receipt-quarantine.${crypto.randomUUID()}`);
}

function isReceiptTempName(name: string, outputId: string): boolean {
  const prefix = `.${outputId}.published.`;
  return (
    name.startsWith(prefix) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(
      name.slice(prefix.length)
    )
  );
}

async function logReceiptWarning(
  logger: ReceiptLogger | undefined,
  output: OutputRecord,
  data: Record<string, unknown>
): Promise<void> {
  await logger
    ?.warn('download.receipt.untrusted', {
      localJobId: output.jobId,
      data: { outputId: output.id, ...data }
    })
    .catch(() => undefined);
}

function isPublicationReceipt(value: unknown, output: OutputRecord): value is PublicationReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<PublicationReceipt>;
  const prefix = `${output.outputOrder}-${output.id.slice(0, 8)}-`;
  return (
    receipt.version === 1 &&
    receipt.outputId === output.id &&
    typeof receipt.fileName === 'string' &&
    receipt.fileName === basename(receipt.fileName) &&
    receipt.fileName.startsWith(prefix) &&
    typeof receipt.size === 'number' &&
    Number.isSafeInteger(receipt.size) &&
    receipt.size > 0 &&
    typeof receipt.checksum === 'string' &&
    /^[0-9a-f]{64}$/.test(receipt.checksum) &&
    typeof receipt.signature === 'string' &&
    /^[0-9a-f]{2,32}$/.test(receipt.signature) &&
    typeof receipt.contentType === 'string' &&
    mediaKinds[receipt.contentType] === output.mediaKind &&
    receipt.fileName.endsWith(extensions[receipt.contentType] ?? '\0')
  );
}

async function readReceipt(
  directory: string,
  output: OutputRecord,
  logger?: ReceiptLogger
): Promise<PublicationReceipt | null> {
  await cleanupReceiptTemps(directory, output, logger);
  const path = receiptPath(directory, output.id);
  const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!details) return null;
  if (details.isSymbolicLink()) {
    await removeUntrustedReceipt(directory, output, logger, 'symlink', path);
    return null;
  }
  if (!details.isFile()) {
    await removeUntrustedReceipt(directory, output, logger, 'not_regular_file', path);
    return null;
  }
  if (details.size <= 0) {
    await removeUntrustedReceipt(directory, output, logger, 'empty', path);
    return null;
  }
  if (details.size > RECEIPT_MAX_BYTES) {
    await removeUntrustedReceipt(directory, output, logger, 'too_large', path, {
      bytes: details.size,
      maxBytes: RECEIPT_MAX_BYTES
    });
    return null;
  }
  const canonical = await realpath(path).catch(async (error) => {
    await removeUntrustedReceipt(directory, output, logger, 'realpath_failed', path, {
      error: safeErrorSummary(error)
    });
    return null;
  });
  if (!canonical) return null;
  try {
    resolvePathWithin(directory, canonical);
  } catch (error) {
    await removeUntrustedReceipt(directory, output, logger, 'escaped_directory', path, {
      error: safeErrorSummary(error)
    });
    return null;
  }
  const canonicalDetails = await lstat(canonical).catch(async (error) => {
    await removeUntrustedReceipt(directory, output, logger, 'canonical_lstat_failed', path, {
      error: safeErrorSummary(error)
    });
    return null;
  });
  if (!canonicalDetails) return null;
  if (!canonicalDetails.isFile() || canonicalDetails.isSymbolicLink()) {
    await removeUntrustedReceipt(directory, output, logger, 'canonical_not_regular_file', path);
    return null;
  }
  let receiptHandle: Awaited<ReturnType<typeof open>> | null = null;
  const text = await (async () => {
    receiptHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return receiptHandle.readFile('utf8');
  })()
    .catch(async (error) => {
      await removeUntrustedReceipt(directory, output, logger, 'read_failed', path, {
        error: safeErrorSummary(error)
      });
      return null;
    })
    .finally(async () => {
      await receiptHandle?.close().catch(() => undefined);
    });
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    await removeUntrustedReceipt(directory, output, logger, 'malformed_json', path, {
      error: safeErrorSummary(error)
    });
    return null;
  }
  if (!isPublicationReceipt(value, output)) {
    await removeUntrustedReceipt(directory, output, logger, 'invalid_schema', path);
    return null;
  }
  return value;
}

async function removeUntrustedReceipt(
  directory: string,
  output: OutputRecord,
  logger: ReceiptLogger | undefined,
  reason: string,
  path: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  const name = basename(path);
  const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!details) {
    await logReceiptWarning(logger, output, {
      action: 'already_missing',
      reason,
      receipt: name,
      ...data
    });
    return;
  }
  if (!details.isFile() && !details.isSymbolicLink()) {
    const quarantine = receiptQuarantinePath(directory, output.id);
    await rename(path, quarantine);
    await syncDirectory(directory);
    await logReceiptWarning(logger, output, {
      action: 'quarantined',
      reason,
      receipt: name,
      quarantine: basename(quarantine),
      ...data
    });
    return;
  }
  await rm(path, { force: true });
  await syncDirectory(directory);
  await logReceiptWarning(logger, output, { action: 'removed', reason, receipt: name, ...data });
}

async function cleanupReceiptTemps(
  directory: string,
  output: OutputRecord,
  logger?: ReceiptLogger
): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  let removed = false;
  await Promise.all(
    names
      .filter((name) => isReceiptTempName(name, output.id))
      .map(async (name) => {
        const path = resolvePathWithin(directory, name);
        const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!details) return;
        if (!details.isFile() || details.isSymbolicLink()) {
          await logReceiptWarning(logger, output, {
            action: 'left_temp_in_place',
            reason: 'temp_not_regular_file',
            receipt: name
          });
          return;
        }
        if (Date.now() - details.mtimeMs <= RECEIPT_TEMP_STALE_MS) {
          return;
        }
        let handle: Awaited<ReturnType<typeof open>> | null = null;
        try {
          handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const opened = await handle.stat();
          if (
            !opened.isFile() ||
            opened.dev !== details.dev ||
            opened.ino !== details.ino ||
            Date.now() - opened.mtimeMs <= RECEIPT_TEMP_STALE_MS
          ) {
            await logReceiptWarning(logger, output, {
              action: 'left_temp_in_place',
              reason: 'temp_identity_changed',
              receipt: name
            });
            return;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          await logReceiptWarning(logger, output, {
            action: 'left_temp_in_place',
            reason: 'temp_no_follow_open_failed',
            receipt: name,
            error: safeErrorSummary(error)
          });
          return;
        } finally {
          await handle?.close().catch(() => undefined);
        }
        const rechecked = await lstat(path).catch(() => null);
        if (!rechecked || rechecked.dev !== details.dev || rechecked.ino !== details.ino) return;
        await rm(path);
        removed = true;
        await logReceiptWarning(logger, output, {
          action: 'removed_temp',
          reason: 'stale_interrupted_receipt_publication',
          receipt: name
        });
      })
  );
  if (removed) await syncDirectory(directory);
}

async function removeReceipt(directory: string, outputId: string): Promise<void> {
  const path = receiptPath(directory, outputId);
  const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!details) return;
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error('Published output receipt is not a safe regular file.');
  }
  await rm(path);
  await syncDirectory(directory);
}

async function writeReceipt(directory: string, receipt: PublicationReceipt): Promise<void> {
  const path = receiptPath(directory, receipt.outputId);
  const temporary = resolvePathWithin(directory, receiptTempName(receipt.outputId));
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporary, path);
    await rm(temporary, { force: true });
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function inspectPublishedFile(
  root: string,
  directory: string,
  output: OutputRecord,
  fileName: string,
  maxBytes: number
): Promise<DownloadVerification> {
  const path = resolvePathWithin(directory, fileName);
  const details = await lstat(path);
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size <= 0 ||
    details.size > maxBytes
  ) {
    throw new Error('Published output is not a safe bounded regular file.');
  }
  const canonical = await realpath(path);
  resolvePathWithin(root, canonical);
  const reader = Bun.file(canonical).stream().getReader();
  const hasher = new Bun.CryptoHasher('sha256');
  let total = 0;
  let prefix = new Uint8Array();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('Published output exceeds the local download limit.');
      if (prefix.length < 4096) {
        const needed = 4096 - prefix.length;
        const merged = new Uint8Array(prefix.length + Math.min(needed, value.length));
        merged.set(prefix);
        merged.set(value.slice(0, needed), prefix.length);
        prefix = merged;
      }
      hasher.update(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (total !== details.size) throw new Error('Published output size changed during inspection.');
  if (output.byteSize !== null && output.byteSize !== total) {
    throw new Error('Published output length did not match Poyo metadata.');
  }
  const contentType = verifiedContentType(output, null, prefix);
  if (contentType === 'image/svg+xml') await assertSafeSvgFile(canonical);
  return {
    path: canonical,
    size: total,
    checksum: hasher.digest('hex'),
    signature: signature(prefix),
    contentType
  };
}

function receiptFor(
  output: OutputRecord,
  fileName: string,
  verification: Omit<DownloadVerification, 'path'>
): PublicationReceipt {
  return { version: 1, outputId: output.id, fileName, ...verification };
}

function sameVerification(
  left: Omit<DownloadVerification, 'path'>,
  right: Omit<DownloadVerification, 'path'>
): boolean {
  return (
    left.size === right.size &&
    left.checksum === right.checksum &&
    left.signature === right.signature &&
    left.contentType === right.contentType
  );
}

async function publishOutput(
  root: string,
  directory: string,
  temporary: string,
  output: OutputRecord,
  verification: Omit<DownloadVerification, 'path'>,
  maxBytes: number,
  logger?: ReceiptLogger
): Promise<DownloadVerification> {
  let fileName = safeName(output, verification.contentType);
  for (let collision = 0; collision < 8; collision += 1) {
    await assertSafeDirectory(root, directory);
    const destination = resolvePathWithin(directory, fileName);
    let linked = false;
    let receiptWritten = false;
    try {
      await writeReceipt(directory, receiptFor(output, fileName, verification));
      receiptWritten = true;
      await link(temporary, destination);
      linked = true;
      await syncDirectory(directory);
      return { path: destination, ...verification };
    } catch (error) {
      // If publication succeeded but the directory sync reported an error, retain the already
      // durable receipt. Recovery will verify either the linked file or its absence safely.
      if (linked) throw error;
      if (receiptWritten) await removeReceipt(directory, output.id).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!receiptWritten) {
        const receipt = await readReceipt(directory, output, logger);
        if (!receipt) continue;
        const recovered = await inspectPublishedFile(
          root,
          directory,
          output,
          receipt.fileName,
          maxBytes
        ).catch(() => null);
        if (recovered && sameVerification(recovered, verification)) return recovered;
        await removeReceipt(directory, output.id).catch(() => undefined);
        continue;
      }
      const details = await lstat(destination);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new Error('Output destination already exists and is not a safe regular file.');
      }
      const existing = await inspectPublishedFile(
        root,
        directory,
        output,
        fileName,
        maxBytes
      ).catch(() => null);
      if (existing && sameVerification(existing, verification)) {
        await writeReceipt(directory, receiptFor(output, fileName, verification)).catch(
          (writeError) => {
            if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
          }
        );
        return existing;
      }
      fileName = collisionName(safeName(output, verification.contentType));
    }
  }
  throw new Error('A collision-safe output destination could not be created.');
}

function abortedReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Remote output download was aborted.');
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortedReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortedReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

function readWithIdleDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal: AbortSignal
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  if (signal.aborted) return Promise.reject(abortedReason(signal));
  return new Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Remote output body idle deadline exceeded.')),
        idleTimeoutMs
      );
      timer.unref();
      const abort = () => reject(abortedReason(signal));
      signal.addEventListener('abort', abort, { once: true });
      reader.read().then(
        (result) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(error);
        }
      );
    }
  );
}

export interface OutputDownloaderOptions {
  repository: JobRepository;
  paths: Pick<AppPaths, 'media' | 'temporary'>;
  logger?: ReceiptLogger;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  resolveHost?: DownloadHostResolver;
  maxBytes?: number;
  connectTimeoutMs?: number;
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  afterPublish?: (publication: { outputId: string; path: string }) => void | Promise<void>;
}
export interface OutputDownloadExecution {
  signal?: AbortSignal;
  workClaim?: WorkClaim;
}
export class OutputDownloader {
  private readonly fetcher;
  private readonly maxBytes: number;
  private readonly connectTimeoutMs: number;
  private readonly headerTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  constructor(private readonly options: OutputDownloaderOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
    this.connectTimeoutMs = positiveDuration(options.connectTimeoutMs, 30_000);
    this.headerTimeoutMs = positiveDuration(options.headerTimeoutMs, 30_000);
    this.idleTimeoutMs = positiveDuration(options.idleTimeoutMs, 30_000);
    this.totalTimeoutMs = positiveDuration(options.totalTimeoutMs, 30 * 60_000);
  }
  async download(outputId: string, execution: OutputDownloadExecution = {}): Promise<OutputRecord> {
    const output = this.options.repository.output(outputId);
    if (!output?.remoteUrl) throw new Error('Download output is unavailable.');
    if (execution.signal?.aborted) throw abortedReason(execution.signal);
    const attempt = this.options.repository.startDownload(outputId);
    const abortController = new AbortController();
    const abortFromLease = () => {
      if (!abortController.signal.aborted && execution.signal?.aborted) {
        abortController.abort(abortedReason(execution.signal));
      }
    };
    execution.signal?.addEventListener('abort', abortFromLease, { once: true });
    abortFromLease();
    const totalTimer = setTimeout(
      () => abortController.abort(new Error('Remote output total deadline exceeded.')),
      this.totalTimeoutMs
    );
    totalTimer.unref();
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let temporary: string | null = null;
    try {
      const { root, directory } = await safeOutputDirectory(this.options.paths.media, output.jobId);
      const receipt = await readReceipt(directory, output, this.options.logger);
      if (receipt) {
        const recovered = await inspectPublishedFile(
          root,
          directory,
          output,
          receipt.fileName,
          this.maxBytes
        ).catch(() => null);
        if (recovered && sameVerification(recovered, receipt)) {
          const dimensions = await verifiedDimensions(output, recovered.path);
          if (
            !this.options.repository.verifyDownload(
              outputId,
              attempt,
              { ...recovered, ...dimensions },
              execution.workClaim
            )
          ) {
            throw new Error('Download work lease ownership was lost.');
          }
          await removeReceipt(directory, output.id).catch(() => undefined);
          const verified = this.options.repository.output(outputId);
          if (!verified) throw new Error('Recovered output was not found.');
          return verified;
        }
        await removeReceipt(directory, output.id);
      }
      temporary = resolvePathWithin(directory, `.${output.id}.${crypto.randomUUID()}.partial`);
      await assertSafeDirectory(root, directory);
      const target = await withAbort(
        resolveDownloadTarget(output.remoteUrl, this.options.resolveHost),
        abortController.signal
      );
      const response = await withAbort(
        this.options.fetch
          ? this.fetcher(target.url, {
              redirect: 'manual',
              signal: abortController.signal
            })
          : requestPinnedDownload(target, {
              signal: abortController.signal,
              connectTimeoutMs: this.connectTimeoutMs,
              headerTimeoutMs: this.headerTimeoutMs
            }),
        abortController.signal
      );
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Remote output redirects are not allowed.');
      }
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel().catch(() => undefined);
        throw Object.assign(new Error('Remote output has expired.'), { expired: true });
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Remote download failed with HTTP ${response.status}.`);
      }
      const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
      if (contentEncoding && contentEncoding !== 'identity') {
        await response.body.cancel().catch(() => undefined);
        throw new Error('Remote output content encoding is not supported.');
      }
      const declaredHeader = response.headers.get('content-length');
      const declared = declaredHeader === null ? null : Number(declaredHeader);
      if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) {
        await response.body.cancel().catch(() => undefined);
        throw new Error('Remote output Content-Length was invalid.');
      }
      if (declared !== null && Number.isFinite(declared) && declared > this.maxBytes)
        throw new Error('Remote output exceeds the local download limit.');
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600
      );
      reader = response.body.getReader();
      const hasher = new Bun.CryptoHasher('sha256');
      let total = 0;
      let prefix = new Uint8Array();
      while (true) {
        const { done, value } = await readWithIdleDeadline(
          reader,
          this.idleTimeoutMs,
          abortController.signal
        );
        if (done) break;
        total += value.byteLength;
        if (total > this.maxBytes)
          throw new Error('Remote output exceeds the local download limit.');
        if (prefix.length < 4096) {
          const needed = 4096 - prefix.length;
          const merged = new Uint8Array(prefix.length + Math.min(needed, value.length));
          merged.set(prefix);
          merged.set(value.slice(0, needed), prefix.length);
          prefix = merged;
        }
        hasher.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
          if (bytesWritten <= 0) throw new Error('Remote output could not be written completely.');
          offset += bytesWritten;
        }
      }
      if (total === 0) throw new Error('Remote output was empty.');
      if (declared !== null && Number.isFinite(declared) && declared >= 0 && declared !== total)
        throw new Error('Remote output length did not match Content-Length.');
      if (output.byteSize !== null && output.byteSize !== total)
        throw new Error('Remote output length did not match Poyo metadata.');
      const contentType = verifiedContentType(output, response.headers.get('content-type'), prefix);
      const verification = {
        size: total,
        checksum: hasher.digest('hex'),
        signature: signature(prefix),
        contentType
      };
      await handle.sync();
      await handle.close();
      handle = null;
      if (contentType === 'image/svg+xml') await assertSafeSvgFile(temporary);
      if (execution.workClaim && !this.options.repository.ownsWork(execution.workClaim)) {
        throw new Error('Download work lease ownership was lost.');
      }
      if (abortController.signal.aborted) throw abortedReason(abortController.signal);
      await assertSafeDirectory(root, directory);
      const published = await publishOutput(
        root,
        directory,
        temporary,
        output,
        verification,
        this.maxBytes,
        this.options.logger
      );
      await rm(temporary);
      temporary = null;
      await this.options.afterPublish?.({ outputId, path: published.path });
      const dimensions = await verifiedDimensions(output, published.path);
      if (
        !this.options.repository.verifyDownload(
          outputId,
          attempt,
          { ...published, ...dimensions },
          execution.workClaim
        )
      ) {
        throw new Error('Download work lease ownership was lost.');
      }
      await removeReceipt(directory, output.id).catch(() => undefined);
      const verified = this.options.repository.output(outputId);
      if (!verified) throw new Error('Verified output was not found.');
      return verified;
    } catch (error) {
      if (!abortController.signal.aborted) abortController.abort(error);
      const failure = abortController.signal.aborted
        ? abortedReason(abortController.signal)
        : error;
      await reader?.cancel().catch(() => undefined);
      await handle?.close().catch(() => undefined);
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      this.options.repository.failDownload(
        outputId,
        attempt,
        safeErrorSummary(failure),
        (failure as { expired?: boolean }).expired === true,
        execution.workClaim
      );
      throw failure;
    } finally {
      clearTimeout(totalTimer);
      execution.signal?.removeEventListener('abort', abortFromLease);
    }
  }
}
