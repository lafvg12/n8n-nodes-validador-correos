/**
 * Caché con TTL y coalescencia de peticiones en vuelo.
 *
 * Existía dos veces escrito a mano (MX y edad de dominio) con diferencias
 * sutiles entre ambas copias. Aquí está una sola vez y probada.
 *
 * La coalescencia es la parte que no es obvia: sin ella, 100 items del
 * mismo dominio fallan el caché antes de que ninguno lo escriba y disparan
 * 100 consultas idénticas.
 */

export interface Loaded<V> {
	value: V;
	/**
	 * Si es false el valor NO se guarda. Sirve para no cachear fallos
	 * temporales —un timeout de DNS o un 429— que se resolverían solos al
	 * siguiente intento.
	 */
	cacheable: boolean;
}

export interface Fetched<V> {
	value: V;
	/** true si vino del caché o de una petición ya en curso. */
	cached: boolean;
}

interface Entry<V> {
	value: V;
	expiresAt: number;
}

export class AsyncCache<V> {
	private readonly entries = new Map<string, Entry<V>>();
	private readonly inFlight = new Map<string, Promise<V>>();

	constructor(
		private readonly ttlMs: number,
		private readonly now: () => number = Date.now,
	) {}

	async fetch(key: string, load: (key: string) => Promise<Loaded<V>>): Promise<Fetched<V>> {
		const entry = this.entries.get(key);
		if (entry !== undefined && entry.expiresAt > this.now()) {
			return { value: entry.value, cached: true };
		}

		const pending = this.inFlight.get(key);
		if (pending !== undefined) {
			return { value: await pending, cached: true };
		}

		const promise = load(key)
			.then(({ value, cacheable }) => {
				if (cacheable) {
					this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
				}
				return value;
			})
			.finally(() => {
				this.inFlight.delete(key);
			});

		this.inFlight.set(key, promise);
		return { value: await promise, cached: false };
	}

	clear(): void {
		this.entries.clear();
		this.inFlight.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}

/**
 * Ejecuta tareas de a una con una pausa entre ellas.
 *
 * Los servidores RDAP responden 429 ante ráfagas, y el nodo procesa hasta
 * 20 items en paralelo. Encolar cuesta poco porque hay pocos dominios
 * distintos y el resultado se cachea 24 h.
 */
export class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly gapMs: number,
		private readonly sleep: (ms: number) => Promise<void> = (ms) =>
			new Promise((resolve) => setTimeout(resolve, ms)),
	) {}

	run<T>(task: () => Promise<T>): Promise<T> {
		const result = this.tail.then(task, task);
		const pause = (): Promise<void> => this.sleep(this.gapMs);
		this.tail = result.then(pause, pause);
		return result;
	}
}
