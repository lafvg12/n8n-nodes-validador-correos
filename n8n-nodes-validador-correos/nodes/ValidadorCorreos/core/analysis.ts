/**
 * Funciones puras de análisis de una dirección.
 *
 * Todo lo de aquí es determinista y sin efectos: se puede probar con
 * aserciones directas, sin mocks ni red.
 */

import type { Lists } from '../data/lists';

/** Pragmática a propósito: una regex "completa de RFC 5322" es ilegible e inútil. */
const SYNTAX = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const MAX_TOTAL_LENGTH = 254;
const MAX_ACCOUNT_LENGTH = 64;

/** Filas del teclado, para detectar tecleo de relleno tipo "qwertyui". */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];
const KEYBOARD_RUN = 5;

export interface Normalized {
	email: string;
	changed: boolean;
}

/** Minúsculas, sin espacios, y sin puntos al inicio o final del local part. */
export function normalizeEmail(raw: string): Normalized {
	const email = raw.trim().toLowerCase();
	const at = email.lastIndexOf('@');
	if (at <= 0) return { email, changed: false };

	const local = email.slice(0, at);
	const trimmed = local.replace(/^\.+|\.+$/g, '');
	return { email: `${trimmed}@${email.slice(at + 1)}`, changed: trimmed !== local };
}

export function hasValidSyntax(email: string): boolean {
	if (email.length > MAX_TOTAL_LENGTH) return false;
	if (email.includes('..')) return false;
	if (email.split('@').length - 1 !== 1) return false;
	if (!SYNTAX.test(email)) return false;
	return email.slice(0, email.lastIndexOf('@')).length <= MAX_ACCOUNT_LENGTH;
}

export function splitEmail(email: string): { account: string; domain: string } {
	const at = email.lastIndexOf('@');
	return { account: email.slice(0, at), domain: email.slice(at + 1) };
}

/**
 * Damerau-Levenshtein: la transposición cuenta como UN error.
 *
 * Con Levenshtein a secas, gmial/gmail y hotmial/hotmail dan distancia 2 y
 * esos typos —los más frecuentes, porque nacen de cambiar dos letras de
 * orden— se colarían como válidos.
 */
export function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	const la = a.length;
	const lb = b.length;
	if (la === 0) return lb;
	if (lb === 0) return la;

	const rows: number[][] = Array.from({ length: la + 1 }, (_, i) =>
		Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);

	for (let i = 1; i <= la; i++) {
		for (let j = 1; j <= lb; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
			}
		}
	}
	return rows[la][lb];
}

export interface TypoMatch {
	suggestion: string | null;
	/**
	 * Distancia 1 contra un dominio de primer nivel. Corta sin consultar DNS:
	 * los dominios typosquatting existen y responden. hotmial.com tiene MX
	 * real y gmial.com tiene registro A, así que esperar al DNS los deja pasar.
	 */
	highConfidence: boolean;
}

export function findTypo(domain: string, lists: Lists): TypoMatch {
	// Ancla de coincidencia exacta: un dominio real nunca se "corrige".
	if (lists.common.has(domain)) return { suggestion: null, highConfidence: false };

	const limit = domain.length <= 6 ? 1 : 2;
	let best: string | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;

	for (const candidate of lists.common) {
		// Si difieren más que el umbral solo en longitud, no hace falta medir.
		if (Math.abs(candidate.length - domain.length) > limit) continue;
		const distance = editDistance(domain, candidate);
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
			// Distancia 1 contra un tier1 es el mejor resultado posible; nada
			// que venga después lo mejora. Se corta solo en ese caso, no ante
			// cualquier distancia 1: un tier1 posterior sí sería mejor.
			if (distance === 1 && lists.tier1.has(candidate)) break;
		}
	}

	if (best === null || bestDistance > limit) return { suggestion: null, highConfidence: false };
	return { suggestion: best, highConfidence: bestDistance === 1 && lists.tier1.has(best) };
}

/**
 * Detecta local parts con forma de relleno: xxxxxyyyy, aaaa, qwerty.
 *
 * Un humano los reconoce al instante pero ninguna lista los cubre, porque
 * son infinitos. Las reglas están calibradas para no tocar nombres reales:
 * el error caro aquí es descartar a un cliente de verdad, no dejar pasar
 * uno falso —ese lo atrapa el rebote y no cuesta nada.
 */
export function looksLikeFiller(account: string): boolean {
	const s = account.toLowerCase().replace(/[._+-]/g, '');
	if (s.length < 5) return false; // demasiado corto para juzgar

	// Muy pocos caracteres distintos: "xxxxxyyyy" son 2 en 9.
	if (new Set(s).size <= 2) return true;

	// Un mismo carácter repetido 4+ veces seguidas.
	if (/(.)\1{3,}/.test(s)) return true;

	// Tecleo corrido sobre una fila del teclado, en cualquier sentido.
	for (const row of KEYBOARD_ROWS) {
		const reversed = [...row].reverse().join('');
		for (let i = 0; i + KEYBOARD_RUN <= s.length; i++) {
			const chunk = s.slice(i, i + KEYBOARD_RUN);
			if (row.includes(chunk) || reversed.includes(chunk)) return true;
		}
	}

	// Ni una vocal en 7+ caracteres sin dígitos. Un nombre en español siempre
	// trae vocales; los dígitos delatan un alias real tipo "lafvg12".
	return s.length >= 7 && !/[aeiou]/.test(s) && !/\d/.test(s);
}

/** Primer proveedor cuyo sufijo coincida con el MX. */
export function matchProvider(
	mx: string | null,
	lists: Lists,
): { name: string | null; catchAll: boolean | null } {
	if (mx === null) return { name: null, catchAll: null };
	for (const provider of lists.providers) {
		if (mx.endsWith(provider.mxSuffix)) {
			return { name: provider.name, catchAll: provider.catchAll };
		}
	}
	return { name: null, catchAll: null };
}
