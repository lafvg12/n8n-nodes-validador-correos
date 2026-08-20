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

> ### ⚠️ Solo para n8n autoalojado
>
> **Este nodo no funciona en n8n Cloud.** Resuelve los registros MX con el
> módulo `dns` de Node, y Cloud no permite que un community node importe
> módulos, así que tampoco puede pasar la verificación.
>
> Es una decisión deliberada: el DNS nativo es más rápido que consultar un
> resolver externo por HTTP y no le cuenta a un tercero qué dominios estás
> validando. Si necesitas compatibilidad con Cloud, hay que cambiar la
> resolución a DNS-over-HTTPS — el camino de vuelta está anotado en
> `eslint.config.mjs`.

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

---

# Referencia de campos

## Campos que añade el nodo al item

| Campo | Tipo | Qué es |
|---|---|---|
| `email` | string | **La dirección de este item**, ya normalizada. Es la que se mapea al nodo de envío. Siempre una sola, incluso si la entrada traía un array. |
| `validation` | objeto | El resultado completo, detallado abajo. |

Los demás campos del item original se conservan, salvo el array del que
salieron las direcciones. Se pueden descartar con *Incluir Campos Originales*.

## Objeto `validation`

### Identificación

| Campo | Tipo | Qué es |
|---|---|---|
| `email` | string | La dirección **tal como llegó**, sin tocar. Sirve para rastrear el origen. |
| `normalized` | string \| null | En minúsculas, sin espacios y sin puntos al inicio o final de la parte anterior al `@`. `null` si ni siquiera se pudo parsear. |
| `send_to` | string \| null | La dirección a la que enviar, o **`null` si no es enviable**. Usarla en lugar de `email` hace que un item mal enrutado falle en vez de enviarse. |
| `account` | string \| null | Lo que va antes del `@`. |
| `domain` | string \| null | Lo que va después del `@`. |

### Veredicto

| Campo | Tipo | Qué es |
|---|---|---|
| `recommendation` | enum | **El campo para ramificar.** Ver tabla abajo. |
| `sendable` | boolean | `true` si `recommendation` es `accept` o `confirm`. Es lo que decide por cuál de las dos salidas sale el item. |
| `status` | enum | Clasificación general. Informativo. |
| `sub_status` | enum \| null | El motivo concreto. `null` cuando no hubo nada que reportar. |
| `suggestion` | string \| null | La dirección corregida cuando el dominio parece un error de tipeo. **Esto es dinero**: es un cliente real que escribió mal. |

### Datos del dominio

| Campo | Tipo | Qué es |
|---|---|---|
| `mx_found` | boolean | Si el dominio puede recibir correo. `false` también cuando la cascada cortó antes de consultar el DNS. |
| `mx_record` | string \| null | El servidor de correo de menor prioridad. `null` si la entrega va por registro A, sin MX. |
| `smtp_provider` | string \| null | `microsoft`, `google`, `yahoo`, `apple`, `zoho`, `godaddy`… Deducido del MX. `null` si no se reconoce. |
| `catch_all` | boolean \| null | `true` si el dominio acepta cualquier destinatario. `null` significa **desconocido**, no `false`. |
| `domain_age_days` | number \| null | Días desde que se registró el dominio. Requiere activar *Consultar Edad Del Dominio*. `null` en `.co`, `.es`, `.mx` y otros que no publican RDAP. |

### Clasificación de la dirección

| Campo | Tipo | Qué es |
|---|---|---|
| `free_email` | boolean | Proveedor gratuito: Gmail, Hotmail, Yahoo, Proton… |
| `role_based` | boolean | Buzón de empresa (`info@`, `ventas@`, `licitaciones@`) o de sistema (`postmaster@`). Queda en `true` aunque se decida enviarle. |
| `disposable` | boolean | Correo temporal tipo Mailinator. |
| `normalization_applied` | boolean | `true` solo si hubo que quitar puntos del borde. Pasar a minúsculas y recortar espacios no cuenta. |

### Diagnóstico

| Campo | Tipo | Qué es |
|---|---|---|
| `cached` | boolean | `true` si el DNS del dominio ya se había consultado, o si otra validación simultánea del mismo dominio lo estaba haciendo. |
| `duration_ms` | number | Lo que tardó esta validación. Suele ser `0` con caché. |
| `checked_at` | string | Marca de tiempo ISO 8601. |
| `field_searched` | string | **Solo aparece** cuando `sub_status` es `field_not_found`: dice qué nombre de campo se buscó y no existía. |

## Valores de `recommendation`

`status` y `sub_status` son informativos. Este es el que define la acción.

| Valor | Significado | Salida |
|---|---|---|
| `accept` | Dominio real, nada sospechoso. | Enviables |
| `confirm` | Puede existir, no se puede saber más. | Enviables |
| `manual_review` | Decisión de negocio, no un defecto de la dirección. | Descartados |
| `reject` | Imposible, desechable o typo evidente. | Descartados |

`accept` y `confirm` llevan a la misma acción. Es intencional: la distinción
existe para reportería, no para lógica de envío.

## Valores de `status`

| Valor | Significado |
|---|---|
| `valid` | La dirección es plausible y el dominio recibe correo. **No significa que el buzón exista.** |
| `invalid` | Imposible de entregar: sintaxis rota, dominio inexistente o typo evidente. |
| `do_not_mail` | Entregable, pero no conviene enviarle: desechable, buzón de sistema o de rol. |
| `catch_all` | El dominio acepta cualquier destinatario, así que no se puede saber nada más. Típico de Microsoft 365. |
| `unknown` | No se pudo averiguar, normalmente porque el DNS no respondió. Se envía igual. |

## Valores de `sub_status`

| Valor | Cuándo aparece | Recomendación |
|---|---|---|
| `failed_syntax_check` | Sin `@`, con dos `@`, puntos dobles, más de 254 caracteres, o más de 64 antes del `@`. | `reject` |
| `possible_typo` | El dominio se parece a uno común. Con `reject` viene la corrección en `suggestion`. | `reject` o `confirm` |
| `no_dns_entries` | El dominio no existe o no tiene ni MX ni registro A. | `reject` |
| `domain_does_not_accept_mail` | El dominio declara explícitamente que no recibe correo (MX nulo, RFC 7505). | `reject` |
| `disposable` | Dominio de correo temporal. | `reject` |
| `junk_local_part` | Relleno conocido: `asdf@`, `test@`, `prueba@`. | `reject` |
| `suspicious_pattern` | Parece tecleo al azar: `xxxxxyyyy@`, `qwerty@`. Es sospecha, no certeza. | `manual_review` |
| `system_mailbox` | `postmaster@`, `abuse@`, `noreply@`. Ver la advertencia abajo. | `reject` |
| `role_based` | Buzón compartido de empresa y la opción está en *Mandar a Revisión*. | `manual_review` |
| `dns_unavailable` | El resolver falló o se agotó el tiempo. **No es culpa de la dirección.** | `confirm` |
| `field_not_found` | El campo configurado no existe en el item. Es un error de configuración. | `reject` |
| `invalid_type` | El campo existe pero no contiene texto. | `reject` |
| `empty` | El campo está vacío. | `reject` |

> **Sobre `system_mailbox`:** `postmaster@` y `abuse@` los exige el RFC 2142 en
> todo dominio y se usan como trampa para detectar listas no consentidas.
> Enviarles publicidad puede hacer que **todo tu dominio** termine en listas
> negras, no solo ese correo. `noreply@` y similares descartan lo que reciben.
> Por eso se bloquean siempre y ninguna opción los habilita.

---

# Referencia de opciones

## Correo a Validar

**Requerido. Por defecto: `email`.**

De dónde sacar la dirección. Acepta las dos formas naturales en n8n: el
**nombre de un campo** (`emails`) o una **expresión** que ya entregue la
dirección (`{{ $json.emails }}`). Las distingue porque una dirección lleva `@`
y un nombre de campo no.

Si el valor es un array, se emite un item de salida por cada dirección.

## Opciones adicionales

Se agregan una por una con *Agregar Opción*; las que no agregues usan su valor
por defecto.

### Consultar Edad Del Dominio
**Por defecto: apagado.** Llena `domain_age_days` consultando RDAP. Añade una
petición HTTP por dominio, cacheada 24 horas. Consulta el registro de IANA para
ir al servidor autoritativo de cada TLD.

Los dominios **`.co`, `.com.co`, `.es` y `.mx` no publican RDAP**, así que ahí
el campo queda en `null` siempre. No hay forma de obtenerlo.

### Cuentas Catch-All
**Por defecto: Tratar Como Enviable.** Qué hacer con dominios que aceptan
cualquier destinatario, como Microsoft 365. No se puede saber si el buzón
existe, así que por defecto se envía con `confirm`. En *Mandar a Revisión*
salen por Descartados.

### Cuentas De Rol
**Por defecto: Tratar Como Enviable.** Qué hacer con buzones compartidos de
empresa: `info@`, `ventas@`, `licitaciones@`.

Son buzones reales que alguien lee, y excluirlos no tiene fundamento técnico
—es una convención del marketing B2C, donde nadie en concreto dio su
consentimiento. En venta a empresas suelen ser justo el destinatario buscado,
por eso el default es enviar. `role_based` queda en `true` de todos modos para
poder ramificar.

Esto **no** afecta a `postmaster@`, `abuse@` ni `noreply@`, que se bloquean
siempre.

### Detectar Patrones De Relleno
**Por defecto: encendido.** Marca partes locales que parecen tecleo al azar:
pocos caracteres distintos (`xxxxxyyyy`), un carácter repetido cuatro veces o
más (`aaaa`), tecleo corrido sobre una fila del teclado (`qwerty`, `asdfgh`), o
siete caracteres sin una sola vocal ni dígitos.

Salen como `manual_review`, no `reject`: es una sospecha. Las reglas están
calibradas contra un corpus de nombres reales para no descartar clientes —el
error caro es perder a uno de verdad, no dejar pasar uno falso.

### Dominios Comunes Adicionales
**Por defecto: vacío.** Dominios separados por coma. Cumplen dos funciones:
sirven de referencia al corrector de typos, y **evitan que se corrijan por
error**. Si tienes un dominio propio parecido a uno común, decláralo aquí.

### Dominios Desechables Adicionales
**Por defecto: vacío.** Amplía la lista de correos temporales, separados por
coma.

### Prefijos De Rol Adicionales
**Por defecto: vacío.** Suma prefijos propios a la lista de buzones
compartidos: `contratacion`, `tesoreria`, los que uses. Separados por coma, sin
el `@`.

### Incluir Campos Originales
**Por defecto: encendido.** Conserva el resto de los campos del item —`nombre`,
`id`, lo que traigas— junto a la validación. Necesario para personalizar el
correo. Apagado deja una salida limpia con solo `email` y `validation`.

### Tiempo Límite De DNS (Ms)
**Por defecto: 3000.** Al agotarse, el resultado es `unknown` / `confirm`,
**nunca un rechazo**: un DNS lento no puede bloquear a un cliente legítimo.

### Tiempo Límite De RDAP (Ms)
**Por defecto: 5000.** Solo aplica si *Consultar Edad Del Dominio* está activo.

### Vigencia De La Caché (Minutos)
**Por defecto: 360** (6 horas). Cuánto se reutiliza el resultado DNS de un
dominio. Es la opción que más rinde: todos tus contactos de Gmail comparten una
sola consulta. Los fallos del resolver nunca se cachean.

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
