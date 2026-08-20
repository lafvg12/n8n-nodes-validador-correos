/**
 * Funciones puras: distancia de edición, detección de relleno, normalización.
 *
 * El bloque de falsos positivos es el más importante del repositorio. El
 * error caro no es dejar pasar un correo falso —ese lo atrapa el rebote y
 * no cuesta nada— sino descartar a un cliente real, que se pierde en
 * silencio y nadie se entera.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	editDistance,
	findTypo,
	hasValidSyntax,
	looksLikeFiller,
	normalizeEmail,
} from '../nodes/ValidadorCorreos/core/analysis';
import { baseLists, buildLists } from '../nodes/ValidadorCorreos/data/lists';

describe('editDistance (Damerau-Levenshtein)', () => {
	it('la transposición cuenta como UN error, no dos', () => {
		// Este es el motivo de usar Damerau y no Levenshtein a secas: con
		// Levenshtein estas dan 2 y los typos más frecuentes se colarían.
		assert.equal(editDistance('gmial.com', 'gmail.com'), 1);
		assert.equal(editDistance('hotmial.com', 'hotmail.com'), 1);
	});

	it('cuenta inserciones, borrados y sustituciones', () => {
		assert.equal(editDistance('gmail.com', 'gmail.com'), 0);
		assert.equal(editDistance('gmail.comz', 'gmail.com'), 1);
		assert.equal(editDistance('gmail.co', 'gmail.com'), 1);
		assert.equal(editDistance('ymail.com', 'gmail.com'), 1);
	});

	it('maneja cadenas vacías', () => {
		assert.equal(editDistance('', ''), 0);
		assert.equal(editDistance('abc', ''), 3);
		assert.equal(editDistance('', 'abc'), 3);
	});
});

describe('findTypo', () => {
	it('marca alta confianza solo contra dominios de primer nivel', () => {
		const gmial = findTypo('gmial.com', baseLists);
		assert.equal(gmial.suggestion, 'gmail.com');
		assert.equal(gmial.highConfidence, true);
	});

	it('un dominio exacto de la lista nunca se corrige', () => {
		for (const domain of ['gmail.com', 'ymail.com', 'une.net.co', 'proton.me']) {
			assert.equal(findTypo(domain, baseLists).suggestion, null, domain);
		}
	});

	it('un dominio corporativo cualquiera no recibe sugerencia', () => {
		for (const domain of [
			'ffsoluciones.com',
			'alianzaestrategicasas.com',
			'miempresa.com.co',
			'universidad.edu.co',
		]) {
			assert.equal(findTypo(domain, baseLists).suggestion, null, domain);
		}
	});

	it('extraDomains protege un dominio propio de ser corregido', () => {
		const lists = buildLists({ domains: ['gmail.co'] });
		assert.equal(findTypo('gmail.co', lists).suggestion, null);
	});
});

describe('looksLikeFiller', () => {
	// Nombres realistas, sobre todo colombianos. NINGUNO debe marcarse.
	const reales = [
		'juan.perez',
		'maria.gomez',
		'lafvg12',
		'andresfernandez',
		'jmrodriguez',
		'c.martinez',
		'luisitog1228',
		'ana_maria',
		'dcastano',
		'jgutierrez88',
		'mvillegas',
		'sofia.ramirez',
		'kmontoya',
		'edwin.ospina',
		'yuli.zapata',
		'wbecerra',
		'nrestrepo',
		'jhon.jairo',
		'mgarcia',
		'pcardenas',
		'fsalazar',
		'cmvb',
		'jj',
		'ana',
		'lu',
		'contabilidad2024',
		'jorge.andres.lopez',
		'maria-jose',
		'n.torres',
		'laura90',
		'sebas',
		'pipe',
		'dahiana',
		'yeison',
		'brayan',
		'estiven',
		'deivid',
		'nikolle',
		'maryuri',
		'jsanchez',
		'rgiraldo',
		'licitaciones',
		'javiergarciay11',
		'director.licitaciones',
	];

	const relleno = [
		'xxxxxyyyy',
		'xxxxxx',
		'aaaaaa',
		'qwerty123',
		'asdfghjk',
		'zxcvbnm1',
		'111111',
		'qqqqqq',
		'abababab',
		'xyxyxyxy',
		'wwwwww',
		'poiuytre',
		'lkjhgfds',
		'12345678',
	];

	for (const nombre of reales) {
		it(`no marca "${nombre}" (nombre real)`, () => {
			assert.equal(looksLikeFiller(nombre), false);
		});
	}

	for (const nombre of relleno) {
		it(`marca "${nombre}" (relleno)`, () => {
			assert.equal(looksLikeFiller(nombre), true);
		});
	}

	it('no juzga local parts demasiado cortos', () => {
		assert.equal(looksLikeFiller('ab'), false);
		assert.equal(looksLikeFiller('xxx'), false);
	});
});

describe('normalizeEmail', () => {
	it('quita el punto inicial del local part y lo reporta', () => {
		assert.deepEqual(normalizeEmail('.juan@gmail.com'), {
			email: 'juan@gmail.com',
			changed: true,
		});
	});

	it('quita también el punto final', () => {
		assert.deepEqual(normalizeEmail('juan.@GMAIL.com'), {
			email: 'juan@gmail.com',
			changed: true,
		});
	});

	it('no marca cambio cuando solo hubo trim y minúsculas', () => {
		assert.deepEqual(normalizeEmail('  Juan@Gmail.com '), {
			email: 'juan@gmail.com',
			changed: false,
		});
	});

	it('deja intacto un correo ya normalizado', () => {
		assert.deepEqual(normalizeEmail('juan@gmail.com'), {
			email: 'juan@gmail.com',
			changed: false,
		});
	});
});

describe('hasValidSyntax', () => {
	const validos = ['a@b.co', 'juan.perez@gmail.com', "o'brien@dominio.com", 'a+tag@x.com'];
	const invalidos = [
		'sin-arroba',
		'a@@b.com',
		'a..b@x.com',
		'@x.com',
		'a@',
		'a@x',
		`${'a'.repeat(65)}@gmail.com`,
		`${'a'.repeat(250)}@gmail.com`,
	];

	for (const email of validos) {
		it(`acepta ${email}`, () => assert.equal(hasValidSyntax(email), true));
	}
	for (const email of invalidos) {
		it(`rechaza ${email.slice(0, 30)}`, () => assert.equal(hasValidSyntax(email), false));
	}
});
