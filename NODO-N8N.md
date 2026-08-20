# Nodo custom de n8n: Validador de Correos — Especificación

> **Instrucción de arranque:** lee este documento completo antes de escribir código.
> Construye un nodo community de n8n, empaquetado como npm, instalable en una
> instancia autoalojada. No construyas un microservicio HTTP, no construyas un
> webhook, no construyas un CLI. Solo el nodo.

---

## 1. Qué hace el nodo

Recibe items con una dirección de correo y decide, para cada uno, si vale la
pena enviarle. Se usa dentro de flujos de campañas de marketing, justo antes
del nodo de envío (Resend), para evitar rebotes que dañen la reputación del
dominio remitente.

## 2. Qué NO hace — leer con atención

Estas no son preferencias, son hechos del entorno. Respetarlas evita construir
algo que no funciona:

1. **No determina si un buzón existe.** Determina si una dirección es
   *imposible* o *sospechosa*. Nada más. El naming, la documentación y los
   campos de salida deben reflejarlo con honestidad. **No uses el término
   "verified"** en ninguna parte, ni `mailbox_not_found` como motivo.

2. **No hace sondeo SMTP (`RCPT TO`).** El puerto 25 saliente está cerrado en
   el entorno de despliegue. No lo implementes, no lo dejes detrás de un flag,
   no lo pongas "por si acaso". Simplemente no existe en este nodo.

3. **Hotmail, Outlook, Microsoft 365 y Gmail son catch-all o limitan por tasa.**
   Aceptan cualquier destinatario o cortan la conexión. Ningún sondeo daría
   información útil ahí, y ahí vive la mayoría de la base de contactos.

4. **Ante la duda, deja pasar.** Si el DNS falla o no responde, el veredicto es
   `unknown` con recomendación `confirm`, nunca `reject`. Un validador con
   problemas no puede bloquear el envío a clientes legítimos.

## 3. Entrada y salida

### Entrada

Items con un campo de texto que contiene la dirección. El nombre del campo es
configurable en la UI del nodo (por defecto `email`).

### Salida

El nodo tiene **dos salidas**:

- **Salida 0 — Enviables:** los items cuya recomendación es `accept` o
  `confirm`. Se conectan al nodo de envío.
- **Salida 1 — Descartados:** el resto. Se conectan a una hoja de cálculo o a
  una notificación, para revisión manual.

Que sean dos salidas y no una es deliberado: evita que el usuario tenga que
poner un nodo Filter después, y hace visible en el canvas que hay correos que
no se envían.

Cada item de salida conserva sus campos originales, añade un campo plano
`email` con **la** dirección de ese item, y un objeto `validation`:

```json
{
  "email": "juan@gmial.com",
  "validation": {
    "email": "  Juan@Gmial.com ",
    "normalized": "juan@gmial.com",
    "send_to": null,
    "account": "juan",
    "domain": "gmial.com",
    "status": "invalid",
    "sub_status": "possible_typo",
    "recommendation": "reject",
    "suggestion": "juan@gmail.com",
    "sendable": false,
    "free_email": false,
    "role_based": false,
    "disposable": false,
    "normalization_applied": false,
    "mx_found": false,
    "mx_record": null,
    "smtp_provider": null,
    "catch_all": null,
    "domain_age_days": null,
    "checked_at": "2026-08-20T16:38:09.370Z",
    "cached": false,
    "duration_ms": 84
  }
}
```

> **Nombres en inglés, por decisión.** Una versión anterior de este documento
> los tenía en español. Se cambiaron a la convención de ZeroBounce para que un
> flujo pueda pasar de uno al otro sin reescribir las ramas del Switch.

El campo **`email`** de nivel superior es el que se usa en el nodo de envío:
trae una sola dirección, ya normalizada. Dentro de `validation`, **`send_to`**
es el mismo valor pero viene en `null` cuando no es enviable, así que sirve
como red de seguridad si un item se cuela por la rama equivocada.

Cuando el campo de entrada trae un array, el nodo emite un item por dirección
y **retira el array de la salida**, para que nadie lo mapee al nodo de envío y
mande varias direcciones juntas.

### El campo `recommendation` es el que importa

`status` y `sub_status` son informativos. Este es el que define la acción:

| Valor | Significado | Salida | Qué se hace |
|---|---|---|---|
| `accept` | dominio real, nada sospechoso | 0 | enviar |
| `confirm` | puede existir, no se puede saber más | 0 | enviar igual |
| `manual_review` | cuenta de rol, decisión de negocio | 1 | revisar, no enviar campaña |
| `reject` | imposible, desechable o typo evidente | 1 | no enviar |

`accept` y `confirm` llevan a la misma acción. Es intencional: la distinción
existe para reportería, no para lógica de envío.

## 4. La cascada de validación — orden exacto

**El orden importa**: cada paso que corta ahorra los siguientes, y el paso de
DNS es el único que cuesta tiempo.

```
1. Normalizar
   - trim, lowercase
   - quitar puntos iniciales y finales del local part
   - si cambió algo, marcar corregido = true

2. Sintaxis (RFC 5322 pragmático)
   - un solo @, local ≤ 64 chars, total ≤ 254, sin ".."
   - FALLA → invalid / sintaxis / reject
   - NO uses una regex "completa de RFC 5322", son ilegibles e inútiles.
     Una regex pragmática + chequeos de longitud explícitos.

3. Dominio desechable
   - FALLA → do_not_mail / desechable / reject

4. Local part basura (asdf, test, prueba, qwerty, noexiste...)
   - FALLA → invalid / local_basura / reject

5. Cuenta de rol (info@, ventas@, admin@...)
   - FALLA → do_not_mail / rol / manual_review

6. Typo de dominio (ver §5.1)
   - distancia 1 contra un dominio de primer nivel → invalid / typo / reject
   - distancia dentro del umbral contra cualquier otro común → guardar
     sugerencia y seguir, no cortar

7. Resolución MX (con caché)
   - sin MX → intentar registro A como fallback (RFC 5321 lo permite)
   - Null MX (registro MX con host ".") → invalid / no_recibe_correo / reject
   - NXDOMAIN o sin nada → invalid / reject
       con sugerencia del paso 6 → motivo "typo"
       sin sugerencia          → motivo "dominio_sin_correo"
   - fallo del resolver (SERVFAIL, timeout) → unknown / dns_no_disponible / confirm

8. Detectar proveedor SMTP desde el MX
   *.protection.outlook.com  → microsoft
   *.google.com / aspmx.l.*  → google
   *.yahoodns.net            → yahoo
   *.icloud.com              → apple
   ... (extender la tabla)

9. Catch-all conocido
   - microsoft → true
   - google, yahoo, apple → false
   - resto → null (desconocido, y así se reporta)

10. Veredicto final
    - catch_all == true  → catch_all / confirm
    - con sugerencia     → valid / confirm, y devolver la sugerencia igual
    - todo limpio        → valid / accept
```

## 5. Decisiones que NO se deben "corregir"

Estas cuatro parecen errores y no lo son. Están así a propósito, verificadas
contra casos reales. Si las cambias, los casos de prueba del §9 dejan de pasar.

### 5.1 Damerau-Levenshtein, no Levenshtein

Los typos de dominio más frecuentes son **transposiciones**: `gmial` por
`gmail`, `hotmial` por `hotmail`. Levenshtein a secas le asigna distancia **2**
a una transposición, así que con un umbral de 1 esos typos se cuelan como
válidos. Damerau-Levenshtein cuenta la transposición como **un solo error**.

Umbral: distancia ≤ 1 si el dominio tiene ≤ 6 caracteres, ≤ 2 si es más largo.

**Corte de alta confianza:** si la distancia es exactamente 1 contra un dominio
de primer nivel (gmail, hotmail, outlook, yahoo, live, icloud y sus variantes
.es), se corta de una como `reject` **sin importar lo que diga el DNS**. Esto
es necesario porque los dominios typosquatting existen y responden: `hotmial.com`
tiene MX real y `gmial.com` tiene registro A. Si esperas al DNS, pasan.

**Ancla de coincidencia exacta:** si el dominio está tal cual en la lista de
comunes, no se sugiere nada y se sigue. Sin esto, `ymail.com` (dominio real de
Yahoo, a distancia 1 de `gmail.com`) se "corregiría" por error. Incluye
`ymail.com` y `rocketmail.com` en la lista de comunes justamente por eso.

### 5.2 Desechable antes que local part basura

`test@mailinator.com` cae en las dos listas. Debe reportarse como `desechable`,
no como `local_basura`: un hecho del dominio es más confiable que una
heurística sobre el nombre de la cuenta.

### 5.3 Rol antes que DNS

La cuenta de rol es un corte terminal y no necesita red. Ponerla antes de la
resolución MX ahorra una consulta por cada `info@` de la lista.

### 5.4 El estado `unknown` existe

NXDOMAIN y SERVFAIL son cosas opuestas. El primero significa que el dominio no
existe; el segundo, que no pudimos averiguarlo. Tratarlos igual hace que una
caída momentánea de DNS bloquee clientes buenos. Timeout del resolver: 3
segundos, con un solo reintento.

## 6. Parámetros del nodo en la UI

| Parámetro | Tipo | Default | Descripción |
|---|---|---|---|
| `campoEmail` | string | `email` | Campo del item que contiene la dirección |
| `tratarCatchAllComo` | options | `enviable` | `enviable` o `revision` |
| `dominiosExtra` | string | vacío | Dominios comunes adicionales, separados por coma, para el detector de typos |
| `desechablesExtra` | string | vacío | Dominios desechables adicionales |
| `ttlCacheMinutos` | number | `360` | Vigencia de la caché de MX |
| `timeoutDnsMs` | number | `3000` | Timeout de la consulta DNS |

`dominiosExtra` es importante para el contexto colombiano: la lista base ya
debe traer `une.net.co`, `etb.net.co`, `telmex.net.co`, `hotmail.com.mx`,
`live.com.mx`, `yahoo.com.mx`, `outlook.es` y `hotmail.es`, pero el usuario
tiene que poder agregar los suyos sin reinstalar el nodo.

## 7. DNS dentro de un custom node

**Ventaja frente al Code node:** un custom node es un módulo de Node normal
dentro del proceso de n8n, no corre en el sandbox del Code node. Puede importar
`dns` directamente:

```ts
import { promises as dns } from 'dns';
const registros = await dns.resolveMx(dominio);
```

No requiere `NODE_FUNCTION_ALLOW_BUILTIN` ni ninguna variable de entorno. Esa
restricción aplica solo al Code node.

Usa `dns.resolveMx()` y, si devuelve vacío o `ENODATA`, cae a `dns.resolve4()`.
Distingue los códigos de error: `ENOTFOUND` es dominio inexistente,
`ESERVFAIL` y `ETIMEOUT` son "no sabemos" y van a `unknown`.

## 8. Caché y concurrencia

**Caché de MX por dominio**, en memoria a nivel de módulo, con TTL configurable
(default 6 horas). Es el que rinde: todos los contactos de Gmail comparten una
sola consulta.

**Coalescencia de peticiones en vuelo.** Un `Map<string, Promise>` de consultas
en curso: si llegan 100 items del mismo dominio a la vez, el primero dispara la
consulta y los otros 99 esperan esa misma promesa. Sin esto, los 100 fallan la
caché antes de que ninguno la escriba y se disparan 100 consultas idénticas.
Este punto es fácil de omitir y es la causa del test de concurrencia del §9.

Nota: si la instancia corre en modo cola con varios workers, la caché es por
proceso. Es aceptable y hay que documentarlo, no resolverlo.

## 9. Casos de prueba obligatorios

Usa mocks para el DNS. Los tests no deben depender de la red.

```
"juan.perez@gmail.com"    → valid / accept
"juan@gmial.com"          → invalid / possible_typo / reject, suggestion juan@gmail.com
"maria@hotmial.com"       → invalid / possible_typo / reject, suggestion maria@hotmail.com
"lafvg12@hotmail.com"     → catch_all / confirm
"asdf@asdf.com"           → invalid / junk_local_part / reject
"info@empresa.com.co"     → do_not_mail / role_based / manual_review
"test@mailinator.com"     → do_not_mail / disposable / reject
"sin-arroba"              → invalid / failed_syntax_check / reject
"a@@b.com"                → invalid / failed_syntax_check / reject
".juan@gmail.com"         → valid / accept, normalization_applied=true, send_to=juan@gmail.com
"a"*65 + "@gmail.com"     → invalid / failed_syntax_check / reject
"alguien@ymail.com"       → valid / accept, SIN suggestion
"alguien@une.net.co"      → valid / accept, SIN suggestion
```

Implementados en `test/cascada.test.ts`. Se corren con `npm test`, usan el
runner nativo de Node y un `FakeResolver` que declara la zona DNS a mano, así
que ninguno sale a la red.

Los dos últimos son controles de falso positivo: verifican que el detector de
typos no arruine dominios reales.

**Test de concurrencia:** 100 items del mismo dominio deben disparar **una
sola** consulta DNS.

**Test de fallo de DNS:** con el resolver devolviendo SERVFAIL, el resultado
debe ser `unknown` / `confirm` y salir por la salida 0, nunca `reject`.

## 10. Estructura del paquete npm

Arranca del repositorio `n8n-nodes-starter`, que ya trae el esqueleto.

- El nombre del paquete **debe empezar por `n8n-nodes-`**. Sugerido:
  `n8n-nodes-validador-correos`. n8n valida esto al instalar.
- `package.json` debe incluir:
  - keyword `n8n-community-node-package`
  - `"files": ["dist"]` — se publica el JavaScript compilado, no el TypeScript
  - el objeto `n8n` con `n8nNodesApiVersion: 1` y la ruta al nodo compilado:
    ```json
    "n8n": {
      "n8nNodesApiVersion": 1,
      "nodes": ["dist/nodes/ValidadorCorreos/ValidadorCorreos.node.js"]
    }
    ```
- El nodo es **estilo programático**: una clase que hace `implements INodeType`
  con su objeto `description` y un método `execute()`. El estilo declarativo no
  sirve aquí porque la lógica no es un simple mapeo a una API HTTP.
- No lleva credenciales. No hay API key que gestionar.
- Compilar con `n8n-node build`.

### Dependencias

Ninguna fuera de las que trae el starter. La distancia de edición se implementa
a mano (son 15 líneas) y el DNS sale del módulo `dns` de Node. No agregues
`rapidfuzz`, `validator` ni similares.

## 11. Instalación en la instancia

No hace falta publicarlo en npm público. Tres opciones, de menos a más:

1. **Manual, desde el contenedor:** crear `~/.n8n/nodes`, correr `npm i` contra
   la ruta local o el tarball, y reiniciar n8n.
2. **Variable `N8N_CUSTOM_EXTENSIONS`** apuntando a la carpeta que contiene el
   nodo.
3. **npm público:** Settings → Community Nodes → Install, escribir el nombre
   del paquete, aceptar el aviso de código no verificado.

Para uso interno, la 1 o la 2. Recuerda que cada cambio implica recompilar,
reinstalar y **reiniciar n8n**.

## 12. Fuera de alcance

No implementar en este nodo:

- Sondeo SMTP, por lo del §2.2.
- Endpoint HTTP, webhook o servidor de cualquier tipo. Es un nodo, se usa
  desde el canvas.
- Base de datos o persistencia. La caché es en memoria y se pierde al
  reiniciar; está bien.
- Lista de supresión de rebotes. Eso va en el flujo de n8n con el webhook de
  Resend, no dentro del nodo.
- Doble opt-in. Va en el flujo, no en el nodo.

## 13. Criterio de aceptación

- [ ] `n8n-node build` compila sin errores
- [ ] El nodo se instala en una instancia autoalojada y aparece en el panel
- [ ] Los 13 casos del §9 pasan
- [ ] El test de concurrencia dispara una sola consulta DNS
- [ ] Con el DNS caído, ningún correo sale por la salida de descartados
- [ ] `juan@gmial.com` sugiere `juan@gmail.com` y sale por descartados
- [ ] `alguien@ymail.com` sale por enviables sin sugerencia
- [ ] El README explica en su primer párrafo que el nodo no confirma la
      existencia de buzones
