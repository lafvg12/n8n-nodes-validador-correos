/**
 * Dobles de prueba. Ningún test sale a la red (§9 de la spec).
 */

import type { DnsResolver, MxRecord } from '../nodes/ValidadorCorreos/core/dns';
import type { DomainAgeLookup } from '../nodes/ValidadorCorreos/core/rdap';

export interface ZoneEntry {
	mx?: Array<{ host: string; priority?: number }>;
	a?: string[];
	/** Simula SERVFAIL o timeout: no sabemos, distinto de "no existe". */
	fail?: boolean;
}

class DnsError extends Error {
	constructor(public readonly code: string) {
		super(code);
	}
}

/**
 * Resolver falso sobre una zona declarada a mano.
 * Cuenta las consultas, que es lo que verifica el test de concurrencia.
 */
export class FakeResolver implements DnsResolver {
	public mxQueries = 0;
	public aQueries = 0;

	constructor(
		private readonly zone: Record<string, ZoneEntry>,
		/** Retardo artificial, para que varias consultas se solapen. */
		private readonly delayMs = 0,
	) {}

	get totalQueries(): number {
		return this.mxQueries + this.aQueries;
	}

	private async settle(): Promise<void> {
		if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
	}

	async resolveMx(domain: string): Promise<MxRecord[]> {
		this.mxQueries++;
		await this.settle();
		const entry = this.zone[domain];
		if (entry?.fail === true) throw new DnsError('ESERVFAIL');
		if (entry === undefined) throw new DnsError('ENOTFOUND');
		if (entry.mx === undefined) throw new DnsError('ENODATA');
		return entry.mx.map((r, i) => ({ exchange: r.host, priority: r.priority ?? i + 1 }));
	}

	async resolveIpv4(domain: string): Promise<string[]> {
		this.aQueries++;
		await this.settle();
		const entry = this.zone[domain];
		if (entry?.fail === true) throw new DnsError('ESERVFAIL');
		if (entry === undefined) throw new DnsError('ENOTFOUND');
		if (entry.a === undefined) throw new DnsError('ENODATA');
		return entry.a;
	}
}

export class FakeDomainAge implements DomainAgeLookup {
	public calls = 0;

	constructor(private readonly ages: Record<string, number | null> = {}) {}

	async get(domain: string): Promise<number | null> {
		this.calls++;
		return this.ages[domain] ?? null;
	}
}

/** Zona compartida por los tests de la cascada. */
export const ZONE: Record<string, ZoneEntry> = {
	'gmail.com': { mx: [{ host: 'gmail-smtp-in.l.google.com.', priority: 5 }] },
	'hotmail.com': { mx: [{ host: 'hotmail-com.olc.protection.outlook.com.', priority: 2 }] },
	'ymail.com': { mx: [{ host: 'mta7.am0.yahoodns.net.', priority: 1 }] },
	'une.net.co': { mx: [{ host: 'mail.une.net.co.', priority: 10 }] },
	'empresa.com.co': { mx: [{ host: 'mail.empresa.com.co.', priority: 10 }] },
	'mailinator.com': { mx: [{ host: 'mail.mailinator.com.', priority: 1 }] },
	'asdf.com': { mx: [{ host: 'mail.asdf.com.', priority: 10 }] },
	// Typosquats reales: existen y responden. Por eso el corte por typo de
	// alta confianza tiene que ocurrir ANTES de mirar el DNS.
	'hotmial.com': { mx: [{ host: 'mail.h-email.net.', priority: 5 }] },
	'gmial.com': { a: ['51.79.68.169'] },
	// Dominio sin MX pero con registro A: entrega válida (RFC 5321).
	'soloa.com': { a: ['203.0.113.10'] },
	// MX nulo (RFC 7505): declara que no recibe correo.
	'sincorreo.com': { mx: [{ host: '.', priority: 0 }] },
	// Resolver caído.
	'caido.com': { fail: true },
};
