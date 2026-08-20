/**
 * Contrato de salida del validador.
 *
 * Los nombres siguen la convención de ZeroBounce para que un flujo pueda
 * cambiar de uno al otro sin reescribir las ramas.
 *
 * No existe un sub_status "mailbox_not_found" a propósito: este servicio no
 * determina si un buzón existe, y nombrarlo así sería afirmar algo que no
 * podemos saber.
 */

export type Status = 'valid' | 'invalid' | 'do_not_mail' | 'catch_all' | 'unknown';

export type Recommendation = 'accept' | 'confirm' | 'manual_review' | 'reject';

export type SubStatus =
	| 'field_not_found'
	| 'invalid_type'
	| 'empty'
	| 'failed_syntax_check'
	| 'disposable'
	| 'junk_local_part'
	| 'suspicious_pattern'
	| 'system_mailbox'
	| 'role_based'
	| 'possible_typo'
	| 'domain_does_not_accept_mail'
	| 'no_dns_entries'
	| 'dns_unavailable';

export interface Validation {
	email: string;
	normalized: string | null;
	/** La dirección a la que enviar, o null si no es enviable. */
	send_to: string | null;
	status: Status;
	sub_status: SubStatus | null;
	/** El campo que consume n8n para ramificar. */
	recommendation: Recommendation;
	sendable: boolean;
	suggestion: string | null;
	account: string | null;
	domain: string | null;
	free_email: boolean;
	role_based: boolean;
	disposable: boolean;
	normalization_applied: boolean;
	mx_found: boolean;
	mx_record: string | null;
	smtp_provider: string | null;
	catch_all: boolean | null;
	domain_age_days: number | null;
	checked_at: string;
	cached: boolean;
	duration_ms: number;
}

/** Veredicto con el que una regla corta la cascada. */
export interface Verdict {
	status: Status;
	sub_status: SubStatus | null;
	recommendation: Recommendation;
}

export const SENDABLE: ReadonlySet<Recommendation> = new Set<Recommendation>([
	'accept',
	'confirm',
]);

export function isSendable(recommendation: Recommendation): boolean {
	return SENDABLE.has(recommendation);
}
