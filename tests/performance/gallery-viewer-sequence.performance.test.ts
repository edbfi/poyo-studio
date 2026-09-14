import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { join } from 'node:path';
import type { LibraryFiltersDto } from '../../src/lib/features/library/contracts';
import {
  buildViewerSequenceQueryPlan,
  LibraryRepository,
  type ViewerSequenceQueryObservation
} from '../../src/lib/server/library/repository';
import { createViewerSequenceHandler } from '../../src/lib/server/library/viewer-sequence-handler';
import { openDatabase } from '../../src/lib/server/platform/database';
import { createTemporaryDirectory } from '../helpers/temporary-directory';

setDefaultTimeout(120_000);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

const unfiltered: Omit<LibraryFiltersDto, 'cursor' | 'view'> = {
  q: '',
  mediaKind: '',
  model: '',
  provider: '',
  workflow: '',
  aspectRatio: '',
  status: 'all',
  favorite: false,
  tag: '',
  dateFrom: '',
  dateTo: ''
};
const combined: typeof unfiltered = {
  ...unfiltered,
  mediaKind: 'image',
  provider: 'Black Forest Labs',
  favorite: true,
  tag: 'performance',
  dateFrom: '2026-01-01',
  dateTo: '2026-01-01'
};
const tokenContext = {
  secret: new TextEncoder().encode('gallery-performance-secret'),
  nonce: 'gallery-performance'
};

type StatementMetrics = { run: number; nscan: number; nsort: number; naidx: number; nstep: number };
type Walk = { items: number; pages: number; bytes: number };

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function mad(samples: number[]): number {
  const center = median(samples);
  return median(samples.map((sample) => Math.abs(sample - center)));
}

async function fixture(jobCount: number) {
  const temporary = await createTemporaryDirectory(`gallery-sequence-${jobCount}-`);
  cleanups.push(temporary.cleanup);
  const database = await openDatabase(join(temporary.path, 'studio.sqlite'));
  const insertJob = database.query(
    `INSERT INTO jobs(id,workflow,public_model_id,local_phase,remote_status,failure_domain,guided_request_json,actual_payload_json,prompt_text,search_text,correlation_id,created_at,updated_at,completed_at) VALUES (?,?,?,'complete','finished','none',?,?,?,?,?,?,?,?)`
  );
  const insertOutput = database.query(
    `INSERT INTO job_outputs(id,job_id,output_order,media_kind,remote_url,local_path,content_type,byte_size,download_state,favorite,pinned,created_at,verified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertTag = database.query(
    "INSERT INTO tags(normalized_name,display_name,created_at) VALUES ('performance','Performance',?)"
  );
  const insertJobTag = database.query('INSERT INTO job_tags(job_id,tag_id) VALUES (?,?)');
  database.transaction(() => {
    const tagId = Number(insertTag.run('2026-01-01T00:00:00.000Z').lastInsertRowid);
    let outputIndex = 0;
    for (let index = 0; index < jobCount; index += 1) {
      const id = `gallery-job-${index.toString().padStart(6, '0')}`;
      const createdAt = new Date(Date.UTC(2026, 0, 1) + Math.floor(index / 2) * 1000).toISOString();
      const image = index % 2 === 0;
      const workflow = image ? 'text-to-image' : 'image-to-video';
      const model = image ? 'flux-schnell' : 'grok-imagine-video-1.5';
      insertJob.run(
        id,
        workflow,
        model,
        JSON.stringify({ aspectRatio: image ? '16:9' : '720p' }),
        '{}',
        `gallery ${index}`,
        `gallery ${index}`,
        `gallery-${index}`,
        createdAt,
        createdAt,
        createdAt
      );
      if (image) insertJobTag.run(id, tagId);
      for (let order = 0; order < (image ? 3 : 2); order += 1) {
        const verified = order !== 2;
        insertOutput.run(
          `gallery-output-${outputIndex++}`,
          id,
          order,
          image ? 'image' : 'video',
          `https://example.test/${outputIndex}`,
          verified ? `/media/${id}/${order}` : null,
          image ? 'image/png' : 'video/mp4',
          1024,
          verified ? 'verified' : 'deleted',
          image && order === 0 ? 1 : 0,
          0,
          createdAt,
          verified ? createdAt : null
        );
      }
    }
    expect(outputIndex).toBe(jobCount * 2.5);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM job_tags').get()?.count
    ).toBe(jobCount / 2);
  })();
  return database;
}

function assertWalk(
  observations: ViewerSequenceQueryObservation[],
  expectedItems: number,
  expectedPages: number
): void {
  const counts = observations.filter((entry) => entry.operation === 'count');
  expect(counts).toHaveLength(2);
  expect(counts.every((entry) => entry.diagnostics?.[0] === String(expectedItems))).toBe(true);
  expect(observations.filter((entry) => entry.operation === 'page-seek')).toHaveLength(
    expectedPages
  );
  expect(observations.filter((entry) => entry.operation === 'page-hydrate')).toHaveLength(
    expectedPages
  );
  expect(
    observations.filter((entry) => entry.operation === 'page-seek' && entry.phase === 'initial')
  ).toHaveLength(1);
  expect(
    observations.filter(
      (entry) => entry.operation === 'page-seek' && entry.phase === 'intermediate'
    )
  ).toHaveLength(expectedPages - 1);
  expect(
    observations
      .filter((entry) => entry.operation === 'page-hydrate')
      .every((entry) => entry.rows > 0 && entry.rows <= 100)
  ).toBe(true);
  expect(expectedItems).toBe(expectedPages * 100);
}

function walkRepository(
  repository: LibraryRepository,
  activeFilters: typeof unfiltered,
  observations: ViewerSequenceQueryObservation[]
): Walk {
  let cursor: string | null = null;
  let snapshot: string | null = null;
  let items = 0;
  let pages = 0;
  let terminalTotal: number | null = null;
  do {
    const page = repository.listViewerSequence(
      activeFilters,
      cursor,
      snapshot,
      100,
      tokenContext,
      (entry) => observations.push(entry)
    );
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThanOrEqual(100);
    items += page.items.length;
    pages += 1;
    cursor = page.nextCursor;
    snapshot = page.snapshot;
    terminalTotal = page.total ?? terminalTotal;
  } while (cursor);
  expect(terminalTotal).toBe(items);
  return { items, pages, bytes: 0 };
}

function applyFilters(url: URL, activeFilters: typeof unfiltered): void {
  if (activeFilters.mediaKind) url.searchParams.set('mediaKind', activeFilters.mediaKind);
  if (activeFilters.provider) url.searchParams.set('provider', activeFilters.provider);
  if (activeFilters.favorite) url.searchParams.set('favorite', 'true');
  if (activeFilters.tag) url.searchParams.set('tag', activeFilters.tag);
  if (activeFilters.dateFrom) url.searchParams.set('dateFrom', activeFilters.dateFrom);
  if (activeFilters.dateTo) url.searchParams.set('dateTo', activeFilters.dateTo);
}

async function walkHandler(
  handler: ReturnType<typeof createViewerSequenceHandler>,
  activeFilters: typeof unfiltered
): Promise<Walk> {
  let cursor = '';
  let snapshot = '';
  let items = 0;
  let pages = 0;
  let bytes = 0;
  do {
    const url = new URL('https://studio.test/api/library/viewer-sequence');
    url.searchParams.set('limit', '100');
    applyFilters(url, activeFilters);
    if (cursor) {
      url.searchParams.set('cursor', cursor);
      url.searchParams.set('snapshot', snapshot);
    }
    const response = await handler({ request: new Request(url), url });
    expect(response.status).toBe(200);
    const body = await response.text();
    bytes += Buffer.byteLength(body);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(256 * 1024);
    const page = JSON.parse(body) as {
      items: unknown[];
      nextCursor: string | null;
      snapshot: string;
      total: number | null;
    };
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThanOrEqual(100);
    items += page.items.length;
    pages += 1;
    cursor = page.nextCursor ?? '';
    snapshot = page.snapshot;
    if (!cursor) expect(page.total).toBe(items);
  } while (cursor);
  return { items, pages, bytes };
}

function subtract(after: StatementMetrics, before: StatementMetrics): StatementMetrics {
  return {
    run: after.run - before.run,
    nscan: after.nscan - before.nscan,
    nsort: after.nsort - before.nsort,
    naidx: after.naidx - before.naidx,
    nstep: after.nstep - before.nstep
  };
}

describe('PERF gallery viewer indexed full-history sequence', () => {
  test('walks the shipped query at 5k and 10k for unfiltered and combined filters', async () => {
    const results = new Map<
      string,
      { direct: number[]; api: number[]; nscan: number[]; nstep: number[]; bytes: number }
    >();
    for (const scale of [5_000, 10_000]) {
      const database = await fixture(scale);
      try {
        type PlanRow = { id: number; parent: number; detail: string };
        const explain = (sql: string, bindings: readonly (number | string | null)[]) =>
          database
            .query<PlanRow, (number | string | null)[]>(`EXPLAIN QUERY PLAN ${sql}`)
            .all(...bindings);
        const compileOptions = database
          .query<{ compile_options: string }, []>('PRAGMA compile_options')
          .all()
          .map((row) => row.compile_options);
        const statementColumns = database
          .query<{ name: string }, []>('PRAGMA table_info(sqlite_stmt)')
          .all()
          .map((row) => row.name);
        const statementCountersAvailable = ['run', 'nscan', 'nsort', 'naidx', 'nstep'].every(
          (column) => statementColumns.includes(column)
        );
        if (!statementCountersAvailable) expect(compileOptions).not.toContain('ENABLE_STMTVTAB');
        const statementMetrics = (): StatementMetrics =>
          database
            .query<StatementMetrics, []>(
              `SELECT COALESCE(SUM(run),0) run,COALESCE(SUM(nscan),0) nscan,
                      COALESCE(SUM(nsort),0) nsort,COALESCE(SUM(naidx),0) naidx,
                      COALESCE(SUM(nstep),0) nstep
                 FROM sqlite_stmt
                WHERE sql LIKE '%FROM jobs AS j INDEXED BY idx_jobs_gallery_order%'`
            )
            .get() ?? { run: 0, nscan: 0, nsort: 0, naidx: 0, nstep: 0 };
        for (const [name, activeFilters, expectedItems] of [
          ['unfiltered', unfiltered, scale],
          ['combined', combined, scale / 2]
        ] as const) {
          const repository = new LibraryRepository(database);
          const initialPlan = buildViewerSequenceQueryPlan(activeFilters, null);
          expect(initialPlan).not.toBeNull();
          const initialPage = repository.listViewerSequence(
            activeFilters,
            null,
            null,
            100,
            tokenContext
          );
          const continuationPlan = buildViewerSequenceQueryPlan(
            activeFilters,
            initialPage.nextCursor
          );
          expect(continuationPlan).not.toBeNull();
          for (const plan of [initialPlan, continuationPlan]) {
            if (!plan) throw new Error('Expected production viewer sequence query plan.');
            const details = explain(plan.pageSeekSql, [...plan.pageSeekBindings, 101])
              .map((row) => row.detail)
              .join('\n');
            expect(details).toContain('idx_jobs_gallery_order');
            expect(details).not.toContain('USING AUTOMATIC');
            expect(details).not.toContain('USE TEMP B-TREE');
          }

          const expectedPages = expectedItems / 100;
          const directWarmObservations: ViewerSequenceQueryObservation[] = [];
          expect(walkRepository(repository, activeFilters, directWarmObservations)).toMatchObject({
            items: expectedItems,
            pages: expectedPages
          });
          assertWalk(directWarmObservations, expectedItems, expectedPages);

          let inFlight = 0;
          let maxInFlight = 0;
          const handlerObservations: ViewerSequenceQueryObservation[] = [];
          const handler = createViewerSequenceHandler({
            resolveDatabase: () => {
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              return Promise.resolve(database).finally(() => {
                inFlight -= 1;
              });
            },
            tokenContext,
            queryObserver: (entry) => handlerObservations.push(entry)
          });
          const apiWarm = await walkHandler(handler, activeFilters);
          expect(apiWarm).toMatchObject({ items: expectedItems, pages: expectedPages });
          expect(apiWarm.bytes).toBeGreaterThan(0);
          expect(maxInFlight).toBe(1);
          assertWalk(handlerObservations, expectedItems, expectedPages);

          const direct: number[] = [];
          const api: number[] = [];
          const nscan: number[] = [];
          const nstep: number[] = [];
          for (let sample = 0; sample < 7; sample += 1) {
            const directObservations: ViewerSequenceQueryObservation[] = [];
            const beforeDirect = statementCountersAvailable
              ? statementMetrics()
              : { run: 0, nscan: 0, nsort: 0, naidx: 0, nstep: 0 };
            const startedDirect = performance.now();
            const directWalk = walkRepository(repository, activeFilters, directObservations);
            direct.push(performance.now() - startedDirect);
            expect(directWalk).toMatchObject({ items: expectedItems, pages: expectedPages });
            assertWalk(directObservations, expectedItems, expectedPages);
            if (statementCountersAvailable) {
              const delta = subtract(statementMetrics(), beforeDirect);
              expect(delta.run).toBeGreaterThanOrEqual(expectedPages);
              expect(delta.nsort).toBe(0);
              expect(delta.naidx).toBe(0);
              expect(delta.nscan).toBeLessThan(expectedItems * 20);
              expect(delta.nstep).toBeGreaterThan(0);
              nscan.push(delta.nscan);
              nstep.push(delta.nstep);
            }

            const apiObservationsBefore = handlerObservations.length;
            const beforeApi = statementCountersAvailable
              ? statementMetrics()
              : { run: 0, nscan: 0, nsort: 0, naidx: 0, nstep: 0 };
            const startedApi = performance.now();
            const apiWalk = await walkHandler(handler, activeFilters);
            api.push(performance.now() - startedApi);
            expect(apiWalk).toMatchObject({ items: expectedItems, pages: expectedPages });
            expect(apiWalk.bytes).toBeGreaterThan(0);
            expect(maxInFlight).toBe(1);
            assertWalk(
              handlerObservations.slice(apiObservationsBefore),
              expectedItems,
              expectedPages
            );
            if (statementCountersAvailable) {
              const delta = subtract(statementMetrics(), beforeApi);
              expect(delta.run).toBeGreaterThanOrEqual(expectedPages);
              expect(delta.nsort).toBe(0);
              expect(delta.naidx).toBe(0);
              expect(delta.nscan).toBeLessThan(expectedItems * 20);
              expect(delta.nstep).toBeGreaterThan(0);
              nscan.push(delta.nscan);
              nstep.push(delta.nstep);
            }
          }
          expect(direct).toHaveLength(7);
          expect(api).toHaveLength(7);
          expect(Number.isFinite(mad(direct))).toBe(true);
          expect(Number.isFinite(mad(api))).toBe(true);
          expect(median(direct)).toBeLessThan(5_000);
          expect(median(api)).toBeLessThan(8_000);
          results.set(`${scale}:${name}`, { direct, api, nscan, nstep, bytes: apiWarm.bytes });
        }
      } finally {
        database.close();
      }
    }
    for (const name of ['unfiltered', 'combined']) {
      const small = results.get(`5000:${name}`);
      const large = results.get(`10000:${name}`);
      if (!small || !large) throw new Error(`Missing ${name} performance results.`);
      expect(median(large.direct)).toBeLessThan(median(small.direct) * 3);
      expect(median(large.api)).toBeLessThan(median(small.api) * 3);
      expect(large.bytes).toBeLessThanOrEqual(small.bytes * 3);
      if (small.nscan.length && large.nscan.length)
        expect(median(large.nscan)).toBeLessThan(median(small.nscan) * 3);
      if (small.nstep.length && large.nstep.length)
        expect(median(large.nstep)).toBeLessThan(median(small.nstep) * 3);
    }
  });
});
