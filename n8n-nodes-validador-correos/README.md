# n8n-nodes-validador-correos

**Este nodo no confirma que un buzón exista.** Determina si una dirección es
*imposible* o *sospechosa* antes de enviarle: sintaxis rota, dominios que no
reciben correo, desechables, cuentas de rol y errores de tipeo en el dominio.
Si `juanperez99@gmail.com` está bien escrita y `gmail.com` recibe correo, este
nodo dirá `valid` exista o no ese buzón. La existencia real solo la confirma un
envío y su rebote.

Sirve para reducir la basura de entrada antes de una campaña. Lo que protege de
verdad la reputación del dominio remitente es el doble opt-in y la lista de
supresión de rebotes, no esto.

## Qué revisa

| Chequeo | Ejemplo | Resultado |
|---|---|---|
| Sintaxis | `sin-arroba`, `a@@b.com` | `reject` |
| Dominio desechable | `x@mailinator.com` | `reject` |
| Local part basura | `asdf@dominio.com` | `reject` |
| Patrón de relleno | `xxxxxyyyy@gmail.com` | `manual_review` |
| Cuenta de rol | `info@empresa.com` | `manual_review` |
| Typo de dominio | `juan@gmial.com` | `reject` + sugiere `juan@gmail.com` |
| Dominio sin correo | `x@dominio-muerto.com` | `reject` |
| DNS caído | cualquiera | `confirm` — **nunca descarta** |

## Instalación

Requiere Node 22 o superior.

```bash
# En la instancia autoalojada
docker exec -it n8n sh
mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes
npm i /ruta/al/paquete
# reiniciar n8n
```

Alternativa sin entrar al contenedor: apuntar `N8N_CUSTOM_EXTENSIONS` a la
carpeta que contiene el nodo.

## Uso

Se conecta antes del nodo de envío. Tiene **dos salidas**:

```
[contactos] → [Validador de Correos] ─ Enviables ──→ [Resend]
                                     └ Descartados → [Sheets / revisión]
```

**Correo a Validar** acepta las dos formas naturales en n8n: el nombre de un
campo (`emails`) o una expresión que ya entregue la dirección
(`{{ $json.emails }}`).

Si el campo trae un array, se emite un item de salida por dirección y el array
de origen se retira de la salida, para que no quede la tentación de mapearlo al
nodo de envío y mandar varias direcciones juntas.

En el nodo de envío usa **`{{ $json.email }}`**, que siempre trae una sola
dirección ya normalizada. O `{{ $json.validation.send_to }}`, que es el mismo
valor pero viene en `null` si el correo no era enviable — así un item que se
cuele por la rama equivocada falla en vez de enviarse.

### La tabla que importa

`status` y `sub_status` son informativos. El campo para ramificar es
`recommendation`:

| Valor | Significado | Salida |
|---|---|---|
| `accept` | dominio real, nada sospechoso | Enviables |
| `confirm` | puede existir, no se puede saber más | Enviables |
| `manual_review` | cuenta de rol o patrón raro: decisión de negocio | Descartados |
| `reject` | imposible, desechable o typo evidente | Descartados |

`accept` y `confirm` llevan a la misma acción. Es intencional: la distinción
existe para reportería, no para lógica de envío.

### Salida

```json
{
  "email": "lafvg12@hotmail.com",
  "validation": {
    "email": "lafvg12@hotmail.com",
    "normalized": "lafvg12@hotmail.com",
    "send_to": "lafvg12@hotmail.com",
    "status": "catch_all",
    "sub_status": null,
    "recommendation": "confirm",
    "sendable": true,
    "suggestion": null,
    "account": "lafvg12",
    "domain": "hotmail.com",
    "free_email": true,
    "role_based": false,
    "disposable": false,
    "normalization_applied": false,
    "mx_found": true,
    "mx_record": "hotmail-com.olc.protection.outlook.com",
    "smtp_provider": "microsoft",
    "catch_all": true,
    "domain_age_days": 11103,
    "checked_at": "2026-08-20T16:38:09.370Z",
    "cached": false,
    "duration_ms": 596
  }
}
```

Los nombres siguen la convención de ZeroBounce para que un flujo pueda cambiar
de uno al otro sin reescribir las ramas. Con una diferencia deliberada: donde
ZeroBounce responde `valid` y añade `catch_all_domain: true`, este nodo pone
`catch_all` directamente en el `status`. Si el dominio acepta cualquier
destinatario, decir "válido" promete algo que nadie puede saber.

## Opciones

| Opción | Default | Para qué |
|---|---|---|
| Cuentas Catch-All | Enviable | Si Microsoft 365 y similares salen por Enviables o a revisión |
| Detectar Patrones De Relleno | Sí | Marca `xxxxxyyyy`, `qwerty`, `aaaa` |
| Dominios Comunes Adicionales | — | Tus dominios, para que el corrector de typos no los altere |
| Dominios Desechables Adicionales | — | Amplía la lista de desechables |
| Prefijos De Rol Adicionales | — | `licitaciones`, `contratacion`, los que uses |
| Consultar Edad Del Dominio | No | Llena `domain_age_days` vía RDAP |
| Incluir Campos Originales | Sí | Conserva `nombre`, `id`, etc. junto a la validación |
| Vigencia De La Caché (min) | 360 | Reutilización del resultado DNS por dominio |
| Tiempo Límite De DNS (ms) | 3000 | Al agotarse: `unknown`/`confirm`, nunca rechazo |

### Sobre la edad del dominio

Viene apagada porque añade una petición HTTP por dominio. Consulta el registro
de IANA para ir al servidor RDAP autoritativo de cada TLD, y cachea 24 horas.

**Los dominios `.co`, `.com.co`, `.es` y `.mx` no publican RDAP**, así que para
esos el campo queda en `null` siempre. No hay forma de obtenerlo.

## Límites conocidos

No hace sondeo SMTP: el puerto 25 saliente está cerrado en el entorno de
despliegue, y contra Microsoft no daría información porque acepta cualquier
destinatario. Contra Gmail sí daría algo, así que un servicio de pago puede
detectar buzones inexistentes de Gmail que este nodo no.

En modo cola con varios workers, **la caché es por proceso**: cada worker
mantiene la suya, así que la tasa de aciertos baja. Es aceptable y no se
resuelve aquí.

El corrector de typos usa umbral de distancia 2 para dominios de más de 6
caracteres. Un dominio corporativo a distancia 2 de uno común recibirá una
sugerencia y bajará de `accept` a `confirm` — sigue saliendo por Enviables.
Declararlo en *Dominios Comunes Adicionales* lo evita.

## Desarrollo

```bash
npm install
npm run dev     # n8n local en :5678 con el nodo cargado, recompila solo
npm test        # 123 tests, sin red
npm run lint
npm run build
```

Los tests usan el runner nativo de Node, sin dependencias extra. El DNS está
detrás de la interfaz `DnsResolver`, así que las pruebas inyectan un resolver
falso y ninguna sale a la red.

### Estructura

```
nodes/ValidadorCorreos/
├── ValidadorCorreos.node.ts   # interfaz de n8n: parámetros, dos salidas
├── validador.ts               # orquestador y API pública
├── core/
│   ├── rules.ts               # la cascada, una regla por chequeo
│   ├── analysis.ts            # funciones puras: distancia, typos, relleno
│   ├── dns.ts                 # DnsResolver (interfaz) + caché
│   ├── rdap.ts                # edad del dominio
│   ├── cache.ts               # caché con TTL y coalescencia
│   └── types.ts               # contrato de salida
└── data/lists.ts              # dominios, desechables, roles, proveedores
```

**Para agregar un chequeo nuevo**: escribe una regla en `core/rules.ts`,
insértala en `defaultRules` en la posición que le corresponda, y añade su test.
El orden importa: cada corte ahorra los siguientes, y el de DNS es el único que
cuesta red.

**Para agregar dominios a una lista**: `data/lists.ts`. No hace falta tocar la
lógica.
