# connectus_pages

Mini app de consulta de SMS de solo lectura: búsqueda por número y fechas, historial de envíos, detalle de un envío con sus conteos, y exportación a CSV y XLSX.
Se abre desde un enlace firmado y además pide usuario y clave. Está pensada para mostrarse dentro de un programa de terceros, como un BI de escritorio. Corre en API Gateway
y Lambda (Node 22), con el front y la API en el mismo origen, y lee de Aurora MySQL con usuarios que solo ven vistas acotadas a las cuentas permitidas. Un trabajador
aparte genera los archivos y los guarda en S3.

Es una app aparte de la plataforma: no comparte código, sesión ni credenciales con ella.

El contrato completo (arquitectura, enlace, base de datos, API, trabajador, cabeceras, retención y despliegue) está en [docs/DISENO.md](docs/DISENO.md).

**Este repo es público.** Aquí no van secretos, enlaces reales, ids de cuenta reales, nombres ni dominios de clientes, ni el endpoint de la base. Todo eso vive en Parameter Store, en la
base o en un runbook privado.

## Requisitos

- Node 22 o superior.
- Para las pruebas de integración y el servidor local: `mysqld`, `mysql` y `python3` en el `PATH`.
- Opcionales, para que no se salten las pruebas de archivos: `openpyxl` en `python3`, `unzip` y `soffice`.

```sh
npm install
```

## Pruebas

```sh
npm test                   # unitarias: sin red ni base
npm run test:integration   # levanta un mysqld desechable, corre las pruebas en serie y lo apaga
```

Tienen que pasar en `mysqld` 5.7.44 y en 9.3.0. Para la segunda, en Homebrew:

```sh
PATH=/opt/homebrew/opt/mysql/bin:$PATH npm run test:integration
```

`scripts/mysql_prueba.sh up` levanta el `mysqld` desechable en `127.0.0.1:33077`, con datos inventados, y deja las variables en `test/.env.local`, que git ignora. No toca el MySQL del puerto 3306 ni ninguna
base remota. Con la base arriba, se pueden correr las pruebas directamente. Van en serie, porque comparten esa base:

```sh
scripts/mysql_prueba.sh up
node --test --test-concurrency=1 'test/integration/**/*.test.js'
scripts/mysql_prueba.sh down
```

## Servidor local

No necesita AWS: invoca el handler real con `STAGE=local`, y corre el trabajador en el mismo proceso, con los archivos en un directorio temporal que se borra al salir.

```sh
scripts/mysql_prueba.sh up
node scripts/dev.js
```

| Dirección | Qué muestra |
| --- | --- |
| `http://localhost:8787` | La app sin enlace: muestra el aviso y no el formulario. |
| `http://127.0.0.1:8788` | Una página de otro origen, autorizada en `FRAME_ANCESTORS`, con iframes a la app con el enlace. |
| `http://127.0.0.1:8789` | Otra página de otro origen, no autorizada: el navegador debe bloquear los iframes. |
| `http://127.0.0.1:8791` | Otro origen, con iframes a una segunda app (`localhost:8790`) con `frame_ancestors` en `sin-restriccion` y CORS para documento opaco: uno común y otro en sandbox. |

Los usuarios de prueba son `demo`, `solo102` e `inactivo`. Sus claves se generan al azar y quedan en `test/.env.local`, igual que el enlace de `demo`, en `LINK_DEMO`.

## El enlace

```
https://<host>/#e=l1.<ranura a|b>.<id_login>.<link_version>.<exp>.<firma>
```

Es obligatorio para entrar, y no reemplaza la clave: sin clave, el enlace no da acceso a nada. Deja a internet anónimo fuera del login y se puede revocar por login, pero no identifica a nadie y quien tenga el archivo lo
tiene. El detalle de qué protege y qué no está en [docs/DISENO.md](docs/DISENO.md#qué-protege-y-qué-no). El enlace y la clave se entregan por canales distintos.

Revocar, como master: `UPDATE connectus_pages.login SET link_version = link_version + 1 WHERE username = ?;`.

## Sonda

`sonda/` es un servicio aparte, sin dependencias ni datos, en otro origen. Muestra en pantalla cómo trata a una página ajena el producto que la embebe, para que el cliente mande una captura. Va antes de fijar `frame_ancestors` y `cors_opaque`. Se despliega por su cuenta, y no entra en el paquete de la app:

```sh
cd sonda && serverless deploy
```

## Despliegue

`serverless.yml` despliega la app y el trabajador, con el bucket de exportaciones, dos reglas WAF por IP, el throttling de la etapa y las alarmas. El detalle, con todos los comandos, está en [docs/DISENO.md](docs/DISENO.md#despliegue).

Un despliegue limpio va en este orden:

1. `npm ci`.
2. La sonda, si no se conoce el producto que va a embeber.
3. Certificado de ACM emitido en `us-west-2`, un tema SNS para las alarmas, y las variables `PAGES_DOMAIN_NAME`, `PAGES_CERTIFICATE_ARN` y `PAGES_ALARM_TOPIC_ARN` exportadas.
4. Subir los parámetros a Parameter Store, bajo `/connectus-pages/prod/`, menos `db_password` y `worker_db_password`, que los genera el paso siguiente:

   | Función | Parámetros |
   | --- | --- |
   | App, obligatorios | `db_host`, `db_user`, `db_password`, `token_secret`, y al menos uno de `link_secret_a` y `link_secret_b` |
   | App, opcionales | `frame_ancestors` (lista de orígenes, o `sin-restriccion`), `cors_opaque` (`on`) |
   | Trabajador, obligatorios | `db_host`, `worker_db_user`, `worker_db_password`, `worker_quiet_windows` |

5. Aprovisionar la base con `scripts/aprovisionar_bd.sh`, con `OUT_ENV` para guardar las claves, y subir `db_password` y `worker_db_password`.
6. Ampliar `allowed_account`, revisando antes de quién es cada cuenta, como dice [docs/DISENO.md](docs/DISENO.md#logins-y-cuentas). En una base limpia está vacía.
7. Crear los logins con `scripts/crear_login.js`.
8. Emitir cada enlace con `scripts/crear_enlace.js`.
9. `serverless create_domain`, solo la primera vez.
10. `serverless deploy`.

`scripts/crear_login.js` no amplía `allowed_account`: si la cuenta no está permitida, falla. Con una clave escrita a mano, el SQL va primero a un archivo, porque sin `--generar` el script no acepta un pipe: con `mysql -p` al otro lado, la clave quedaría a la vista en la pantalla.

```sh
(umask 077; node scripts/crear_login.js --usuario <u> --cuentas 1,2 > login.sql)
mysql ... < login.sql
rm login.sql
```

Con `--generar` se puede canalizar: `node scripts/crear_login.js --usuario <u> --cuentas 1,2 --generar | mysql ...`.

Todo cambio en un parámetro de la app exige reciclar sus contenedores, porque la configuración se lee una vez por contenedor. El trabajador la relee en cada corrida.

```sh
aws lambda update-function-configuration --function-name connectus-pages-prod-app --description "config $(date -u +%FT%TZ)"
```

`serverless deploy` ya no se omite con este template, aunque el código no cambie, porque el `DependsOn` de la asociación del WAF cambia en cada corrida. Aun así no se usa para reciclar contenedores, porque ese efecto no está verificado.

Para apagar el trabajador en una emergencia, sin desplegar. Con `1`, vuelve:

```sh
aws lambda put-function-concurrency --function-name connectus-pages-prod-worker --reserved-concurrent-executions 0
```

## Reglas de operación

- Data tracing de API Gateway está prohibido: registraría el enlace y la clave.
- Si se activa el registro del WAF, hay que redactar `args`.
- El número viaja en la query de `GET /api/sms` y `GET /api/delivery/messages`: la app no lo registra, pero queda en cualquier registro de acceso que se active.
- `serverless package` no es de solo lectura: con credenciales reales consulta AWS y crea el bucket de despliegue por defecto si no existe.
