# Pasos para arrancar el nodo custom — guía de ejecución

> **Estado: nada iniciado todavía.** Este documento es el plan. La
> especificación de qué hace el nodo está en `NODO-N8N.md`.

---

## 0. Lo que ya está verificado

En esta máquina (revisado hoy):

| Herramienta | Versión | Requisito | Estado |
|---|---|---|---|
| Node.js | v22.21.1 | v22 o superior | cumple |
| npm | 10.9.4 | — | cumple |
| pnpm | 10.22.0 | — | disponible |
| git | 2.50.1 | — | cumple |

No hay que instalar nada previo.

### Sobre pnpm

Tu recordatorio era correcto **para 2024**: en julio de ese año el repositorio
`n8n-nodes-starter` cambió a pnpm para igualar el gestor que usa n8n
internamente, y eso rompió los tutoriales de la época.

Hoy ya no aplica. El README actual del starter pide **Node v22 o superior y
npm**, y todos sus scripts son `npm run`. Más importante: el propio starter
recomienda no clonarlo, sino usar el generador nuevo. Así que vamos con npm.

### Sobre el ciclo de desarrollo

Antes te dije que iterar sobre un custom node era doloroso porque había que
recompilar y reiniciar n8n en cada cambio. **Eso ya no es así** y te lo debo
corregir: el CLI trae un modo `dev` que levanta una instancia local de n8n con
tu nodo cargado, vigila la carpeta del proyecto y recompila solo. El argumento
del reinicio sigue valiendo para la instancia de producción, pero no para
construir.

---

## 1. Guardar lo que ya existe

El repositorio no tiene ni un commit todavía. Antes de generar nada conviene
dejar constancia de lo que hay, para que después se vea claro qué archivos
agregó el generador y cuáles son nuestros.

```bash
cd ~/workspace/emails-validator
git add -A
git commit -m "Especificación del validador y script de validación por lotes"
```

Queda versionado: `task.md`, `NODO-N8N.md`, `PASOS-NODO.md`, `validate.py` y
la carpeta `n8n/` con los Code nodes.

---

## 2. Generar el esqueleto del nodo

El generador crea su propia carpeta, así que todo lo que ya tenemos se
conserva intacto al lado.

```bash
cd ~/workspace/emails-validator
npm create @n8n/node@latest n8n-nodes-validador-correos -- --template programmatic/example
```

Notas sobre ese comando:

- El nombre **tiene que empezar por `n8n-nodes-`**. n8n valida ese prefijo al
  instalar, no es una convención.
- El `--` antes de `--template` es obligatorio con `npm create`. Sin él, npm se
  come la opción.
- Va a preguntar datos que falten (autor, descripción, licencia) de forma
  interactiva, y al final instala las dependencias solo. Con `--skip-install`
  se puede posponer.

### Por qué la plantilla `programmatic/example`

Hay tres disponibles:

| Plantilla | Para qué sirve |
|---|---|
| `declarative/github-issues` | demo con operaciones y credenciales |
| `declarative/custom` | plantilla en blanco, estilo declarativo |
| `programmatic/example` | estilo programático, lógica libre |

El estilo declarativo sirve cuando el nodo es un mapeo directo a una API HTTP:
declaras rutas y parámetros y n8n arma la petición. **Nuestro nodo no es eso.**
Tiene una cascada de decisiones, consultas DNS, caché y dos salidas distintas.
Eso necesita un método `execute()` propio, que es lo que da la plantilla
programática.

El CLI instala `n8n` como dependencia de desarrollo, así que no hace falta
tener n8n global para probar.

---

## 3. Estructura que va a quedar

```
emails-validator/
├── task.md                        # spec original (microservicio, no se usa)
├── NODO-N8N.md                    # spec del nodo  ← la que manda
├── PASOS-NODO.md                  # este archivo
├── validate.py                    # validador por lotes, standalone
├── n8n/                           # Code nodes, alternativa sin instalar nada
└── n8n-nodes-validador-correos/   # ← lo nuevo
    ├── package.json               # con el objeto "n8n" y el keyword
    ├── nodes/
    │   └── ValidadorCorreos/
    │       ├── ValidadorCorreos.node.ts
    │       └── validador.ts       # la cascada, aparte del nodo
    ├── dist/                      # compilado, es lo que se publica
    └── .github/workflows/publish.yml
```

Mantener la cascada en `validador.ts`, separada del archivo del nodo, importa:
así se puede probar con tests sin levantar n8n, y el archivo `.node.ts` queda
solo con la definición de la interfaz y el `execute()`.

---

## 4. Ciclo de desarrollo

```bash
cd n8n-nodes-validador-correos
npm run dev
```

Levanta n8n en `localhost:5678` con el nodo ya cargado en el panel. Cada vez
que guardes un archivo, recompila. Ahí se prueba de verdad: se arma un flujo
pequeño, se le meten correos y se mira la salida.

Otros comandos del CLI:

| Comando | Qué hace |
|---|---|
| `npm run dev` | n8n local + recompilación automática |
| `npm run build` | compila a `dist/`, que es lo que se publica |
| `npm run lint` | revisa que cumpla los requisitos de community node |
| `npm run release` | sube versión, hace tag y dispara la publicación |

Correr `lint` antes de dar por terminado: verifica cosas que n8n exige en la
estructura del paquete y que no son obvias.

---

## 5. Orden de implementación sugerido

Una vez generado el esqueleto, construir en este orden:

1. **`validador.ts`** — la cascada pura, sin nada de n8n adentro. Es
   traducción directa de `validate.py`, que ya está probado.
2. **Los tests de la cascada** — los 13 casos del §9 de `NODO-N8N.md`, con el
   DNS simulado. Antes de tocar el nodo.
3. **La resolución DNS** con caché y coalescencia de peticiones en vuelo.
   Ojo con esta última: es la que hace pasar el test de concurrencia y es fácil
   de olvidar.
4. **`ValidadorCorreos.node.ts`** — la descripción del nodo, sus parámetros de
   UI y el `execute()` que recorre los items y los reparte en las dos salidas.
5. **Probar en `npm run dev`** con correos reales.
6. **Instalar en la instancia** de producción (ver §11 de `NODO-N8N.md`).

Los pasos 1 y 2 no dependen de n8n para nada, así que ahí es donde conviene
empezar: se avanza rápido y con certeza.

---

## 6. Decisión pendiente antes de empezar

Falta definir una sola cosa: **cómo se instala en tu instancia de producción**.

- Si n8n te corre en Docker en un servidor, la vía es entrar al contenedor,
  poner el paquete en `~/.n8n/nodes` y reiniciar.
- Si prefieres no entrar al contenedor, se monta un volumen y se usa la
  variable `N8N_CUSTOM_EXTENSIONS`.
- Publicarlo en npm público solo si te da igual que sea visible.

No hace falta resolverlo ahora — no afecta cómo se escribe el nodo, solo el
último paso. Pero conviene saberlo antes de llegar ahí.
