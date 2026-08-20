/**
 * Edad del dominio vía RDAP.
 *
 * Va directo al servidor autoritativo de cada TLD, no a rdap.org: ese es
 * solo un redirector con su propia cuota y responde 429 con facilidad.
 * El registro de IANA además dice de antemano qué TLD no tienen RDAP
 * —.co, .com.co, .es, .mx— y para esos ni siquiera se hace la petición.
 *
 * El fetch está detrás de una interfaz por la misma razón que el DNS:
 * para poder probar esto sin salir a la red.
 */

import { AsyncCache, SerialQueue, type Loaded } from './cache';

export interface HttpResponse {
	status: number;
	ok: boolean;
	json(): Promise<unknown>;
}

export interface HttpClient {
	get(url: string, timeoutMs: number): Promise<HttpResponse>;
}

export const IANA_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

const DAY_MS = 86_400_000;
const RETRY_AFTER_429_MS = 1500;

export class FetchHttpClient implements HttpClient {
	async get(url: string, timeoutMs: number): Promise<HttpResponse> {
		const response = await fetch(url, {
			headers: { accept: 'application/rdap+json' },
			redirect: 'follow',
			signal: AbortSignal.timeout(timeoutMs),
		});
		return {
			status: response.status,
			ok: response.ok,
			json: async () => await response.json(),
		};
	}
}

interface BootstrapDocument {
	services?: Array<[string[], string[]]>;
}

interface RdapDocument {
	events?: Array<{ eventAction?: string; eventDate?: string }>;
}

/** Mapa TLD -> URL base de su servidor RDAP, según el registro de IANA. */
export function parseBootstrap(body: unknown): Map<string, string> | null {
	const services = (body as BootstrapDocument | null)?.services;
	if (!Array.isArray(services)) return null;

	const registry = new Map<string, string>();
	for (const entry of services) {
		const [tlds, urls] = entry ?? [];
		if (!Array.isArray(tlds) || !Array.isArray(urls) || urls.length === 0) continue;
		const base = urls[0].endsWith('/') ? urls[0] : `${urls[0]}/`;
		for (const tld of tlds) registry.set(tld.toLowerCase(), base);
	}
	return registry.size > 0 ? registry : null;
}

/** Sufijo más largo presente en el registro: com.co gana sobre co. */
export function rdapBaseFor(domain: string, registry: Map<string, string>): string | null {
	const parts = domain.split('.');
	for (let i = 1; i < parts.length; i++) {
		const base = registry.get(parts.slice(i).join('.'));
		if (base !== undefined) return base;
	}
	return null;
}

export function registrationAgeDays(body: unknown, now: number): number | null {
	const events = (body as RdapDocument | null)?.events;
	const registration = Array.isArray(events)
		? events.find((e) => e?.eventAction === 'registration')?.eventDate
		: undefined;
	if (registration === undefined) return null;

	const registered = new Date(registration).getTime();
	if (Number.isNaN(registered)) return null;
	return Math.floor((now - registered) / DAY_MS);
}

export interface DomainAgeLookup {
	get(domain: string, timeoutMs: number): Promise<number | null>;
}

/** Siempre null. Lo usa el nodo cuando la opción está apagada. */
export class DisabledDomainAge implements DomainAgeLookup {
	async get(): Promise<number | null> {
		return null;
	}
}

export class RdapDomainAge implements DomainAgeLookup {
	private readonly cache: AsyncCache<number | null>;
	private readonly queue: SerialQueue;
	private registry: Promise<Map<string, string> | null> | null = null;

	constructor(
		private readonly http: HttpClient,
		options: { ttlMs?: number; gapMs?: number; now?: () => number } = {},
	) {
		const { ttlMs = DAY_MS, gapMs = 150, now } = options;
		this.cache = new AsyncCache<number | null>(ttlMs, now);
		this.queue = new SerialQueue(gapMs);
		this.now = now ?? Date.now;
	}

	private readonly now: () => number;

	private async bootstrap(timeoutMs: number): Promise<Map<string, string> | null> {
		this.registry ??= (async () => {
			try {
				const response = await this.http.get(IANA_BOOTSTRAP_URL, timeoutMs);
				if (!response.ok) return null;
				return parseBootstrap(await response.json());
			} catch {
				return null;
			}
		})();

		const registry = await this.registry;
		// Si falló, permitir que el próximo intento lo reintente.
		if (registry === null) this.registry = null;
		return registry;
	}

	async get(domain: string, timeoutMs: number): Promise<number | null> {
		const { value } = await this.cache.fetch(
			domain,
			async (key): Promise<Loaded<number | null>> =>
				await this.queue.run(async () => await this.load(key, timeoutMs)),
		);
		return value;
	}

	/**
	 * `cacheable` separa "no hay dato" de "no pudimos averiguarlo". Sin esa
	 * distinción un timeout pasajero se guardaba 24 h y dejaba el dominio en
	 * null todo el día.
	 */
	private async load(domain: string, timeoutMs: number): Promise<Loaded<number | null>> {
		const registry = await this.bootstrap(timeoutMs);
		if (registry === null) return { value: null, cacheable: false };

		const base = rdapBaseFor(domain, registry);
		// Ese TLD no publica RDAP. Definitivo, y sin gastar una petición.
		if (base === null) return { value: null, cacheable: true };

		const url = `${base}domain/${encodeURIComponent(domain)}`;
		try {
			let response = await this.http.get(url, timeoutMs);
			if (response.status === 429) {
				await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_429_MS));
				response = await this.http.get(url, timeoutMs);
			}

			// 404: el dominio no está registrado, es definitivo.
			// 429 y 5xx son transitorios y no se guardan.
			if (response.status === 404) return { value: null, cacheable: true };
			if (!response.ok) return { value: null, cacheable: false };

			return { value: registrationAgeDays(await response.json(), this.now()), cacheable: true };
		} catch {
			return { value: null, cacheable: false };
		}
	}

	clear(): void {
		this.cache.clear();
		this.registry = null;
	}
}
