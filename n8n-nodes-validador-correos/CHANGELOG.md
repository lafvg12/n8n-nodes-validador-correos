# Changelog

## 0.1.0 — sin publicar

Primera versión del nodo.

### Funcionalidad

- Cascada de validación con dos salidas: **Enviables** y **Descartados**.
- Detección de typos de dominio con Damerau-Levenshtein, que cuenta la
  transposición como un solo error. Con Levenshtein a secas, `gmial` y
  `hotmial` dan distancia 2 y se colarían como válidos.
- Corte de alta confianza antes del DNS: los dominios typosquatting existen y
  responden (`hotmial.com` tiene MX real, `gmial.com` tiene registro A), así
  que esperar al DNS los deja pasar.
- Ancla de coincidencia exacta para no "corregir" dominios reales. Sin ella,
  `ymail.com` —de Yahoo, a distancia 1 de `gmail.com`— se alteraría.
- Estado `unknown` cuando el resolver falla: un DNS caído nunca descarta a un
  cliente legítimo.
- Detección de patrones de relleno (`xxxxxyyyy`, `qwerty`, `aaaa`) por
  heurísticas, no por lista. Va a `manual_review`, no a `reject`: es sospecha,
  no certeza.
- `domain_age_days` vía RDAP, opcional. Consulta el registro de IANA para ir al
  servidor autoritativo de cada TLD.
- El parámetro de entrada acepta tanto el nombre de un campo como una expresión.
- Soporte para arrays: un item de salida por dirección.
- Caché de DNS por dominio con coalescencia de peticiones en vuelo: 100
  contactos de Gmail disparan una sola consulta.

### Notas de implementación

- La cascada está compuesta por reglas independientes en `core/rules.ts`.
  Agregar un chequeo es añadir una entrada a `defaultRules`.
- El DNS está detrás de la interfaz `DnsResolver`, para poder probar la lógica
  sin salir a la red.
- 123 tests con el runner nativo de Node, sin dependencias adicionales.
- Sin compatibilidad con n8n Cloud: el nodo importa el módulo `dns` de Node,
  que Cloud no permite en community nodes. Es deliberado — el DNS nativo es más
  rápido y no le cuenta a un tercero qué dominios se están validando. Para
  revertirlo, ver el comentario en `eslint.config.mjs`.
