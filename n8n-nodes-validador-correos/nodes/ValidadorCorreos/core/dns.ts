/**
 * Resolución DNS detrás de una interfaz.
 *
 * El motivo no es ceremonia: con el módulo `node:dns` importado directo era
 * imposible escribir los tests que pide la spec (§9: "usa mocks para el DNS,
 * los tests no deben depender de la red"). Ahora el validador depende de
 * `DnsResolver`, no de Node, y un test le inyecta uno falso.
 */

import { Resolver } from 'node:dns/promises';

import { AsyncCache, type Loaded } from './cache';

export interface MxRecord {
	exchange: string;
	priority: number;
}

/** Lo mínimo que el validador necesita saber hacer del DNS. */
export interface DnsResolver {
	resolveMx(domain: string): Promise<MxRecord[]>;
	resolveIpv4(domain: string): Promise<string[]>;
}

export interface DomainMailStatus {
	mx: string | null;
	acceptsMail: boolean;
	/** MX nulo (RFC 7505): el dominio declara que no recibe correo. */
	nullMx: boolean;
	domainExists: boolean;
	/** Timeout o SERVFAIL: no sabemos, que es distinto de "no existe". */
	resolverFailed: boolean;
}

const NOT_FOUND = new Set(['ENOTFOUND', 'NXDOMAIN']);
const NO_RECORDS = 'ENODATA';

function errorCode(error: unknown): string | undefined {
	return (error as { code?: string } | null)?.code;
}

export class NodeDnsResolver implements DnsResolver {
	constructor(private readonly timeoutMs: number) {}

	private resolver(): Resolver {
		// tries es el número de INTENTOS, no de reintentos: 2 = un reintento,
		// que es lo que pide la spec (§5.4).
		return new Resolver({ timeout: this.timeoutMs, tries: 2 });
	}

	async resolveMx(domain: string): Promise<MxRecord[]> {
		return await this.resolver().resolveMx(domain);
	}

	async resolveIpv4(domain: string): Promise<string[]> {
		return await this.resolver().resolve4(domain);
	}
}

const UNRESOLVED: DomainMailStatus = {
	mx: null,
	acceptsMail: false,
	nullMx: false,
	domainExists: false,
	resolverFailed: false,
};

/**
 * Traduce las respuestas del DNS a la pregunta que nos importa:
 * ¿este dominio puede recibir correo?
 */
export async function lookupMailStatus(
	resolver: DnsResolver,
	domain: string,
): Promise<DomainMailStatus> {
	try {
		const records = await resolver.resolveMx(domain);
		if (records.length > 0) {
			const best = [...records].sort((a, b) => a.priority - b.priority)[0];
			const host = best.exchange.replace(/\.$/, '').toLowerCase();
			if (host === '' || host === '.') {
				return { ...UNRESOLVED, domainExists: true, nullMx: true };
			}
			return { ...UNRESOLVED, domainExists: true, acceptsMail: true, mx: host };
		}
	} catch (error) {
		const code = errorCode(error);
		if (code !== undefined && NOT_FOUND.has(code)) return UNRESOLVED;
		if (code !== NO_RECORDS) return { ...UNRESOLVED, resolverFailed: true };
		// ENODATA: el dominio existe pero no tiene MX. Sigue al fallback A.
	}

	// Sin MX, un registro A también sirve para entregar correo (RFC 5321).
	try {
		const addresses = await resolver.resolveIpv4(domain);
		if (addresses.length > 0) {
			return { ...UNRESOLVED, domainExists: true, acceptsMail: true, mx: null };
		}
		return { ...UNRESOLVED, domainExists: true };
	} catch (error) {
		const code = errorCode(error);
		if (code === NO_RECORDS) return { ...UNRESOLVED, domainExists: true };
		if (code !== undefined && NOT_FOUND.has(code)) return UNRESOLVED;
		return { ...UNRESOLVED, resolverFailed: true };
	}
}

/** Envuelve un resolver con caché por dominio y coalescencia. */
export class CachedMailStatusLookup {
	private readonly cache: AsyncCache<DomainMailStatus>;

	constructor(
		private readonly resolver: DnsResolver,
		ttlMs: number,
		now?: () => number,
	) {
		this.cache = new AsyncCache<DomainMailStatus>(ttlMs, now);
	}

	async get(domain: string): Promise<{ status: DomainMailStatus; cached: boolean }> {
		const { value, cached } = await this.cache.fetch(domain, async (key): Promise<
			Loaded<DomainMailStatus>
		> => {
			const status = await lookupMailStatus(this.resolver, key);
			// Un fallo del resolver no se guarda: es temporal.
			return { value: status, cacheable: !status.resolverFailed };
		});
		return { status: value, cached };
	}

	clear(): void {
		this.cache.clear();
	}
}
