/**
 * Validador de correos: punto de entrada.
 *
 * Este módulo no importa nada de n8n a propósito, así se puede probar sin
 * levantar una instancia. El nodo solo lo envuelve.
 *
 * NO determina si un buzón existe. Determina si una dirección es imposible
 * o sospechosa. La existencia real solo la confirma un envío.
 *
 * La cascada vive en core/rules.ts, una regla por chequeo. Para agregar un
 * chequeo nuevo se toca ese archivo, no este.
 */

import {
	hasValidSyntax,
	normalizeEmail,
	splitEmail,
} from './core/analysis';
import { CachedMailStatusLookup, NodeDnsResolver, type DnsResolver } from './core/dns';
import {
	DisabledDomainAge,
	FetchHttpClient,
	RdapDomainAge,
	type DomainAgeLookup,
} from './core/rdap';
import {
	emptyFacts,
	runRules,
	type Facts,
	type Rule,
	type RuleSettings,
} from './core/rules';
import { isSendable, type SubStatus, type Validation, type Verdict } from './core/types';
import { buildLists, type Lists } from './data/lists';

export type { Status, Recommendation, SubStatus, Validation, Verdict } from './core/types';
export type { Lists } from './data/lists';
export type { DnsResolver, MxRecord } from './core/dns';
export type { DomainAgeLookup, HttpClient } from './core/rdap';
export type { Rule, RuleContext, Facts } from './core/rules';
export { editDistance, findTypo, looksLikeFiller, normalizeEmail } from './core/analysis';

const HOUR_MS = 60 * 60 * 1000;

export interface ValidationOptions {
	catchAllIsSendable?: boolean;
	/** Cuentas como info@ o licitaciones@: ruido en B2C, objetivo en B2B. */
	roleIsSendable?: boolean;
	extraDomains?: readonly string[];
	extraDisposable?: readonly string[];
	extraRoles?: readonly string[];
	cacheTtlMs?: number;
	dnsTimeoutMs?: number;
	/** Consulta RDAP para la edad del dominio. Es una petición HTTP extra. */
	includeDomainAge?: boolean;
	rdapTimeoutMs?: number;
	/** Marca local parts con forma de relleno (xxxxxyyyy, qwerty, aaaa). */
	flagSuspiciousPatterns?: boolean;
}

/**
 * Todo lo que el validador necesita del mundo exterior, en un solo sitio.
 *
 * Los tests inyectan un resolver falso por aquí; sin esto sería imposible
 * probar la cascada sin salir a la red (§9 de la spec).
 */
export interface ValidatorDependencies {
	resolver?: DnsResolver;
	domainAge?: DomainAgeLookup;
	now?: () => number;
	rules?: readonly Rule[];
}

function baseValidation(email: string, start: number, now: () => number): Validation {
	return {
		email,
		normalized: null,
		send_to: null,
		status: 'invalid',
		sub_status: null,
		recommendation: 'reject',
		sendable: false,
		suggestion: null,
		account: null,
		domain: null,
		free_email: false,
		role_based: false,
		disposable: false,
		normalization_applied: false,
		mx_found: false,
		mx_record: null,
		smtp_provider: null,
		catch_all: null,
		domain_age_days: null,
		checked_at: new Date(now()).toISOString(),
		cached: false,
		duration_ms: now() - start,
	};
}

function assemble(
	email: string,
	normalized: string,
	account: string,
	domain: string,
	normalizationApplied: boolean,
	verdict: Verdict,
	facts: Facts,
	start: number,
	now: () => number,
): Validation {
	const sendable = isSendable(verdict.recommendation);
	return {
		email,
		normalized,
		// null cuando no es enviable: si un item se cuela por la rama
		// equivocada, el envío falla en vez de mandarse igual.
		send_to: sendable ? normalized : null,
		status: verdict.status,
		sub_status: verdict.sub_status,
		recommendation: verdict.recommendation,
		sendable,
		suggestion: facts.suggestion,
		account,
		domain,
		free_email: facts.free_email,
		role_based: facts.role_based,
		disposable: facts.disposable,
		normalization_applied: normalizationApplied,
		mx_found: facts.mx_found,
		mx_record: facts.mx_record,
		smtp_provider: facts.smtp_provider,
		catch_all: facts.catch_all,
		domain_age_days: facts.domain_age_days,
		checked_at: new Date(now()).toISOString(),
		cached: facts.cached,
		duration_ms: now() - start,
	};
}

/**
 * Mantiene las cachés vivas entre ejecuciones.
 *
 * El nodo usa una sola instancia compartida (`defaultValidator`) para que
 * todos los contactos de Gmail compartan una consulta DNS. Los tests crean
 * la suya con dependencias falsas y sin estado heredado.
 */
export class EmailValidator {
	private readonly resolver: DnsResolver | null;
	private readonly explicitDomainAge: DomainAgeLookup | null;
	private readonly now: () => number;
	private readonly rules: readonly Rule[] | undefined;

	private mailStatus: CachedMailStatusLookup | null = null;
	private mailStatusTtl = -1;
	private mailStatusTimeout = -1;
	private rdap: RdapDomainAge | null = null;
	private readonly disabledAge = new DisabledDomainAge();

	private cachedLists: Lists | null = null;
	private cachedListsKey = '';

	constructor(dependencies: ValidatorDependencies = {}) {
		this.resolver = dependencies.resolver ?? null;
		this.explicitDomainAge = dependencies.domainAge ?? null;
		this.now = dependencies.now ?? Date.now;
		this.rules = dependencies.rules;
	}

	/**
	 * El TTL y el timeout vienen de la UI y pueden cambiar entre ejecuciones,
	 * así que la caché se rehace solo cuando alguno cambia de verdad.
	 */
	private mailStatusLookup(ttlMs: number, timeoutMs: number): CachedMailStatusLookup {
		if (
			this.mailStatus === null ||
			this.mailStatusTtl !== ttlMs ||
			this.mailStatusTimeout !== timeoutMs
		) {
			const resolver = this.resolver ?? new NodeDnsResolver(timeoutMs);
			this.mailStatus = new CachedMailStatusLookup(resolver, ttlMs, this.now);
			this.mailStatusTtl = ttlMs;
			this.mailStatusTimeout = timeoutMs;
		}
		return this.mailStatus;
	}

	private domainAgeLookup(enabled: boolean): DomainAgeLookup {
		if (this.explicitDomainAge !== null) return this.explicitDomainAge;
		if (!enabled) return this.disabledAge;
		this.rdap ??= new RdapDomainAge(new FetchHttpClient(), { now: this.now });
		return this.rdap;
	}

	/** Memoiza las listas: reconstruir cinco Sets por dirección es desperdicio. */
	private listsFor(options: ValidationOptions): Lists {
		const domains = options.extraDomains ?? [];
		const disposable = options.extraDisposable ?? [];
		const roles = options.extraRoles ?? [];
		const key = `${domains.join(',')}|${disposable.join(',')}|${roles.join(',')}`;
		if (this.cachedLists === null || this.cachedListsKey !== key) {
			this.cachedLists = buildLists({ domains, disposable, roles });
			this.cachedListsKey = key;
		}
		return this.cachedLists;
	}

	async validate(raw: unknown, options: ValidationOptions = {}): Promise<Validation> {
		const start = this.now();

		// Estos tres casos se distinguen a propósito: si el nodo apunta a un
		// campo que no existe, "empty" no dice nada y parece que el validador
		// está roto.
		const early = this.rejectEarly(raw, start);
		if (early !== null) return early;

		const rawEmail = raw as string;
		const { email: normalized, changed } = normalizeEmail(rawEmail);

		if (!hasValidSyntax(normalized)) {
			return this.reject(rawEmail, normalized, changed, 'failed_syntax_check', start);
		}

		const { account, domain } = splitEmail(normalized);
		const settings: RuleSettings = {
			catchAllIsSendable: options.catchAllIsSendable ?? true,
			// Por defecto SÍ se envía a buzones compartidos. Excluirlos no tiene
			// fundamento técnico —existen y reciben— y el §2.4 de la spec manda
			// dejar pasar ante la duda. Los que sí son riesgosos (postmaster,
			// abuse, noreply) los corta systemMailboxRule y no pasan por aquí.
			roleIsSendable: options.roleIsSendable ?? true,
			flagSuspiciousPatterns: options.flagSuspiciousPatterns ?? true,
			includeDomainAge: options.includeDomainAge ?? false,
			rdapTimeoutMs: options.rdapTimeoutMs ?? 5000,
		};

		const facts = emptyFacts();
		const verdict = await runRules(
			{
				account,
				domain,
				lists: this.listsFor(options),
				settings,
				deps: {
					mailStatus: this.mailStatusLookup(
						options.cacheTtlMs ?? 6 * HOUR_MS,
						options.dnsTimeoutMs ?? 3000,
					),
					domainAge: this.domainAgeLookup(settings.includeDomainAge),
				},
				facts,
			},
			this.rules,
		);

		return assemble(
			rawEmail,
			normalized,
			account,
			domain,
			changed,
			verdict,
			facts,
			start,
			this.now,
		);
	}

	private rejectEarly(raw: unknown, start: number): Validation | null {
		if (raw === undefined || raw === null) {
			return { ...baseValidation('', start, this.now), sub_status: 'field_not_found' };
		}
		if (typeof raw !== 'string') {
			return { ...baseValidation(String(raw), start, this.now), sub_status: 'invalid_type' };
		}
		if (raw.trim() === '') {
			return { ...baseValidation(raw, start, this.now), sub_status: 'empty' };
		}
		return null;
	}

	private reject(
		email: string,
		normalized: string,
		normalizationApplied: boolean,
		subStatus: SubStatus,
		start: number,
	): Validation {
		return {
			...baseValidation(email, start, this.now),
			normalized,
			normalization_applied: normalizationApplied,
			sub_status: subStatus,
		};
	}

	/** Vacía las cachés. Los tests lo usan para aislarse entre casos. */
	clearCache(): void {
		this.mailStatus?.clear();
		this.rdap?.clear();
		this.mailStatus = null;
		this.mailStatusTtl = -1;
		this.mailStatusTimeout = -1;
	}
}

/** Instancia compartida por el nodo: mantiene la caché entre ejecuciones. */
export const defaultValidator = new EmailValidator();

export async function validate(
	raw: unknown,
	options: ValidationOptions = {},
): Promise<Validation> {
	return await defaultValidator.validate(raw, options);
}

export function clearCache(): void {
	defaultValidator.clearCache();
}
