/**
 * La cascada, como una lista ordenada de reglas independientes.
 *
 * Antes era una función de 170 líneas con once `if` encadenados: agregar
 * un chequeo obligaba a meter mano en el medio y no había forma de probar
 * uno solo. Ahora cada regla es un objeto con nombre, se prueba aislada, y
 * agregar una es añadir una entrada a `defaultRules`.
 *
 * Contrato: una regla devuelve un `Verdict` para CORTAR la cascada, o null
 * para dejar seguir. Puede anotar datos en `facts` en cualquier caso; las
 * que solo anotan (proveedor, edad del dominio) devuelven null siempre.
 *
 * EL ORDEN IMPORTA. Cada corte ahorra los siguientes, y el de DNS es el
 * único que cuesta red. Ver los comentarios de cada regla antes de mover
 * nada de sitio.
 */

import type { CachedMailStatusLookup } from './dns';
import type { DomainAgeLookup } from './rdap';
import { findTypo, looksLikeFiller, matchProvider } from './analysis';
import type { Lists } from '../data/lists';
import type { Verdict } from './types';

/** Datos que las reglas van descubriendo y que terminan en la salida. */
export interface Facts {
	suggestion: string | null;
	free_email: boolean;
	role_based: boolean;
	disposable: boolean;
	mx_found: boolean;
	mx_record: string | null;
	smtp_provider: string | null;
	catch_all: boolean | null;
	domain_age_days: number | null;
	cached: boolean;
}

export function emptyFacts(): Facts {
	return {
		suggestion: null,
		free_email: false,
		role_based: false,
		disposable: false,
		mx_found: false,
		mx_record: null,
		smtp_provider: null,
		catch_all: null,
		domain_age_days: null,
		cached: false,
	};
}

export interface RuleSettings {
	catchAllIsSendable: boolean;
	/**
	 * Para campañas B2C una cuenta de rol es ruido. Para vender a empresas
	 * —contratación pública, por ejemplo— `licitaciones@` es justo el
	 * destinatario que se busca. Por eso es una decisión de negocio y no
	 * una regla fija.
	 */
	roleIsSendable: boolean;
	flagSuspiciousPatterns: boolean;
	includeDomainAge: boolean;
	rdapTimeoutMs: number;
}

export interface RuleDependencies {
	mailStatus: CachedMailStatusLookup;
	domainAge: DomainAgeLookup;
}

export interface RuleContext {
	readonly account: string;
	readonly domain: string;
	readonly lists: Lists;
	readonly settings: RuleSettings;
	readonly deps: RuleDependencies;
	readonly facts: Facts;
}

export interface Rule {
	readonly name: string;
	run(context: RuleContext): Verdict | null | Promise<Verdict | null>;
}

const reject = (sub_status: Verdict['sub_status'], status: Verdict['status'] = 'invalid'): Verdict => ({
	status,
	sub_status,
	recommendation: 'reject',
});

const review = (sub_status: Verdict['sub_status']): Verdict => ({
	status: 'do_not_mail',
	sub_status,
	recommendation: 'manual_review',
});

/**
 * Clasifica sin decidir. Va primera para que estos tres campos salgan
 * poblados aunque una regla posterior corte la cascada.
 */
export const classifyRule: Rule = {
	name: 'classify',
	run({ account, domain, lists, facts }) {
		facts.free_email = lists.free.has(domain);
		facts.disposable = lists.disposable.has(domain);
		facts.role_based = lists.roles.has(account) || lists.systemMailboxes.has(account);
		return null;
	},
};

/**
 * Buzones de sistema: postmaster, abuse, noreply.
 *
 * A diferencia de los buzones compartidos, aquí hay riesgo técnico concreto:
 * postmaster y abuse los exige el RFC 2142 en todo dominio y se usan como
 * spamtrap, y noreply descarta lo que le llega. Por eso corta siempre, sin
 * depender de si la campaña es B2B o B2C.
 */
export const systemMailboxRule: Rule = {
	name: 'system-mailbox',
	run({ account, lists }) {
		return lists.systemMailboxes.has(account) ? reject('system_mailbox', 'do_not_mail') : null;
	},
};

/** Antes que la basura del local part: un hecho del dominio es más confiable. */
export const disposableRule: Rule = {
	name: 'disposable',
	run({ facts }) {
		return facts.disposable ? reject('disposable', 'do_not_mail') : null;
	},
};

export const junkLocalPartRule: Rule = {
	name: 'junk-local-part',
	run({ account, lists }) {
		return lists.junk.has(account) ? reject('junk_local_part') : null;
	},
};

/** Sospecha, no certeza: por eso va a revisión y no a rechazo. */
export const suspiciousPatternRule: Rule = {
	name: 'suspicious-pattern',
	run({ account, settings }) {
		if (!settings.flagSuspiciousPatterns) return null;
		return looksLikeFiller(account) ? review('suspicious_pattern') : null;
	},
};

/**
 * Antes del DNS: corta y no necesita red.
 *
 * Si están permitidas, la regla no corta y el correo sigue la cascada
 * normal. El campo `role_based` queda en true igualmente, para poder
 * ramificar por él aguas abajo.
 */
export const roleAccountRule: Rule = {
	name: 'role-account',
	run({ account, lists, settings }) {
		if (!lists.roles.has(account) || settings.roleIsSendable) return null;
		return review('role_based');
	},
};

/**
 * Anota la sugerencia siempre; solo corta cuando la confianza es alta.
 * Un typo de alta confianza corta ANTES del DNS a propósito: los dominios
 * typosquatting existen y responden, así que esperar al DNS los deja pasar.
 */
export const typoRule: Rule = {
	name: 'domain-typo',
	run({ account, domain, lists, facts }) {
		const { suggestion, highConfidence } = findTypo(domain, lists);
		if (suggestion !== null) facts.suggestion = `${account}@${suggestion}`;
		return highConfidence ? reject('possible_typo') : null;
	},
};

/** La única regla que cuesta red. Anota el MX y corta si el dominio no sirve. */
export const dnsRule: Rule = {
	name: 'dns',
	async run({ domain, lists, deps, facts }) {
		const { status, cached } = await deps.mailStatus.get(domain);
		facts.cached = cached;

		if (status.resolverFailed) {
			// No sabemos. Mejor enviar que descartar a un cliente legítimo por
			// una caída momentánea del DNS.
			return { status: 'unknown', sub_status: 'dns_unavailable', recommendation: 'confirm' };
		}
		if (status.nullMx) return reject('domain_does_not_accept_mail');
		if (!status.acceptsMail) {
			return reject(facts.suggestion !== null ? 'possible_typo' : 'no_dns_entries');
		}

		facts.mx_found = true;
		facts.mx_record = status.mx;
		const provider = matchProvider(status.mx, lists);
		facts.smtp_provider = provider.name;
		facts.catch_all = provider.catchAll;
		return null;
	},
};

/** Solo anota. Va al final porque es una petición HTTP extra y opcional. */
export const domainAgeRule: Rule = {
	name: 'domain-age',
	async run({ domain, settings, deps, facts }) {
		if (!settings.includeDomainAge) return null;
		facts.domain_age_days = await deps.domainAge.get(domain, settings.rdapTimeoutMs);
		return null;
	},
};

/**
 * Para agregar un chequeo nuevo, inserta su regla aquí en la posición que
 * le corresponda y escribe su test. Nada más hay que tocar.
 */
export const defaultRules: readonly Rule[] = Object.freeze([
	classifyRule,
	disposableRule,
	systemMailboxRule,
	junkLocalPartRule,
	suspiciousPatternRule,
	roleAccountRule,
	typoRule,
	dnsRule,
	domainAgeRule,
]);

/** Veredicto cuando ninguna regla cortó: el dominio sirve. */
export function finalVerdict(facts: Facts, settings: RuleSettings): Verdict {
	if (facts.catch_all === true) {
		return {
			status: 'catch_all',
			sub_status: null,
			recommendation: settings.catchAllIsSendable ? 'confirm' : 'manual_review',
		};
	}
	if (facts.suggestion !== null) {
		// Sobrevivió al DNS pero se parece a un dominio común: se envía, y la
		// sugerencia va igual para que alguien pueda revisarla.
		return { status: 'valid', sub_status: 'possible_typo', recommendation: 'confirm' };
	}
	return { status: 'valid', sub_status: null, recommendation: 'accept' };
}

/** Corre las reglas en orden y devuelve el primer veredicto, o el final. */
export async function runRules(
	context: RuleContext,
	rules: readonly Rule[] = defaultRules,
): Promise<Verdict> {
	for (const rule of rules) {
		const verdict = await rule.run(context);
		if (verdict !== null) return verdict;
	}
	return finalVerdict(context.facts, context.settings);
}
