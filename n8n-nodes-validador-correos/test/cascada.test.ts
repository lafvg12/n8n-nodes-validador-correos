/**
 * Los casos obligatorios del §9 de la spec, con el DNS simulado.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { EmailValidator } from '../nodes/ValidadorCorreos/validador';
import { FakeResolver, ZONE } from './helpers';

function makeValidator(delayMs = 0): { validator: EmailValidator; resolver: FakeResolver } {
	const resolver = new FakeResolver(ZONE, delayMs);
	return { validator: new EmailValidator({ resolver }), resolver };
}

describe('cascada de validación', () => {
	let validator: EmailValidator;

	beforeEach(() => {
		validator = makeValidator().validator;
	});

	const casos: Array<{
		email: string;
		status: string;
		sub_status: string | null;
		recommendation: string;
		suggestion?: string | null;
	}> = [
		{
			email: 'juan.perez@gmail.com',
			status: 'valid',
			sub_status: null,
			recommendation: 'accept',
		},
		{
			email: 'juan@gmial.com',
			status: 'invalid',
			sub_status: 'possible_typo',
			recommendation: 'reject',
			suggestion: 'juan@gmail.com',
		},
		{
			email: 'maria@hotmial.com',
			status: 'invalid',
			sub_status: 'possible_typo',
			recommendation: 'reject',
			suggestion: 'maria@hotmail.com',
		},
		{
			email: 'lafvg12@hotmail.com',
			status: 'catch_all',
			sub_status: null,
			recommendation: 'confirm',
		},
		{
			email: 'asdf@asdf.com',
			status: 'invalid',
			sub_status: 'junk_local_part',
			recommendation: 'reject',
		},
		{
			// El §9 de la spec esperaba manual_review. Cambió a propósito:
			// un buzón compartido existe y recibe, y excluirlo no tiene
			// fundamento técnico. Con { roleIsSendable: false } vuelve a
			// manual_review; ver el bloque "cuentas de rol".
			email: 'info@empresa.com.co',
			status: 'valid',
			sub_status: null,
			recommendation: 'accept',
		},
		{
			email: 'test@mailinator.com',
			status: 'do_not_mail',
			sub_status: 'disposable',
			recommendation: 'reject',
		},
		{
			email: 'sin-arroba',
			status: 'invalid',
			sub_status: 'failed_syntax_check',
			recommendation: 'reject',
		},
		{
			email: 'a@@b.com',
			status: 'invalid',
			sub_status: 'failed_syntax_check',
			recommendation: 'reject',
		},
		{
			email: '.juan@gmail.com',
			status: 'valid',
			sub_status: null,
			recommendation: 'accept',
		},
		{
			email: `${'a'.repeat(65)}@gmail.com`,
			status: 'invalid',
			sub_status: 'failed_syntax_check',
			recommendation: 'reject',
		},
		{
			email: 'alguien@ymail.com',
			status: 'valid',
			sub_status: null,
			recommendation: 'accept',
			suggestion: null,
		},
		{
			email: 'alguien@une.net.co',
			status: 'valid',
			sub_status: null,
			recommendation: 'accept',
			suggestion: null,
		},
	];

	for (const caso of casos) {
		it(`${caso.email.slice(0, 40)} → ${caso.status}/${caso.recommendation}`, async () => {
			const r = await validator.validate(caso.email);
			assert.equal(r.status, caso.status);
			assert.equal(r.sub_status, caso.sub_status);
			assert.equal(r.recommendation, caso.recommendation);
			if (caso.suggestion !== undefined) assert.equal(r.suggestion, caso.suggestion);
		});
	}

	it('normaliza el punto inicial y expone la dirección corregida', async () => {
		const r = await validator.validate('.juan@gmail.com');
		assert.equal(r.normalized, 'juan@gmail.com');
		assert.equal(r.send_to, 'juan@gmail.com');
		assert.equal(r.normalization_applied, true);
	});

	it('conserva la dirección original tal como llegó', async () => {
		const r = await validator.validate('  Juan.Perez@Gmail.com  ');
		assert.equal(r.email, '  Juan.Perez@Gmail.com  ');
		assert.equal(r.normalized, 'juan.perez@gmail.com');
	});

	it('send_to es null cuando no es enviable', async () => {
		const r = await validator.validate('juan@gmial.com');
		assert.equal(r.sendable, false);
		assert.equal(r.send_to, null);
		assert.equal(r.suggestion, 'juan@gmail.com');
	});
});

describe('typos de dominio', () => {
	it('corta antes del DNS aunque el typosquat exista y responda', async () => {
		const { validator, resolver } = makeValidator();
		const r = await validator.validate('maria@hotmial.com');
		assert.equal(r.recommendation, 'reject');
		// hotmial.com tiene MX real en la zona de prueba: si se hubiera
		// consultado el DNS, habría pasado como válido.
		assert.equal(resolver.totalQueries, 0);
	});

	it('no corrige dominios reales que están en la lista', async () => {
		const { validator } = makeValidator();
		for (const email of ['a@ymail.com', 'a@une.net.co', 'a@hotmail.com']) {
			const r = await validator.validate(email);
			assert.equal(r.suggestion, null, `${email} no debería tener sugerencia`);
		}
	});

	it('un dominio propio declarado deja de corregirse', async () => {
		const { validator } = makeValidator();
		const sin = await validator.validate('a@gmail.co');
		assert.equal(sin.suggestion, 'a@gmail.com');

		const con = new EmailValidator({ resolver: new FakeResolver({ 'gmail.co': { a: ['1.2.3.4'] } }) });
		const r = await con.validate('a@gmail.co', { extraDomains: ['gmail.co'] });
		assert.equal(r.suggestion, null);
	});
});

describe('DNS', () => {
	it('acepta un dominio con registro A y sin MX (RFC 5321)', async () => {
		const { validator } = makeValidator();
		const r = await validator.validate('alguien@soloa.com');
		assert.equal(r.status, 'valid');
		assert.equal(r.mx_found, true);
		assert.equal(r.mx_record, null);
	});

	it('rechaza un MX nulo (RFC 7505)', async () => {
		const { validator } = makeValidator();
		const r = await validator.validate('alguien@sincorreo.com');
		assert.equal(r.sub_status, 'domain_does_not_accept_mail');
		assert.equal(r.recommendation, 'reject');
	});

	it('rechaza un dominio inexistente', async () => {
		const { validator } = makeValidator();
		const r = await validator.validate('alguien@dominio-que-no-existe-xyz.com');
		assert.equal(r.sub_status, 'no_dns_entries');
		assert.equal(r.recommendation, 'reject');
	});

	it('con el resolver caído NO descarta: unknown/confirm', async () => {
		const { validator } = makeValidator();
		const r = await validator.validate('alguien@caido.com');
		assert.equal(r.status, 'unknown');
		assert.equal(r.sub_status, 'dns_unavailable');
		assert.equal(r.recommendation, 'confirm');
		// Lo importante: sale por Enviables. Un DNS caído no puede bloquear
		// a un cliente legítimo.
		assert.equal(r.sendable, true);
	});

	it('detecta el proveedor y el catch-all desde el MX', async () => {
		const { validator } = makeValidator();
		const micro = await validator.validate('a@hotmail.com');
		assert.equal(micro.smtp_provider, 'microsoft');
		assert.equal(micro.catch_all, true);

		const google = await validator.validate('a@gmail.com');
		assert.equal(google.smtp_provider, 'google');
		assert.equal(google.catch_all, false);
	});

	it('elige el MX de menor prioridad', async () => {
		const resolver = new FakeResolver({
			'multi.com': {
				mx: [
					{ host: 'alt.example.com.', priority: 30 },
					{ host: 'principal.example.com.', priority: 5 },
				],
			},
		});
		const r = await new EmailValidator({ resolver }).validate('a@multi.com');
		assert.equal(r.mx_record, 'principal.example.com');
	});
});

describe('concurrencia', () => {
	it('100 correos del mismo dominio disparan UNA sola consulta DNS', async () => {
		const { validator, resolver } = makeValidator(10);
		const correos = Array.from({ length: 100 }, (_, i) => `usuario${i}@gmail.com`);
		const resultados = await Promise.all(correos.map((e) => validator.validate(e)));

		assert.equal(resultados.length, 100);
		assert.ok(
			resultados.every((r) => r.recommendation === 'accept'),
			'todos deberían ser válidos',
		);
		assert.equal(resolver.totalQueries, 1, 'la coalescencia debería dejar una sola consulta');
	});

	it('reutiliza la caché entre llamadas sucesivas', async () => {
		const { validator, resolver } = makeValidator();
		const primera = await validator.validate('a@gmail.com');
		const segunda = await validator.validate('b@gmail.com');

		assert.equal(primera.cached, false);
		assert.equal(segunda.cached, true);
		assert.equal(resolver.totalQueries, 1);
	});

	it('un fallo del resolver no se cachea', async () => {
		const { validator, resolver } = makeValidator();
		await validator.validate('a@caido.com');
		await validator.validate('b@caido.com');
		// Dos consultas: el fallo temporal debe reintentarse, no quedar fijo.
		assert.equal(resolver.totalQueries, 2);
	});
});

describe('entradas que no son una dirección', () => {
	const casos: Array<[string, unknown, string]> = [
		['campo inexistente', undefined, 'field_not_found'],
		['campo null', null, 'field_not_found'],
		['cadena vacía', '   ', 'empty'],
		['un array', ['a@b.com'], 'invalid_type'],
		['un número', 12345, 'invalid_type'],
	];

	for (const [etiqueta, valor, esperado] of casos) {
		it(`${etiqueta} → ${esperado}`, async () => {
			const { validator } = makeValidator();
			const r = await validator.validate(valor);
			assert.equal(r.sub_status, esperado);
			assert.equal(r.sendable, false);
		});
	}
});

describe('cuentas de rol', () => {
	it('por defecto se envían, marcadas como role_based', async () => {
		const validator = new EmailValidator({ resolver: new FakeResolver(ZONE) });
		const r = await validator.validate('info@empresa.com.co');
		assert.equal(r.recommendation, 'accept');
		assert.equal(r.sendable, true);
		assert.equal(r.role_based, true);
	});

	it('con roleIsSendable=false van a revisión', async () => {
		const validator = new EmailValidator({ resolver: new FakeResolver(ZONE) });
		const r = await validator.validate('info@empresa.com.co', { roleIsSendable: false });
		assert.equal(r.recommendation, 'manual_review');
		assert.equal(r.sendable, false);
	});

	it('siguen la cascada completa y llenan el MX', async () => {
		const validator = new EmailValidator({ resolver: new FakeResolver(ZONE) });
		const r = await validator.validate('info@empresa.com.co', { roleIsSendable: true });
		assert.equal(r.recommendation, 'accept');
		assert.equal(r.sendable, true);
		// El dato sigue disponible para ramificar aguas abajo.
		assert.equal(r.role_based, true);
		assert.equal(r.mx_found, true);
	});

	it('extraRoles añade prefijos propios', async () => {
		const validator = new EmailValidator({ resolver: new FakeResolver(ZONE) });
		const sin = await validator.validate('tesoreria@empresa.com.co');
		assert.equal(sin.role_based, false);

		const con = new EmailValidator({ resolver: new FakeResolver(ZONE) });
		const r = await con.validate('tesoreria@empresa.com.co', {
			extraRoles: ['tesoreria'],
			roleIsSendable: false,
		});
		assert.equal(r.role_based, true);
		assert.equal(r.recommendation, 'manual_review');
	});
});

describe('buzones de sistema vs buzones compartidos', () => {
	const zona = { 'empresa.com': { mx: [{ host: 'mail.empresa.com.', priority: 10 }] } };

	it('postmaster y abuse se cortan SIEMPRE, aunque se permitan las de rol', async () => {
		for (const cuenta of ['postmaster', 'abuse', 'noreply', 'mailer-daemon']) {
			const v = new EmailValidator({ resolver: new FakeResolver(zona) });
			const r = await v.validate(`${cuenta}@empresa.com`, { roleIsSendable: true });
			assert.equal(r.sub_status, 'system_mailbox', cuenta);
			assert.equal(r.recommendation, 'reject', cuenta);
			assert.equal(r.sendable, false, cuenta);
		}
	});

	it('los buzones compartidos SÍ obedecen la opción', async () => {
		for (const cuenta of ['info', 'ventas', 'licitaciones', 'contratacion']) {
			const bloqueado = new EmailValidator({ resolver: new FakeResolver(zona) });
			const a = await bloqueado.validate(`${cuenta}@empresa.com`, { roleIsSendable: false });
			assert.equal(a.sub_status, 'role_based', cuenta);
			assert.equal(a.recommendation, 'manual_review', cuenta);

			const permitido = new EmailValidator({ resolver: new FakeResolver(zona) });
			const b = await permitido.validate(`${cuenta}@empresa.com`, { roleIsSendable: true });
			assert.equal(b.recommendation, 'accept', cuenta);
			assert.equal(b.sendable, true, cuenta);
			assert.equal(b.role_based, true, cuenta);
		}
	});
});
