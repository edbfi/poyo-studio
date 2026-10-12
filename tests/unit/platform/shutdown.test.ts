import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  SHUTDOWN_SIGNALS,
  type ShutdownSignalSource,
  stopOnShutdownSignal
} from '../../../src/lib/server/platform/shutdown';

function signalSource() {
  const emitter = new EventEmitter();
  return { emitter, source: emitter as unknown as ShutdownSignalSource };
}

describe('stopOnShutdownSignal', () => {
  for (const signal of SHUTDOWN_SIGNALS) {
    test(`${signal} stops the workers once and removes every listener`, async () => {
      const { emitter, source } = signalSource();
      let stops = 0;
      stopOnShutdownSignal(async () => {
        stops += 1;
      }, source);

      emitter.emit(signal);
      for (const second of SHUTDOWN_SIGNALS) emitter.emit(second);

      expect(stops).toBe(1);
      for (const listened of SHUTDOWN_SIGNALS) expect(emitter.listenerCount(listened)).toBe(0);
    });
  }

  test('a failing stop never becomes an unhandled rejection', async () => {
    const { emitter, source } = signalSource();
    let settled = false;
    stopOnShutdownSignal(async () => {
      await Bun.sleep(1);
      settled = true;
      throw new Error('drain failed');
    }, source);
    emitter.emit('SIGTERM');
    await Bun.sleep(10);
    expect(settled).toBe(true);
  });

  test('the returned function removes the listeners without stopping', () => {
    const { emitter, source } = signalSource();
    let stops = 0;
    const remove = stopOnShutdownSignal(async () => {
      stops += 1;
    }, source);
    remove();
    emitter.emit('SIGTERM');
    expect(stops).toBe(0);
    for (const signal of SHUTDOWN_SIGNALS) expect(emitter.listenerCount(signal)).toBe(0);
  });
});
