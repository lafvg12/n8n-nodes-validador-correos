# Servicio de validación de correos — Especificación para Claude Code

> **Instrucción de arranque:** lee este documento completo antes de escribir una sola línea.
> Construye la Fase 1 y solo la Fase 1. La Fase 2 está documentada para contexto,
> NO la implementes salvo que se te pida explícitamente.

---

## 1. Objetivo

Un microservicio HTTP en Python que valide direcciones de correo y devuelva un
veredicto estructurado. Se consume desde flujos de n8n antes de enviar cualquier
correo, para evitar rebotes que dañen la reputación del dominio remitente.

Sustituye el uso de ZeroBounce en el caso de uso de **registros propios**
(gente que se inscribe en un formulario y escribe mal su correo).

## 2. Restricciones técnicas — leer con atención

Estas no son preferencias, son hechos del entorno. Respetarlas evita construir
algo que no funciona:

1. **El puerto 25 saliente está cerrado.** No implementes sondeo SMTP
   (`RCPT TO`) en la Fase 1. No lo pongas "por si acaso". No lo dejes detrás de
   un flag. Simplemente no existe en este servicio.

2. **Hotmail, Outlook, Microsoft 365 y Gmail son catch-all o limitan por tasa.**
   Aceptan cualquier destinatario o cortan la conexión. Ningún sondeo daría
   información útil ahí, y ahí vive la mayoría de la base.

3. **Este servicio NO determina si un buzón existe.** Determina si una dirección
   es *imposible* o *sospechosa*. La confirmación real de existencia la da el
   doble opt-in (Fase 2). Todo el naming, la documentación y los mensajes de
   respuesta deben reflejar esto con honestidad. No uses el término "verified".

4. **Latencia objetivo: < 150 ms** en el caso cacheado, < 800 ms en frío.
   Se llama desde un formulario de registro en tiempo real.

## 3. Stack

| Componente | Elección | Notas |
|---|---|---|
| Lenguaje | Python 3.11+ | |
| Framework | FastAPI | por la validación con Pydantic y el OpenAPI automático |
| Servidor | Uvicorn con workers | |
| DNS | `dnspython` | resolución asíncrona (`dns.asyncresolver`) |
| Cache | `cachetools` (TTLCache en memoria) | Redis solo si se pide después |
| Config | `pydantic-settings` + `.env` | |
| Tests | `pytest` + `pytest-asyncio` | |
| Contenedor | Docker + docker-compose | |
| Linter | `ruff` | |

No agregues dependencias fuera de esta lista sin justificarlo en el README.

## 4. Estructura del proyecto

```
email-validator-service/
├── app/
│   ├── __init__.py
│   ├── main.py              # FastAPI app, rutas, middleware
│   ├── config.py            # settings desde .env
│   ├── models.py            # modelos Pydantic de request/response
│   ├── validator.py         # la cascada de validación (núcleo)
│   ├── dns_client.py        # resolución MX con cache y TTL
│   ├── providers.py         # tablas: proveedores SMTP, catch-all, free email
│   ├── lists.py             # carga y refresco de desechables / roles
│   └── auth.py              # verificación de API key
├── data/
│   ├── disposable_domains.txt
│   ├── free_providers.txt
│   ├── role_prefixes.txt
│   └── common_domains.txt   # para corrección de typos
├── tests/
│   ├── test_syntax.py
│   ├── test_typo.py
│   ├── test_cascade.py
│   └── test_api.py
├── scripts/
│   └── update_disposable_list.py
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── requirements.txt
└── README.md
```

## 5. Endpoints

### `POST /v1/validate`

Valida una dirección. Este es el endpoint principal.

**Request:**
```json
{ "email": "juan@gmial.com" }
```

**Response 200:**
```json
{
  "email": "juan@gmial.com",
  "status": "invalid",
  "sub_status": "possible_typo",
  "recommendation": "reject",
  "confidence": "high",
  "suggestion": "juan@gmail.com",
  "account": "juan",
  "domain": "gmial.com",
  "free_email": false,
  "role_based": false,
  "disposable": false,
  "mx_found": false,
  "mx_record": null,
  "smtp_provider": null,
  "catch_all": null,
  "checked_at": "2026-08-20T14:32:11Z",
  "cached": false,
  "duration_ms": 84
}
```

### `POST /v1/validate/batch`

Hasta 1000 direcciones por request. Resolución concurrente con
`asyncio.gather` y un semáforo (máximo 50 consultas DNS simultáneas).

```json
{ "emails": ["a@x.com", "b@y.com"] }
```

Responde con `{ "results": [...], "summary": { "valid": 8, "invalid": 2, ... } }`.

### `GET /health`

Sin autenticación. Devuelve `{"status":"ok","version":"...","uptime_s":123}`.
Para el healthcheck de Docker y el monitoreo.

### `GET /v1/stats`

Contadores en memoria desde el arranque: total de validaciones, desglose por
status, tasa de aciertos del cache. Útil para saber si vale la pena el servicio.

## 6. Autenticación

Header `X-API-Key`. La clave se lee de la variable de entorno `API_KEYS`
(separadas por coma, para poder rotar sin downtime). Si falta o es incorrecta,
`401`. `/health` queda exento.

## 7. La cascada de validación — orden exacto

Implementa esto en `validator.py`. **El orden importa**: cada paso que corta
ahorra los siguientes.

```
1. Normalizar
   - trim, lowercase
   - quitar puntos iniciales/finales del local part
   - si cambió algo, registrarlo en sub_status = "leading_period_removed"

2. Sintaxis (RFC 5322 pragmático)
   - un solo @, local ≤ 64 chars, total ≤ 254, sin ".."
   - FALLA → invalid / failed_syntax_check / reject
   - NO uses una regex "completa de RFC 5322", son ilegibles e inútiles.
     Una regex pragmática + chequeos de longitud explícitos.

3. Local part basura
   - lista en data/ (asdf, test, prueba, aaa, qwerty, noexiste...)
   - FALLA → invalid / mailbox_not_found / reject

4. Corrección de typo (Levenshtein contra common_domains.txt)
   - umbral: distancia ≤ 1 si el dominio tiene ≤ 6 chars, ≤ 2 si es más largo
   - guarda la sugerencia, NO cortes todavía

5. Dominio desechable
   - FALLA → do_not_mail / disposable / reject

6. Resolución MX (con cache)
   - sin MX → intenta registro A como fallback (RFC 5321 lo permite)
   - Null MX (registro MX con host ".") → invalid / does_not_accept_mail
   - sin nada → si hay sugerencia del paso 4: invalid / possible_typo
                si no:                        invalid / no_dns_entries
   - ambos → reject

7. Detectar proveedor SMTP desde el MX (tabla en providers.py)
   *.protection.outlook.com  → microsoft
   *.google.com / aspmx.l.*  → google
   *.yahoodns.net            → yahoo
   ... (extiende la tabla)

8. Catch-all conocido
   - microsoft → true
   - google, yahoo, apple → false
   - resto → null (desconocido, y así se reporta)

9. Cuenta de rol (info@, ventas@, admin@...)
   - → do_not_mail / role_based / manual_review

10. Veredicto final
    - catch_all == true  → status "catch-all", recommendation "confirm"
    - todo limpio        → status "valid",     recommendation "accept"
    - con sugerencia     → status "valid",     recommendation "confirm",
                           y devuelve la sugerencia igual
```

### Campo `recommendation` — esto es lo que consume n8n

Los `status` son informativos. Este campo es el que se usa para ramificar:

| Valor | Significado | Qué hace n8n |
|---|---|---|
| `accept` | dominio real, nada sospechoso | envía la confirmación |
| `confirm` | puede existir, no se puede saber más | envía la confirmación (igual) |
| `manual_review` | cuenta de rol, decisión de negocio | notifica, no envía campañas |
| `reject` | imposible o desechable | bloquea el registro, muestra el error |

Nota de diseño: `accept` y `confirm` llevan a la misma acción. Es intencional.
La distinción existe para reportería, no para lógica de envío.

## 8. Cache

- **MX por dominio**: TTLCache, 10.000 entradas, TTL 6 horas. Es el que rinde:
  todos tus usuarios de Gmail comparten una sola consulta.
- **Resultado completo por email**: TTLCache, 50.000 entradas, TTL 24 horas.
- Ambos tamaños y TTLs configurables por `.env`.
- El campo `cached` en la respuesta indica de dónde salió.

## 9. Listas de datos

`data/disposable_domains.txt` arranca con la lista de
`disposable-email-domains` (GitHub, dominio público, ~4.000 entradas).

`scripts/update_disposable_list.py` la descarga y la reemplaza. Debe:
- descargar a un archivo temporal primero
- validar que tenga más de 1.000 líneas antes de reemplazar (evita dejar la
  lista vacía si el repo se cae)
- ser ejecutable por cron semanal

`data/common_domains.txt` debe incluir, además de los globales, los
colombianos: `une.net.co`, `etb.net.co`, `telmex.net.co`, `hotmail.com.mx`,
`live.com.mx`, `yahoo.com.mx`, `outlook.es`, `hotmail.es`.

Todas las listas se cargan a memoria al arrancar. Endpoint `POST /v1/admin/reload`
para recargarlas sin reiniciar (protegido con la API key).

## 10. Rate limiting

Por API key: 100 req/min en `/v1/validate`, 10 req/min en `/v1/validate/batch`.
Implementa con `slowapi` o un token bucket en memoria. Al exceder, `429` con
header `Retry-After`.

## 11. Logging

JSON estructurado a stdout (Docker lo recoge). Por cada validación registra:
timestamp, dominio, status, sub_status, duration_ms, cached.

**No registres la dirección completa.** Solo el dominio. Son datos personales
bajo la Ley 1581 de Colombia y no hay razón operativa para guardarlos en logs.

## 12. Despliegue

`Dockerfile` multi-stage, imagen final `python:3.11-slim`, usuario no root,
`HEALTHCHECK` apuntando a `/health`.

`docker-compose.yml` con el servicio, restart `unless-stopped`, límites de
memoria, y las variables desde `.env`.

En el README incluye la sección de reverse proxy con Caddy (más simple que
nginx para TLS automático):

```
validador.tudominio.com {
    reverse_proxy localhost:8000
}
```

Y el bloque de firewall: el puerto 8000 solo escucha en `127.0.0.1`, nunca
expuesto directamente.

## 13. Tests

Mínimo obligatorio. Usa `unittest.mock` para el DNS — los tests no deben
depender de la red.

```python
# casos que deben pasar
"juan.perez@gmail.com"       → valid / accept
"juan@gmial.com"             → invalid / possible_typo / suggestion=juan@gmail.com
"maria@hotmial.com"          → invalid / possible_typo
"lafvg12@hotmail.com"        → catch-all / confirm
"asdf@asdf.com"              → invalid / reject
"info@empresa.com.co"        → do_not_mail / role_based / manual_review
"test@mailinator.com"        → do_not_mail / disposable / reject
"sin-arroba"                 → invalid / failed_syntax_check
"a@@b.com"                   → invalid / failed_syntax_check
".juan@gmail.com"            → valid, leading_period_removed
"a" * 65 + "@gmail.com"      → invalid / failed_syntax_check
```

Test de concurrencia: 100 validaciones simultáneas del mismo dominio deben
disparar **una sola** consulta DNS.

## 14. README

Debe incluir, en este orden:

1. Qué hace y **qué NO hace** (la sección de restricciones del punto 2, en
   lenguaje de usuario)
2. Instalación local
3. Despliegue con Docker
4. Referencia de endpoints con `curl` de ejemplo
5. La tabla de `recommendation`
6. Integración con n8n (copia el punto 15 de este documento)
7. Cómo actualizar las listas

---

## 15. Integración con n8n

### Nodo HTTP Request

```
Method:  POST
URL:     https://validador.tudominio.com/v1/validate
Auth:    Header Auth → Name: X-API-Key, Value: {{$credentials.apiKey}}
Body:    JSON
         { "email": "{{ $json.email }}" }
Timeout: 5000 ms
Options: "Never Error" activado
```

Activa **Never Error**. Si el validador se cae, el flujo no debe romperse —
debe seguir de largo y enviar la confirmación igual. Un validador caído no
puede bloquear registros legítimos.

### Nodo Switch — ramificar por `recommendation`

```
Modo: Rules
Valor a evaluar: {{ $json.recommendation }}

Ruta 0 — equals "reject"          → responder al formulario con el error
                                     (si hay suggestion, mostrarla:
                                      "¿Quisiste decir juan@gmail.com?")
Ruta 1 — equals "manual_review"   → guardar + notificar a Slack, no enviar
Ruta 2 — fallback (accept/confirm) → enviar correo de confirmación
```

### El flujo completo

```
[Webhook: registro]
        ↓
[HTTP Request: validador]
        ↓
[Switch: recommendation]
        │
        ├── reject         → [Respond to Webhook: 400 + suggestion]
        ├── manual_review  → [Slack] → [Postgres: guardar como pendiente]
        └── accept/confirm → [Postgres: guardar como no_confirmado]
                                    ↓
                            [Generar token UUID]
                                    ↓
                            [Send Email: confirmación con link]
                                    ↓
                            [Respond to Webhook: 200]
```

**Importante:** la campaña de marketing solo sale a los contactos con
`confirmado = true`. El validador reduce la basura de entrada; la confirmación
es la que protege la reputación del dominio.

---

## FASE 2 — NO IMPLEMENTAR AHORA

Documentado solo para que las decisiones de la Fase 1 no la bloqueen.

- **Endpoint de confirmación**: `GET /v1/confirm/{token}` que marca el contacto
  como confirmado. Requiere base de datos.
- **Webhook de rebotes**: recibe los eventos del proveedor de envío (Brevo /
  SendGrid / SES) y marca direcciones como muertas automáticamente.
- **Lista de supresión propia**: acumula las direcciones que rebotaron. Con el
  tiempo, esta lista es lo que ZeroBounce cobra y no se puede replicar de otra
  forma que no sea acumulándola uno mismo.
- **Sondeo SMTP**: solo si algún día se consigue un servidor con puerto 25
  abierto y una IP dedicada limpia. Aun entonces, inútil contra Microsoft y
  Google. Prioridad baja.

---

## Criterio de aceptación

La Fase 1 está lista cuando:

- [ ] `docker compose up` levanta el servicio y `/health` responde
- [ ] Los 11 casos del punto 13 pasan
- [ ] `POST /v1/validate` con `juan@gmial.com` sugiere `juan@gmail.com`
- [ ] 1000 direcciones en batch se procesan en menos de 30 segundos
- [ ] Una segunda llamada al mismo dominio devuelve `cached: true`
- [ ] Sin `X-API-Key` responde 401
- [ ] Los logs no contienen ninguna dirección de correo completa
- [ ] El README explica en su primer párrafo que el servicio no confirma la
      existencia de buzones