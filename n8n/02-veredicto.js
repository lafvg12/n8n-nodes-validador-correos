// ─── n8n Code node #2: "Veredicto" ─────────────────────────────────
// Modo: Run Once for All Items
// Lee la respuesta DNS-over-HTTPS del nodo HTTP Request anterior y
// cierra el veredicto.
//
// Status de la respuesta DoH:
//   0 + Answer  -> el dominio recibe correo
//   0 sin Answer-> el dominio existe pero no tiene MX ni A: no recibe
//   3           -> NXDOMAIN, el dominio no existe
//   otro        -> fallo del resolver: NO sabemos, no asumir que es malo

const NODO_PREVIO = 'Pre-validar';   // <-- nombre exacto del Code node #1

const PROVEEDORES = [
  ['protection.outlook.com', 'microsoft', true],
  ['outlook.com', 'microsoft', true],
  ['google.com', 'google', false],
  ['googlemail.com', 'google', false],
  ['yahoodns.net', 'yahoo', false],
  ['icloud.com', 'apple', false],
  ['apple.com', 'apple', false],
  ['secureserver.net', 'godaddy', null],
  ['zoho.com', 'zoho', null],
];

function detectarProveedor(mx) {
  if (!mx) return [null, null];
  for (const [sufijo, nombre, catchAll] of PROVEEDORES) {
    if (mx.endsWith(sufijo)) return [nombre, catchAll];
  }
  return [null, null];
}

return $input.all().map((item, i) => {
  const previo = $(NODO_PREVIO).all()[i].json;
  const v = { ...previo.validacion };
  const dns = item.json || {};

  let mx = null;
  const respuestas = Array.isArray(dns.Answer) ? dns.Answer : [];
  // type 15 = MX. Nos quedamos con la de menor prioridad.
  const registrosMx = respuestas
    .filter((r) => r.type === 15 && typeof r.data === 'string')
    .map((r) => {
      const partes = r.data.trim().split(/\s+/);
      return { prio: parseInt(partes[0], 10) || 99, host: (partes[1] || '').replace(/\.$/, '').toLowerCase() };
    })
    .sort((a, b) => a.prio - b.prio);

  if (registrosMx.length) mx = registrosMx[0].host;

  if (dns.Status === undefined || (dns.Status !== 0 && dns.Status !== 3)) {
    // El resolver fallo. No es culpa del correo: mejor enviar que descartar
    // a un cliente legitimo por una caida de DNS.
    v.estado = 'unknown';
    v.motivo = 'dns_no_disponible';
    v.recomendacion = 'confirm';
  } else if (dns.Status === 3 || (!mx && !respuestas.length)) {
    v.estado = 'invalid';
    v.motivo = v.sugerencia ? 'typo' : 'dominio_sin_correo';
    v.recomendacion = 'reject';
  } else if (mx === '' || mx === '.') {
    // Null MX (RFC 7505): el dominio declara que no recibe correo.
    v.estado = 'invalid';
    v.motivo = 'no_recibe_correo';
    v.recomendacion = 'reject';
  } else {
    const [proveedor, catchAll] = detectarProveedor(mx);
    v.mx = mx;
    v.proveedor = proveedor;
    v.catch_all = catchAll;
    if (catchAll) {
      v.estado = 'catch_all';
      v.recomendacion = 'confirm';
    } else if (v.sugerencia) {
      v.estado = 'valid';
      v.motivo = 'typo_posible';
      v.recomendacion = 'confirm';
    } else {
      v.estado = 'valid';
      v.recomendacion = 'accept';
    }
  }

  v.enviable = v.recomendacion === 'accept' || v.recomendacion === 'confirm';
  // Enviar SIEMPRE a la direccion normalizada, no a la que llego cruda.
  v.para = v.normalizado;

  return { json: { ...previo, validacion: v }, pairedItem: item.pairedItem };
});
