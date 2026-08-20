/**
 * Las listas, separadas de la lógica.
 *
 * Estaban incrustadas en medio de la cascada, así que agregar un dominio
 * obligaba a tocar el archivo de las decisiones. Aquí se editan sin
 * riesgo de romper nada, y el nodo puede extender cada una desde su UI.
 */

export interface ProviderRule {
	/** Sufijo del registro MX que identifica al proveedor. */
	mxSuffix: string;
	name: string;
	/** true si acepta cualquier destinatario; null si no se sabe. */
	catchAll: boolean | null;
}

export interface Lists {
	/** Un typo a distancia 1 contra estos corta de una, sin consultar DNS. */
	readonly tier1: ReadonlySet<string>;
	readonly free: ReadonlySet<string>;
	/** Referencia del corrector de typos. Incluye los free y los ISP locales. */
	readonly common: ReadonlySet<string>;
	readonly disposable: ReadonlySet<string>;
	/** Buzones de sistema: no enviar nunca, hay riesgo técnico real. */
	readonly systemMailboxes: ReadonlySet<string>;
	/** Buzones compartidos de empresa: decisión de negocio, no técnica. */
	readonly roles: ReadonlySet<string>;
	readonly junk: ReadonlySet<string>;
	readonly providers: readonly ProviderRule[];
}

export interface ListExtensions {
	domains?: readonly string[];
	disposable?: readonly string[];
	roles?: readonly string[];
}

const TIER1 = [
	'gmail.com',
	'hotmail.com',
	'outlook.com',
	'yahoo.com',
	'live.com',
	'icloud.com',
	'hotmail.es',
	'outlook.es',
	'yahoo.es',
];

const FREE = [
	...TIER1,
	// ymail y rocketmail son dominios reales de Yahoo y quedan a distancia 1
	// de gmail.com: sin estar aquí, el corrector los "arreglaría" por error.
	'ymail.com',
	'rocketmail.com',
	'me.com',
	'mac.com',
	'aol.com',
	'aim.com',
	'msn.com',
	'live.com.mx',
	'live.com.co',
	'hotmail.com.mx',
	'hotmail.com.co',
	'hotmail.com.ar',
	'hotmail.co.uk',
	'yahoo.com.mx',
	'yahoo.com.co',
	'yahoo.com.ar',
	'outlook.com.co',
	'protonmail.com',
	'proton.me',
	'gmx.com',
	'gmx.net',
	'zoho.com',
	'yandex.com',
	'mail.com',
	'mail.ru',
	'tutanota.com',
	'fastmail.com',
];

/** ISP colombianos: no son gratuitos pero sí frecuentes en la base. */
const LOCAL_ISPS = [
	'une.net.co',
	'etb.net.co',
	'telmex.net.co',
	'claro.com.co',
	'movistar.com.co',
];

const DISPOSABLE = [
	'mailinator.com',
	'10minutemail.com',
	'guerrillamail.com',
	'guerrillamail.info',
	'tempmail.com',
	'temp-mail.org',
	'tempmailo.com',
	'tempr.email',
	'yopmail.com',
	'throwawaymail.com',
	'trashmail.com',
	'sharklasers.com',
	'getnada.com',
	'maildrop.cc',
	'dispostable.com',
	'fakeinbox.com',
	'mailnesia.com',
	'mailcatch.com',
	'spamgourmet.com',
	'emailondeck.com',
	'moakt.com',
	'mohmal.com',
	'correotemporal.org',
	'grr.la',
];

/**
 * Buzones de sistema. Aquí SÍ hay razón técnica para no enviar:
 *
 * - `postmaster` y `abuse` los exige el RFC 2142 en todo dominio, existan o
 *   no como buzón real, y son direcciones clásicas de spamtrap. Mandarles
 *   publicidad es una vía directa a una lista negra.
 * - `noreply`, `mailer-daemon` y `bounce` son buzones de salida: el correo
 *   que llega ahí se descarta o rebota.
 *
 * No dependen de si la campaña es B2B o B2C, por eso no los gobierna la
 * opción de cuentas de rol.
 */
const SYSTEM_MAILBOXES = [
	'abuse',
	'bounce',
	'bounces',
	'devnull',
	'mailer-daemon',
	'mailerdaemon',
	'no-reply',
	'noreply',
	'postmaster',
	'spam',
];

/**
 * Buzones compartidos de empresa. NO hay razón técnica para excluirlos:
 * existen, reciben y alguien los lee.
 *
 * Excluirlos es una decisión de negocio, no de deliverability. En marketing
 * B2C son ruido porque nadie en concreto dio su consentimiento; en venta a
 * empresas o contratación pública son justo el destinatario buscado. Por eso
 * la opción "Cuentas De Rol" del nodo decide qué hacer con ellos, y solo
 * marcan `role_based: true` para poder ramificar.
 */
const SHARED_MAILBOXES = [
	'admin',
	'administracion',
	'ayuda',
	'billing',
	'comercial',
	'compras',
	'contabilidad',
	'contact',
	'contacto',
	'contratacion',
	'facturacion',
	'gerencia',
	'hola',
	'info',
	'licitaciones',
	'marketing',
	'notificaciones',
	'office',
	'pedidos',
	'rrhh',
	'sales',
	'servicioalcliente',
	'soporte',
	'support',
	'team',
	'ventas',
	'webmaster',
];

const JUNK = [
	'123',
	'1234',
	'aaa',
	'aaaa',
	'abc',
	'asd',
	'asdf',
	'asdfasdf',
	'correo',
	'ejemplo',
	'example',
	'fake',
	'falso',
	'na',
	'nada',
	'ninguno',
	'noexiste',
	'nomail',
	'none',
	'prueba',
	'pruebas',
	'qwerty',
	'sdfsdf',
	'sinemail',
	'test',
	'testing',
	'xx',
	'xxx',
];

const PROVIDERS: ProviderRule[] = [
	{ mxSuffix: 'protection.outlook.com', name: 'microsoft', catchAll: true },
	{ mxSuffix: 'outlook.com', name: 'microsoft', catchAll: true },
	{ mxSuffix: 'google.com', name: 'google', catchAll: false },
	{ mxSuffix: 'googlemail.com', name: 'google', catchAll: false },
	{ mxSuffix: 'yahoodns.net', name: 'yahoo', catchAll: false },
	{ mxSuffix: 'icloud.com', name: 'apple', catchAll: false },
	{ mxSuffix: 'apple.com', name: 'apple', catchAll: false },
	{ mxSuffix: 'zoho.com', name: 'zoho', catchAll: null },
	{ mxSuffix: 'secureserver.net', name: 'godaddy', catchAll: null },
	{ mxSuffix: 'mail.ru', name: 'mailru', catchAll: null },
	{ mxSuffix: 'yandex.net', name: 'yandex', catchAll: null },
];

function normalize(values: readonly string[]): string[] {
	return values.map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0);
}

const BASE: Lists = Object.freeze({
	tier1: new Set(TIER1),
	free: new Set(FREE),
	common: new Set([...FREE, ...LOCAL_ISPS]),
	disposable: new Set(DISPOSABLE),
	systemMailboxes: new Set(SYSTEM_MAILBOXES),
	roles: new Set(SHARED_MAILBOXES),
	junk: new Set(JUNK),
	providers: Object.freeze([...PROVIDERS]),
});

/**
 * Sin extensiones devuelve siempre la misma instancia. Importa: se llamaba
 * por cada correo, y reconstruir cinco Sets por dirección es desperdicio
 * cuando se validan miles.
 */
export function buildLists(extensions: ListExtensions = {}): Lists {
	const domains = normalize(extensions.domains ?? []);
	const disposable = normalize(extensions.disposable ?? []);
	const roles = normalize(extensions.roles ?? []);

	if (domains.length === 0 && disposable.length === 0 && roles.length === 0) return BASE;

	return Object.freeze({
		tier1: BASE.tier1,
		free: BASE.free,
		common: new Set([...BASE.common, ...domains]),
		disposable: new Set([...BASE.disposable, ...disposable]),
		systemMailboxes: BASE.systemMailboxes,
		roles: new Set([...BASE.roles, ...roles]),
		junk: BASE.junk,
		providers: BASE.providers,
	});
}

export { BASE as baseLists };
