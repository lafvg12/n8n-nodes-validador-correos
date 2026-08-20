// Sin comprobaciones de compatibilidad con n8n Cloud.
//
// Este nodo usa el módulo `dns` de Node para resolver los MX. n8n Cloud no
// permite que un community node importe módulos, pero esta instancia es
// autoalojada y el DNS nativo es preferible a consultar un resolver externo:
// es más rápido y no le cuenta a un tercero qué dominios estamos validando.
//
// Para volver atrás: cambiar a `config` y resolver el DNS con
// this.helpers.httpRequest contra un resolver DNS-over-HTTPS.
import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

export default configWithoutCloudSupport;
