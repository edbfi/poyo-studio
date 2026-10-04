import { describe, expect, test } from 'bun:test';

describe('Jobs event route resume cursor', () => {
  test('uses the query cursor unless the SSE header is present', () => {
    const script = `
      import { mock } from 'bun:test';
      const cursors = [];
      mock.module('#lib/server/jobs/events.js', () => ({
        createJobEventStream: (_repository, lastEventId) => {
          cursors.push(lastEventId);
          return new ReadableStream({
            start(controller) {
              controller.close();
            }
          });
        }
      }));
      mock.module('#lib/server/jobs/runtime.js', () => ({
        getJobRuntime: async () => ({ repository: {} })
      }));
      const { GET } = await import('./src/routes/api/events/jobs/+server.ts');
      await GET({
        request: new Request('http://127.0.0.1/api/events/jobs?lastEventId=0')
      });
      await GET({
        request: new Request('http://127.0.0.1/api/events/jobs?lastEventId=0', {
          headers: { 'Last-Event-ID': '7' }
        })
      });
      console.log(JSON.stringify(cursors));
    `;
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe'
    });

    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual(['0', '7']);
  });
});
