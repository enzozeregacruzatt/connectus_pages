# connectus_pages

Mini app de consulta de SMS de solo lectura, pensada para embeberse en un iframe en el sitio de un cliente. Tiene login
propio, selector de cuenta, búsqueda por número y fechas, y una tabla paginada. Corre en API Gateway y Lambda (Node 22), con
el front y la API en el mismo origen, y lee de Aurora MySQL con un usuario que solo ve vistas acotadas a las cuentas permitidas.

Es una app aparte de la plataforma: no comparte código, sesión ni credenciales con ella.

El contrato completo (arquitectura, base de datos, API, cabeceras de seguridad y despliegue) está en
[docs/DISENO.md](docs/DISENO.md).

**Este repo es público.** Aquí no van secretos, ids de cuenta reales, nombres de clientes, dominios de clientes ni el endpoint
de la base. Todo eso vive en Parameter Store o en la base.

## Requisitos

- Node 22 o superior.
- Para las pruebas de integración y el servidor local: `mysqld`, `mysql` y `python3` en el `PATH`.

```sh
npm install
```

## Pruebas

```sh
npm test                   # unitarias: sin red ni base
npm run test:integration   # levanta un mysqld desechable, corre las pruebas y lo apaga
```

`scripts/mysql_prueba.sh up` levanta el `mysqld` desechable en `127.0.0.1:33077`, con datos inventados, y deja las variables en
`test/.env.local`, que git ignora. No toca el MySQL del puerto 3306 ni ninguna base remota. Con la base arriba, se pueden correr
las pruebas directamente:

```sh
scripts/mysql_prueba.sh up
node --test 'test/integration/**/*.test.js'
scripts/mysql_prueba.sh down
```

## Servidor local

No necesita AWS: invoca el handler real con `STAGE=local`.

```sh
scripts/mysql_prueba.sh up
node scripts/dev.js
```

| Dirección | Qué muestra |
| --- | --- |
| `http://localhost:8787` | La app. |
| `http://127.0.0.1:8788` | Una página de otro origen, autorizada en `FRAME_ANCESTORS`, con un iframe a la app. |
| `http://127.0.0.1:8789` | Otra página de otro origen, no autorizada: el navegador debe bloquear el iframe. |

Los usuarios de prueba son `demo`, `solo102` e `inactivo`; sus claves se generan al azar y quedan en `test/.env.local`.

## Despliegue

`serverless.yml` despliega la app, con dos reglas WAF por IP, una sobre el login y otra sobre todas las rutas, y el throttling de la
etapa. El nombre de dominio y el certificado llegan por las variables de entorno `PAGES_DOMAIN_NAME` y `PAGES_CERTIFICATE_ARN`, y
la configuración de la app se lee de Parameter Store bajo `/connectus-pages/prod/`. El detalle está en
[docs/DISENO.md](docs/DISENO.md#despliegue).

Un despliegue limpio va en este orden:

1. `npm ci`.
2. Certificado de ACM emitido en `us-west-2` y las variables `PAGES_DOMAIN_NAME` y `PAGES_CERTIFICATE_ARN` exportadas.
3. Subir a Parameter Store `db_host`, `db_user`, `token_secret` y `frame_ancestors`.
4. Aprovisionar la base con `scripts/aprovisionar_bd.sh` y subir `db_password`.
5. Ampliar `allowed_account`, revisando antes de quién es cada cuenta, como dice
   [docs/DISENO.md](docs/DISENO.md#logins-y-cuentas). En una base limpia está vacía.
6. Crear los logins con `scripts/crear_login.js`.
7. `serverless create_domain`, solo la primera vez.
8. `serverless deploy`.

`scripts/crear_login.js` no amplía `allowed_account`: si la cuenta no está permitida, falla. Con una clave escrita a mano, el SQL va
primero a un archivo, porque sin `--generar` el script no acepta un pipe: con `mysql -p` al otro lado, la clave quedaría a la vista
en la pantalla.

```sh
(umask 077; node scripts/crear_login.js --usuario <u> --cuentas 1,2 > login.sql)
mysql ... < login.sql
rm login.sql
```

Con `--generar` se puede canalizar: `node scripts/crear_login.js --usuario <u> --cuentas 1,2 --generar | mysql ...`.

Todo cambio en Parameter Store exige reciclar los contenedores, porque la configuración se lee una vez por contenedor:

```sh
aws lambda update-function-configuration --function-name connectus-pages-prod-app --description "config $(date -u +%FT%TZ)"
```

`serverless deploy` ya no se omite con este template, aunque el código no cambie, porque el `DependsOn` de la asociación del WAF
cambia en cada corrida. Aun así no se usa para reciclar contenedores, porque ese efecto no está verificado.

`serverless package` no es de solo lectura: con credenciales reales consulta AWS y crea el bucket de despliegue por defecto si no existe.
