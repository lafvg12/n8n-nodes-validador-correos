/**
 * Caché con TTL y coalescencia.
 *
 * Se prueba aparte porque es la pieza de la que depende el test de
 * concurrencia, y porque antes estaba escrita dos veces a mano con
 * diferencias sutiles entre ambas copias.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AsyncCache, SerialQueue } from '../nodes/ValidadorCorreos/core/cache';

/** Reloj manipulable: probar TTL con esperas reales sería lento y frágil. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
	let current = start;
	return {
		now: () => current,
		advance: (ms: number) => {
			current += ms;
		},
	};
}

describe('AsyncCache', () => {
	it('llama al cargador una vez y luego sirve de caché', async () => {
		const cache = new AsyncCache<number>(1000);
		let calls = 0;
		const load = async () => {
			calls++;
			return { value: 42, cacheable: true };
		};

		const first = await cache.fetch('k', load);
		const second = await cache.fetch('k', load);

		assert.equal(first.value, 42);
		assert.equal(first.cached, false);
		assert.equal(second.cached, true);
		assert.equal(calls, 1);
	});

	it('vuelve a cargar cuando expira el TTL', async () => {
		const clock = fakeClock();
		const cache = new AsyncCache<number>(1000, clock.now);
		let calls = 0;
		const load = async () => {
			calls++;
			return { value: calls, cacheable: true };
		};

		await cache.fetch('k', load);
		clock.advance(999);
		await cache.fetch('k', load);
		assert.equal(calls, 1, 'dentro del TTL no debería recargar');

		clock.advance(2);
		await cache.fetch('k', load);
		assert.equal(calls, 2, 'pasado el TTL debería recargar');
	});

	it('coalesce peticiones concurrentes de la misma clave', async () => {
		const cache = new AsyncCache<number>(1000);
		let calls = 0;
		const load = async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 20));
			return { value: 7, cacheable: true };
		};

		const results = await Promise.all(
			Array.from({ length: 50 }, async () => await cache.fetch('k', load)),
		);

		assert.equal(calls, 1, 'las 50 deberían compartir una sola carga');
		assert.ok(results.every((r) => r.value === 7));
		assert.equal(results.filter((r) => !r.cached).length, 1, 'solo una cuenta como no cacheada');
	});

	it('no guarda lo que se marca como no cacheable', async () => {
		const cache = new AsyncCache<string>(1000);
		let calls = 0;
		const load = async () => {
			calls++;
			return { value: 'fallo', cacheable: false };
		};

		await cache.fetch('k', load);
		await cache.fetch('k', load);
		assert.equal(calls, 2, 'un fallo temporal debe reintentarse');
		assert.equal(cache.size, 0);
	});

	it('claves distintas no se pisan', async () => {
		const cache = new AsyncCache<string>(1000);
		await cache.fetch('a', async () => ({ value: 'A', cacheable: true }));
		const b = await cache.fetch('b', async () => ({ value: 'B', cacheable: true }));
		const a = await cache.fetch('a', async () => ({ value: 'otro', cacheable: true }));

		assert.equal(b.value, 'B');
		assert.equal(a.value, 'A');
	});

	it('libera la petición en vuelo aunque el cargador falle', async () => {
		const cache = new AsyncCache<number>(1000);
		await assert.rejects(
			cache.fetch('k', async () => {
				throw new Error('boom');
			}),
		);
		// Si el mapa de peticiones en vuelo quedara sucio, esta se colgaría.
		const ok = await cache.fetch('k', async () => ({ value: 1, cacheable: true }));
		assert.equal(ok.value, 1);
	});
});

describe('SerialQueue', () => {
	it('ejecuta las tareas de a una, en orden', async () => {
		const queue = new SerialQueue(0, async () => {});
		const order: number[] = [];

		await Promise.all(
			[3, 1, 2].map((n, i) =>
				queue.run(async () => {
					await new Promise((r) => setTimeout(r, n));
					order.push(i);
				}),
			),
		);

		assert.deepEqual(order, [0, 1, 2], 'debe respetar el orden de encolado');
	});

	it('una tarea que falla no rompe la cola', async () => {
		const queue = new SerialQueue(0, async () => {});
		await assert.rejects(
			queue.run(async () => {
				throw new Error('boom');
			}),
		);
		assert.equal(await queue.run(async () => 'sigue viva'), 'sigue viva');
	});
});
