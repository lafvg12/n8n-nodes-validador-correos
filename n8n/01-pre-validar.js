// ─── n8n Code node #1: "Pre-validar" ───────────────────────────────
// Modo: Run Once for All Items
// Hace todo lo que no necesita red: normaliza, revisa sintaxis, typos,
// desechables, roles y basura. Lo que sobrevive sale como "pendiente"
// y va a la consulta DNS.

const CAMPO = 'email';   // <-- nombre del campo donde viene el correo

const TIER1 = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'live.com',
  'icloud.com', 'hotmail.es', 'outlook.es', 'yahoo.es',
]);

const COMUNES = new Set([
  ...TIER1,
  // ymail y rocketmail son de Yahoo y quedan a una letra de gmail.com:
  // sin este anclaje se "corregirian" por error.
  'ymail.com', 'rocketmail.com',
  'me.com', 'aol.com', 'msn.com', 'protonmail.com', 'proton.me',
  'gmx.com', 'zoho.com', 'yandex.com', 'mail.com',
  'hotmail.com.mx', 'live.com.mx', 'yahoo.com.mx',
  'hotmail.com.co', 'yahoo.com.co', 'outlook.com.co', 'live.com.co',
  'une.net.co', 'etb.net.co', 'telmex.net.co',
]);

const DESECHABLES = new Set([
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'tempmail.com',
  'temp-mail.org', 'yopmail.com', 'throwawaymail.com', 'trashmail.com',
  'sharklasers.com', 'getnada.com', 'maildrop.cc', 'dispostable.com',
  'fakeinbox.com', 'mailnesia.com', 'spamgourmet.com', 'emailondeck.com',
  'moakt.com', 'tempr.email', 'correotemporal.org', 'mohmal.com',
  'grr.la', 'mailcatch.com', 'tempmailo.com',
]);

const ROLES = new Set([
  'info', 'ventas', 'admin', 'contacto', 'soporte', 'ayuda', 'hola',
  'noreply', 'no-reply', 'sales', 'support', 'billing', 'facturacion',
  'gerencia', 'rrhh', 'marketing', 'webmaster', 'postmaster', 'abuse',
  'contact', 'team', 'office', 'administracion', 'comercial', 'pedidos',
]);

const BASURA = new Set([
  'asdf', 'asd', 'asdfasdf', 'test', 'testing', 'prueba', 'pruebas', 'aaa',
  'aaaa', 'qwerty', 'noexiste', 'nada', 'ninguno', 'xxx', 'xx', 'abc',
  '123', '1234', 'sdfsdf', 'ejemplo', 'example', 'fake', 'falso', 'none',
  'na', 'sinemail', 'nomail', 'correo',
]);

const SINTAXIS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// Damerau-Levenshtein: la transposicion cuenta como UN error.
// Con Levenshtein normal, gmial/gmail da distancia 2 y el typo se cuela.
function distancia(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  const d = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + costo);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[la][lb];
}

function buscarTypo(dominio) {
  if (COMUNES.has(dominio)) return { sugerencia: null, seguro: false };
  const limite = dominio.length <= 6 ? 1 : 2;
  let mejor = null, mejorD = 99;
  for (const cand of COMUNES) {
    const dist = distancia(dominio, cand);
    if (dist < mejorD) { mejor = cand; mejorD = dist; }
  }
  if (mejorD > limite) return { sugerencia: null, seguro: false };
  return { sugerencia: mejor, seguro: mejorD === 1 && TIER1.has(mejor) };
}

function preValidar(crudo) {
  const v = {
    original: crudo, normalizado: null, dominio: null, cuenta: null,
    estado: null, motivo: null, recomendacion: null, sugerencia: null,
    corregido: false,
  };

  if (!crudo || typeof crudo !== 'string') {
    return { ...v, estado: 'invalid', motivo: 'vacio', recomendacion: 'reject' };
  }

  // 1. Normalizar
  let email = crudo.trim().toLowerCase();
  if (email.includes('@')) {
    const corte = email.lastIndexOf('@');
    let local = email.slice(0, corte);
    const dom = email.slice(corte + 1);
    const limpio = local.replace(/^\.+|\.+$/g, '');
    if (limpio !== local) { v.corregido = true; local = limpio; }
    email = `${local}@${dom}`;
  }
  v.normalizado = email;

  // 2. Sintaxis
  if ((email.match(/@/g) || []).length !== 1 || email.includes('..') ||
      email.length > 254 || !SINTAXIS.test(email)) {
    return { ...v, estado: 'invalid', motivo: 'sintaxis', recomendacion: 'reject' };
  }

  const corte = email.lastIndexOf('@');
  const local = email.slice(0, corte);
  const dominio = email.slice(corte + 1);
  v.cuenta = local;
  v.dominio = dominio;

  if (local.length > 64) {
    return { ...v, estado: 'invalid', motivo: 'sintaxis', recomendacion: 'reject' };
  }

  // 3. Desechable (hecho del dominio: mas confiable que la heuristica del local)
  if (DESECHABLES.has(dominio)) {
    return { ...v, estado: 'do_not_mail', motivo: 'desechable', recomendacion: 'reject' };
  }

  // 4. Local part basura
  if (BASURA.has(local)) {
    return { ...v, estado: 'invalid', motivo: 'local_basura', recomendacion: 'reject' };
  }

  // 5. Typo de dominio
  const { sugerencia, seguro } = buscarTypo(dominio);
  if (sugerencia) v.sugerencia = `${local}@${sugerencia}`;
  if (seguro) {
    return { ...v, estado: 'invalid', motivo: 'typo', recomendacion: 'reject' };
  }

  // 6. Cuenta de rol
  if (ROLES.has(local)) {
    return { ...v, estado: 'do_not_mail', motivo: 'rol', recomendacion: 'manual_review' };
  }

  // Sobrevivio: falta confirmar que el dominio recibe correo.
  return { ...v, estado: 'pendiente', recomendacion: 'pendiente' };
}

return $input.all().map((item) => ({
  json: { ...item.json, validacion: preValidar(item.json[CAMPO]) },
  pairedItem: item.pairedItem,
}));
