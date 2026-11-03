# connectus_pages: diseño y contrato

Mini app que muestra, dentro de un iframe en el sitio de un cliente, una consulta de SMS de solo lectura equivalente a la que
ya existe en la plataforma. Es una app aparte: no comparte con ella código, sesión ni credenciales.

**El repo es público.** Aquí no van secretos, ids de cuenta, nombres de clientes, dominios de clientes ni el endpoint de
la base. Todo eso vive en Parameter Store o en la base.

## Alcance de esta versión

Entra: login, selector de cuenta (si el login tiene más de una), búsqueda por número y fechas, tabla paginada.

No entra: exportación CSV, detalle de envío con gráficos, recuperación de clave y cambio de clave por el usuario.

## Arquitectura

```
iframe del cliente → API Gateway REST + Lambda (Node 22) → Aurora MySQL 8.0
                     front y API en el mismo origen         usuario pages_app
```

Tres barreras, de afuera hacia adentro:

1. `frame-ancestors`: solo los dominios configurados pueden embeber la página. Sin configuración, nadie (`'none'`).
2. Login de la app: cada login solo puede pedir las cuentas de `login_account`.
3. Base: `pages_app` solo ve `connectus_pages`, y las vistas de ese esquema solo devuelven filas de `allowed_account`.
   Aunque el backend tenga un bug, no puede leer otras cuentas ni escribir en `dbconnectus`.

La sesión no usa cookies, porque los navegadores bloquean las de terceros dentro de un iframe. El token se guarda en una
variable de JS y viaja en `Authorization: Bearer`. Recargar la página obliga a volver a entrar. Sin cookies no hay CSRF.

## Base de datos

Corre en Aurora MySQL 8.0, y el SQL asume el binlog apagado y `activate_all_roles_on_login` en 0. Las pruebas locales
corren en MySQL 5.7, así que el SQL tiene que funcionar en las dos versiones; lo exclusivo de 8.0 va con comentario
condicional (`/*!80021 ... */`). Tablas de origen: `dbconnectus.sms_outgoing`, que es muy grande,
`dbconnectus.delivery` y `dbconnectus.account`.

### Cuentas de base de datos

- `pages_owner`@`%`, `REQUIRE SSL`: dueña y DEFINER de las vistas y la función. Tiene permisos directos, no por rol, porque
  con `activate_all_roles_on_login=0` un DEFINER que dependa de un rol pierde el acceso. Solo tiene:
  `SELECT (id, id_account, id_delivery, dst_number, sms_content, status, created_at)` en `dbconnectus.sms_outgoing`,
  `SELECT (id, id_account, name)` en `dbconnectus.delivery`, `SELECT (id, name)` en `dbconnectus.account` y
  `ALL ... WITH GRANT OPTION` en `connectus_pages.*`. Queda con `ACCOUNT LOCK` al terminar el aprovisionamiento; un DEFINER
  bloqueado sigue funcionando. Así no hace falta `SET_USER_ID` para fijar otro DEFINER.
- `pages_app`@`%`, `REQUIRE SSL`, `MAX_USER_CONNECTIONS 8`, `MAX_CONNECTIONS_PER_HOUR 2000`, `MAX_QUERIES_PER_HOUR 0`: la usa
  la Lambda. Es `@'%'` porque no tiene IP fija. No tiene tope de consultas por hora a
  propósito: lo comparte toda la app y un login anónimo gasta 2 sentencias por intento, así que cualquiera lo agotaría y dejaría
  la app en 503 hasta que se renueve el contador. La carga ya la acotan `reservedConcurrency`, las conexiones y
  `MAX_EXECUTION_TIME`, y el login anónimo lo frenan el WAF y el throttling de la etapa (ver Despliegue).
  Permisos exactos, y ninguno más:
  - `SELECT` en `login`, `login_account` y en las vistas `sms`, `delivery`, `account`;
  - `UPDATE (failed_attempts, locked_until, last_login_at)` en `login`;
  - `INSERT` en `audit_log`;
  - `EXECUTE` en la función `sms_cutoff_id`.

  No tiene `SELECT` en `allowed_account` ni en `audit_log`, ni ningún permiso sobre `dbconnectus`.

### Esquema `connectus_pages` (utf8mb4)

| Objeto | Definición |
| --- | --- |
| `login` | `id` INT AI PK; `username` VARCHAR(64) UNIQUE NOT NULL; `password_hash` VARCHAR(255) NOT NULL; `active` TINYINT(1) NOT NULL DEFAULT 1; `token_version` INT NOT NULL DEFAULT 0; `failed_attempts` INT NOT NULL DEFAULT 0; `locked_until` DATETIME NULL; `last_login_at` DATETIME NULL; `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP |
| trigger `login_password_changed` | `BEFORE UPDATE ON login`: si cambia `password_hash`, `token_version = OLD.token_version + 1`. DEFINER `pages_owner`. |
| `allowed_account` | `id_account` INT PK. Lista dura de cuentas que las vistas pueden devolver. Se amplía solo con el paso explícito de "Logins y cuentas". |
| `login_account` | `id_login` FK a `login`, `id_account` FK a `allowed_account`, PK compuesta |
| `audit_log` | `id` BIGINT AI PK; `id_login` INT NULL; `action` VARCHAR(32) NOT NULL; `id_account` INT NULL; `detail` VARCHAR(255) NULL; `ip` VARCHAR(45) NULL; `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP; índice en `created_at` |
| vista `sms` | `ALGORITHM=MERGE SQL SECURITY DEFINER`: `s.id, s.id_account, s.id_delivery, s.dst_number, s.sms_content, s.status, s.created_at` de `dbconnectus.sms_outgoing s JOIN connectus_pages.allowed_account a ON a.id_account = s.id_account` |
| vista `delivery` | ídem: `d.id, d.id_account, d.name` |
| vista `account` | ídem: `c.id, c.name` (`c.id` contra `allowed_account`) |
| función `sms_cutoff_id(p_before DATETIME) RETURNS BIGINT` | `READS SQL DATA SQL SECURITY DEFINER`: `COALESCE((SELECT id FROM dbconnectus.sms_outgoing WHERE created_at < p_before ORDER BY created_at DESC, id DESC LIMIT 1), 0)` |

`created_at` de `sms_outgoing` es DATETIME en hora de Chile, sin zona. No hay que convertirla:
se compara y se muestra tal cual. `login.*`, `audit_log.*` usan UTC del servidor (`UTC_TIMESTAMP()`).

### Consulta de SMS

`sms_outgoing` solo tiene índices de una columna, y en InnoDB `id_account__idx` y `dst_number_idx` llevan `id` al final. Por
eso se acota por `id`, con un margen de 1 día, y sin `COUNT(*)`:

```sql
SELECT /*+ MAX_EXECUTION_TIME(2000) */ connectus_pages.sms_cutoff_id(?) AS lo[, connectus_pages.sms_cutoff_id(?) AS hi];
-- lo: inicio del rango menos 1 día. hi: fin del rango (23:59:59) más 1 día.

SELECT /*+ MAX_EXECUTION_TIME(8000) */ id, id_delivery, dst_number, sms_content, status, created_at
FROM connectus_pages.sms
WHERE id_account = ? AND id > ?                   -- lo
  [AND id <= ?]                                   -- hi
  AND created_at BETWEEN ? AND ?
  [AND dst_number = ?]
  [AND id < ?]                                    -- cursor
ORDER BY id DESC LIMIT 51;                        -- 50 de página; la fila 51 solo indica que hay más
```

La cota `hi` se usa solo si `end` es anterior a hoy en Chile menos 2 días. `hi` es la fila con el `created_at` mayor bajo el fin
más 1 día: mientras ese día no pase no hay filas de margen delante del rango, `hi` es la fila más nueva por `created_at` y no la
de id mayor, y dejaría fuera toda fila con id mayor y `created_at` menor, de cualquier cuenta. En ese caso tampoco ahorra nada.
El día extra de holgura cubre el cambio de hora.

Los nombres de envío se traen aparte, con `SELECT /*+ MAX_EXECUTION_TIME(2000) */` y `WHERE id IN (...) AND id_account = ?` sobre
la vista `delivery`.

`MAX_EXECUTION_TIME` es por sentencia y estas tres corren en serie: suman 12 s, que tienen que caber en el plazo de la petición
(ver "Plazo por petición") junto con el arranque en frío.

### Logins y cuentas

`scripts/crear_login.js` solo crea el login y sus vínculos en `login_account`. Si una cuenta no está en `allowed_account`, la FK
rechaza el SQL (error 1452) y la transacción no deja nada: así un error de tipeo no abre las vistas a la cuenta de otro cliente.
Ampliar la lista es un paso aparte y previo, como master, revisando antes de quién es la cuenta:

```sql
SELECT id, name FROM dbconnectus.account WHERE id = ?;
INSERT INTO connectus_pages.allowed_account (id_account) VALUES (?);
```

Con una clave escrita a mano, el SQL va primero a un archivo, porque sin `--generar` el script termina con error si su salida es
un pipe. Con `mysql -p` al otro lado, los dos procesos leerían la misma terminal, y la clave nueva quedaría a la vista en la
pantalla sin que nada avise:

```sh
(umask 077; node scripts/crear_login.js --usuario <u> --cuentas 1,2 > login.sql)
mysql ... < login.sql
rm login.sql
```

Con `--generar` se puede canalizar: `node scripts/crear_login.js ... --generar | mysql ...`. El script no lee la terminal, pero
Node guarda su estado al arrancar y lo restaura al salir: con `mysql -p` al otro lado, le devolvería el eco mientras se teclea la
clave del master, o dejaría la terminal sin eco si `mysql` termina primero. Por eso el script reabre a `/dev/null` sus descriptores
de terminal antes de terminar, también al rechazar un pipe: Node no restaura un descriptor que ya apunta a otro archivo. Eso no está
documentado en Node, así que lo comprueban pruebas en una terminal real.

Para cambiar una clave comprometida basta con un `UPDATE` de `password_hash`: el trigger sube `token_version` y los tokens ya
emitidos dejan de valer. Para cerrar las sesiones sin cambiar la clave: `SET token_version = token_version + 1`.

## Backend

Node 22 en CommonJS, con `mysql2` y `aws-ssl-profiles`. Sin framework. El SDK de
AWS lo pone el runtime de Lambda; se carga de forma diferida y solo fuera de `STAGE=local`.

| Archivo | Responsabilidad |
| --- | --- |
| `src/handler.js` | `exports.app`: adapta el evento de API Gateway REST (proxy v1) a `createApp()` y le pone el plazo a la petición. La IP sale de `requestContext.identity.sourceIp`. Acepta `isBase64Encoded`. |
| `src/app.js` | `createApp({ db, config, clock })`: enrutador puro y testeable con una base falsa. |
| `src/config.js` | Fuera de `STAGE=local`, lee Parameter Store una vez por contenedor; ignora las variables de entorno locales. |
| `src/db.js` | Pool `mysql2/promise`: `query` para leer y `write` para escribir, porque reintentan distinto. |
| `src/auth.js` | Hash de clave, token y flujo de login. |
| `src/sms.js` | Validación de la búsqueda, consultas y etiquetas de estado. |
| `src/cursor.js` | Cifra y descifra el cursor de paginación. |
| `src/headers.js` | Cabeceras de seguridad y validación de `frame_ancestors`. |
| `src/static.js` | Sirve `public/` con un mapa fijo de rutas; nunca arma rutas desde la URL. |

### Configuración

Parameter Store, bajo `/connectus-pages/prod/`: `db_host`, `db_user`, `db_password` (SecureString), `token_secret`
(SecureString, al menos 32 bytes; si es más corto, la app no arranca), `frame_ancestors`.

`STAGE=local` usa en cambio `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_SSL_CA_FILE`, `TOKEN_SECRET` y
`FRAME_ANCESTORS`. Esa rama no puede activarse en producción: `serverless.yml` fija `STAGE: prod`.

La configuración se lee una vez por contenedor, así que un cambio en Parameter Store, también quitar un dominio de
`frame_ancestors`, no rige en los contenedores calientes y mientras tanto la respuesta depende de cuál atienda. Para aplicarlo
hay que reciclarlos; ver Despliegue.

### Conexión

- Fuera de local: `ssl: { ca: require('aws-ssl-profiles').ca, rejectUnauthorized: true, verifyIdentity: true }`.
  En local: `ca` del archivo, `rejectUnauthorized: true`, `verifyIdentity: false`.
- `connectionLimit: 1`, porque un contenedor Lambda atiende una petición a la vez. `connectTimeout: 5000`.
- `dateStrings: true`, `supportBigNumbers: true`, `bigNumberStrings: true`, `charset: 'utf8mb4'`, `stringifyObjects: true`.
- Al abrir cada conexión: `SET SESSION wait_timeout = 120, max_execution_time = 3000, lock_wait_timeout = 5,
  innodb_lock_wait_timeout = 5`.
  - `wait_timeout`: un contenedor congelado deja la conexión abierta, y con los 28800 s de Aurora se agotaría
    `MAX_USER_CONNECTIONS`.
  - `max_execution_time`: el tope de los `SELECT` sin hint. El hint de una sentencia gana sobre este valor, lo que está comprobado
    con el de 8000 ms contra 5.7 y 9.3. Si un `SELECT` sin hint llega a los 3 s, la respuesta es 504, también en el login.
  - `lock_wait_timeout` e `innodb_lock_wait_timeout`: el tope de un `UPDATE` o un `INSERT` esperando un bloqueo, que
    `max_execution_time` no cubre. Por defecto serían 1 año y 50 s. Llega como 1205: en el login da 503, y en `audit_log` solo se
    registra y la petición sigue.
- Lecturas (`db.query`): una conexión que el servidor cerró se reintenta una vez, en una conexión nueva. Incluye el error 4031
  (`ER_CLIENT_INTERACTION_TIMEOUT`) que MySQL 8.0.24 o superior envía al cerrar por `wait_timeout`: un contenedor que recién
  despierta lo recibe como respuesta de su consulta, sin `fatal`, y la conexión muerta sigue en el pool hasta que se la saca.
- Escrituras (`db.write`, para los `UPDATE` de `login` y el `INSERT` de `audit_log`): se reenvían solo si es seguro que el servidor
  no las ejecutó, o sea con 4031 o con un error fatal sin código. Ante `PROTOCOL_CONNECTION_LOST`, `ECONNRESET` o `EPIPE` no se
  reenvían, porque el servidor pudo aplicarlas: un intento de login contaría doble y el bloqueo saltaría antes. Los `UPDATE` de
  `login` responden 503, y `writeAudit` registra el código y deja seguir la petición.
- Siempre `pool.query()` con `?`, no `execute()`: `execute` manda los números de JS como DOUBLE y compara mal contra BIGINT.
  Solo llegan a la consulta valores ya validados y de tipo primitivo.

### Plazo por petición

El handler corre cada petición en carrera con un temporizador: `context.getRemainingTimeInMillis()` menos 2 s, o 23 s si no hay
`context` (el `timeout` de 25 s menos ese margen). Cubre cargar la configuración, conectar y todas las sentencias. Sin esto, si la
base no contesta, ninguna sentencia vuelve, la Lambda muere y API Gateway da un 502 sin las cabeceras de seguridad.

Si vence, la respuesta es 503 `busy`, con las cabeceras de seguridad y `frame-ancestors 'none'`, porque a esa altura puede no haber
configuración. Se registra `request_deadline_exceeded`, sin datos de la petición, y se descarta la app del contenedor, para que la
siguiente petición cree un pool nuevo: una conexión colgada con `connectionLimit: 1` dejaría en cola todo lo que venga después.

El pool viejo se cierra sin esperarlo, porque `pool.end()` no termina hasta que vuelva la sentencia colgada. Si la red se quedó
callada, ese socket sigue abierto hasta que muera el contenedor; en el servidor lo libera `wait_timeout`.

No hay plazo por sentencia del lado del cliente: `pool.query({ sql, timeout })` deja la conexión tomada y, con `connectionLimit: 1`,
la consulta siguiente queda en cola para siempre.

### API

Todas las respuestas de la app llevan las cabeceras de seguridad. Los errores son JSON: `{ "error": "<codigo>", "message":
"<texto>" }`. Las que genera el WAF (429 `too_many_requests`, misma forma) o API Gateway no pasan por la app y no llevan esas
cabeceras.

| Ruta | Respuesta |
| --- | --- |
| `GET /` | `public/index.html` |
| `GET /app.js`, `GET /app.css` | estáticos (`Cache-Control: no-cache`) |
| `POST /api/login` | ver abajo |
| `GET /api/sms` | ver abajo |
| otra | 404 `not_found`; método equivocado en una ruta existente, 405 `method_not_allowed` |

**`POST /api/login`**: exige `Content-Type: application/json`, 415 si no, y cuerpo de 4 KB como máximo.
Cuerpo `{ "username": string, "password": string }`. `username` debe calzar con `^[A-Za-z0-9._@-]{1,64}$` y `password` tener
de 1 a 256 caracteres; ambos deben ser strings (cualquier otro tipo, 400).

- Éxito: 200 `{ "token": "...", "expiresIn": 3600, "accounts": [{ "id": 1, "name": "..." }] }`.
- Falla por cualquier motivo (usuario inexistente, clave mala, inactivo, bloqueado): 401 `invalid_credentials`, con el mismo
  mensaje: "Usuario o contraseña incorrectos, o acceso bloqueado temporalmente." Siempre se calcula un scrypt, también con un
  hash ficticio si el usuario no existe, y toda falla tarda al menos 1500 ms, para que el tiempo no delate cuáles existen: un
  usuario existente hace una escritura más. Ese piso tiene que superar el peor caso normal; si una falla se pasa, la consola
  registra `login_floor_exceeded` con los ms.
- Bloqueo: 5 fallos seguidos bloquean 15 minutos. Es una sola sentencia atómica, y el orden del `SET` importa porque MySQL
  evalúa de izquierda a derecha: `SET locked_until = IF(failed_attempts + 1 >= 5, UTC_TIMESTAMP() + INTERVAL 15 MINUTE,
  locked_until), failed_attempts = IF(failed_attempts + 1 >= 5, 0, failed_attempts + 1) WHERE id = ?`.
  Mientras está bloqueado, los intentos no suman ni se compara la clave contra un hash real. El bloqueo solo frena esta ruta:
  no corta las sesiones abiertas, porque si no cualquiera que supiera un nombre de usuario podría expulsarlo sin credenciales.
- Al entrar: `failed_attempts = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP()`.

**`GET /api/sms`**: exige `Authorization: Bearer <token>`. En cada petición se relee el login: si no existe, está inactivo o su
`token_version` ya no es la del token, 401 `unauthorized`. Por eso revocar un acceso con `active = 0` o cambiar la clave tiene
efecto inmediato. La lista de cuentas sale de `login_account` en esa misma petición, nunca del token.

Parámetros (cada uno debe venir una sola vez; si viene repetido, 400):

- `account` (obligatorio): entero positivo. Si no es una cuenta del login, 403 `forbidden`.
- `start`, `end` (obligatorios): `YYYY-MM-DD`, fecha real. Mismo tope que la plataforma: `end >= start` y `end - start < 15`. Si no,
  400 con "El rango debe ser válido y no superar 15 días."
- `dst` (opcional): se dejan solo los dígitos, como en la plataforma, y deben quedar de 1 a 15 (E.164). Si no, 400 con "Debes indicar un
  número destino válido."
- `cursor` (opcional): el valor opaco de `nextCursor`. Si no es uno emitido por la app para esa misma cuenta, 400 `invalid_request`.

Respuesta 200:

```json
{
  "items": [{ "createdAt": "31/10/2026 14:05", "dst": "56900000000", "content": "...", "status": "Entregado", "delivery": "Nombre o null" }],
  "nextCursor": "<48 caracteres base64url>"
}
```

`nextCursor` es `null` en la última página. `dst` va como string. `createdAt` se formatea desde el texto de la base, sin pasar
por `Date`, para que no intervenga ninguna zona horaria.

Ni `items` ni `nextCursor` dejan ver el `id` de `sms_outgoing`: es un autoincremental compartido por todas las cuentas, y restando
dos un cliente estimaría el volumen de toda la plataforma. El cursor es AES-256-GCM del id (8 bytes), con IV al azar de 12 bytes,
clave derivada de `token_secret` con HKDF-SHA256 y la cuenta como dato autenticado, en base64url de `iv || cifrado || tag`.

Etiquetas de estado, iguales a las de la plataforma: `NEW` Programado; `DELIVRD` Entregado; `UNDELIV` No
entregable; `SENT_TO_ESME` Enviado a proveedor; `ESME_ROK` Esperando respuesta; `QUEUED` Encolado; `OUTBALANCE` Sin saldo; otro
que contenga `ESME_`, No entregable. Para cualquier otro valor, incluido `NULL`, se devuelve "Sin información".

Otros errores:

- 500 `internal`.
- 503 `busy`, con "El servicio está ocupado. Inténtalo de nuevo en unos minutos.":
  - si la base responde 1040, 1053 (`ER_SERVER_SHUTDOWN`), 1203, 1205 (`ER_LOCK_WAIT_TIMEOUT`), 1226 o 4031;
  - si no hay conexión o se pierde durante un `UPDATE` de `login`;
  - si se corta el saludo TLS. `mysql2` lo reporta como `HANDSHAKE_SSL_ERROR`, igual que un certificado inválido, que también da
    503; el registro conserva el código;
  - si vence el plazo de la petición.
- 504 `timeout`, con "La consulta tardó demasiado. Acota las fechas o indica un número.", si el servidor corta la consulta. Se
  clasifica lo que se observó contra `mysqld` 5.7.44 y 9.3.0:
  - 3024 (`ER_QUERY_TIMEOUT`): el corte de `MAX_EXECUTION_TIME`, en las dos versiones;
  - 1028 (`ER_FILSORT_ABORT`): el mismo corte si cae durante un filesort, visto en 5.7 y no en 9.3;
  - 1317 (`ER_QUERY_INTERRUPTED`): `KILL QUERY` de otra sesión, en las dos versiones.

### Clave y token

- Hash: `crypto.scrypt`, N=2^15, r=8, p=1, 32 bytes, sal de 16 bytes, formato `scrypt$32768$8$1$<sal_b64>$<hash_b64>`.
  Comparación con `timingSafeEqual`. `maxmem` de al menos 64 MB.
- Token: formato JWT con HMAC-SHA256, sobre `node:crypto`. Cabecera fija `{"alg":"HS256","typ":"JWT"}`, que se exige byte a
  byte al verificar. Payload `{ "iss": "connectus_pages", "sub": <id de login>, "ver": <token_version>, "iat": n, "exp": n }`, con
  1 hora de vigencia. Firma comparada con `timingSafeEqual`. No se acepta otro `alg`, otro `iss`, un `sub` que no sea entero
  positivo, un `ver` que no sea entero mayor o igual a 0 ni un token vencido.

### Cabeceras de seguridad

En todas las respuestas:

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors <lista o 'none'>
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Robots-Tag: noindex
```

Nunca `X-Frame-Options`. En `/api/*`, además, `Cache-Control: no-store`. `frame_ancestors` es una lista separada por espacios.
Cada elemento debe calzar con `^https://[a-z0-9.-]+(:[0-9]{1,5})?$`; en `STAGE=local` también se acepta `http://` a localhost o
127.0.0.1. Si un elemento no calza, se descarta y se registra el error. Si no queda ninguno, `'none'`.

### Registro

- `audit_log`: `login_ok`, `login_fail` (con `id_login` solo si el usuario existe), `search`, con `detail` de la forma
  `2026-10-01..2026-10-15 con_numero` o `sin_numero`, y `forbidden` al pedir una cuenta ajena, con `id_login` y la cuenta pedida
  (si no cabe en INT, `id_account` queda `NULL` y `detail` es `cuenta_fuera_de_rango`). **Nunca el número ni el contenido.** Si la
  inserción falla, se registra el código y la petición sigue.
- Consola: solo eventos y códigos de error. Nunca claves, tokens, números, contenido de SMS ni parámetros de SQL.

## Front

`public/index.html`, `public/app.js` y `public/app.css`. JS sin dependencias ni CDN (la CSP solo permite `'self'`), sin scripts
ni estilos en línea ni atributos `style`. Todo el contenido dinámico se pinta con `textContent`, nunca con `innerHTML`.

- El estado inicial de `index.html` es un aviso estático y neutro, "La consulta está tardando en cargar. Si no aparece, recarga la
  página.", con el login oculto. `app.js` los cambia al terminar de arrancar: si API Gateway rechaza ese archivo, el login no queda a
  la vista sin hacer nada. Sin JS en línea no se distingue si `app.js` falló o solo tarda, así que el texto es cierto en los dos
  casos y no se presenta como error, y el CSS solo lo muestra a los 3 s, para que no se asome en una carga normal. Sin JavaScript se
  ve el `<noscript>` y no este aviso.
- El token vive en una variable dentro de un IIFE; no en `window`, `localStorage`, `sessionStorage` ni cookies.
- Login: usuario y contraseña, `autocomplete` correcto y foco inicial solo fuera de un iframe: embebida, enfocar al cargar le
  quitaría el foco a la página del cliente y la haría saltar hasta el iframe. La contraseña se borra del campo al enviar.
- Consulta: selector de cuenta (si hay una sola, se muestra como texto), "Número destino" opcional, "Desde" y "Hasta" (por
  defecto, los últimos 15 días incluyendo hoy, calculados en `America/Santiago`), botón "Buscar".
- Resultados: tabla Fecha, Número destino, Mensaje, Estado, Envío. "Sin envío" si `delivery` es `null`. Paginación anterior y
  siguiente: "siguiente" usa `nextCursor` y "anterior", una pila de cursores en el cliente. Al cambiar un filtro se vuelve al
  inicio. Una respuesta vieja nunca debe pisar a una búsqueda más nueva.
- Estados vacíos, de carga (`aria-live`) y de error, con el `message` del servidor. Un 401 vuelve al login con aviso de sesión
  vencida y borra de la pantalla los datos anteriores. Un 403 borra los resultados y saca esa cuenta del selector. "Salir" borra
  el token y los datos.
- Debe verse bien en un iframe angosto: sin scroll horizontal de página a 360 px; la tabla hace scroll dentro de su contenedor.
- Aspecto tomado de la vista de la plataforma: cabecera con `linear-gradient(135deg, #344767 0%, #416f96 58%, #5db7e5 100%)`, texto
  `#344767`, secundario `#67748e`, bordes `#dce4ec`, acento `#5db7e5`, fuente del sistema. Textos: "Acceso de solo lectura",
  "Consulta de SMS", "Hasta 15 días por consulta". Solo modo claro, con `color-scheme: light` y fondo explícito.

## Despliegue

`serverless.yml`: `service: connectus-pages`, framework v4, `runtime: nodejs22.x`, `us-west-2`, `memorySize: 256`, `timeout: 25`,
`reservedConcurrency: 5`, `logRetentionInDays: 30`, `STAGE: prod`, permiso IAM solo `ssm:GetParameters` sobre
`parameter/connectus-pages/prod/*`. Eventos `http` (REST regional) `/` y `/{proxy+}`. Dominio con `serverless-domain-manager`:
el nombre y el `certificateArn` llegan por variables (`${env:...}`), con `createRoute53Record: true`, porque la zona está en
Route 53. El paquete incluye `src/**`, `public/**` y `node_modules/**`, y excluye `test/**`, `docs/**`, `sql/**`, `scripts/**` y
`.env*`.

El `timeout` supera los 12 s de consultas de una búsqueda más el arranque en frío (Parameter Store y TLS), con el margen del plazo
por petición, para que la app alcance a responder su 504 o su 503, y queda bajo los 29 s de API Gateway.

Límites antes de la base, porque un login anónimo gasta scrypt, 2 sentencias y un cupo de `reservedConcurrency`:

- WAF regional (`AWS::WAFv2::WebACL`, asociado a la etapa), con dos reglas rate-based por IP que al pasarse responden 429
  `too_many_requests`:
  - `login-por-ip`, prioridad 0: `POST` a rutas que terminan en `/api/login`, 30 peticiones cada 5 minutos, más que suficiente para
    una oficina detrás de una sola IP. Termina en esa ruta, y no es exacta, porque el endpoint por defecto de API Gateway antepone
    la etapa.
  - `general-por-ip`, prioridad 1: todas las rutas, sin scope-down, 1500 peticiones cada 5 minutos, con un mensaje que no habla de
    intentos. Existe porque el throttling de la etapa no distingue clientes: sin ella, una sola IP sin credenciales con `GET /app.js`
    agotaría el cupo de todos, también el de las sesiones abiertas.
- Throttling de la etapa `prod`: 20 peticiones por segundo, ráfaga de 40 (`custom.stageThrottling`). El framework no tiene opción
  para esto y la etapa la crea un `Deployment` de id lógico cambiante, así que lo aplica `scripts/throttling_etapa.js`, un plugin
  local, con `updateStage` después de cada `serverless deploy`. Los despliegues siguientes no lo deshacen. Ese plugin va antes de
  `serverless-domain-manager` en `plugins:`: los hooks corren en serie y se detienen en el primer error, así que al revés, si el
  dominio fallara, la etapa quedaría publicada sin throttling.

El bloqueo por usuario no reemplaza estos límites, y estos no reemplazan al bloqueo.

Despliegue limpio, en orden:

1. `npm ci`.
2. Certificado de ACM emitido en `us-west-2`, la región de la API, porque el dominio es regional, y las variables
   `PAGES_DOMAIN_NAME` y `PAGES_CERTIFICATE_ARN` exportadas. `serverless` las resuelve en los dos últimos pasos.
3. Subir a Parameter Store `db_host`, `db_user`, `token_secret` y `frame_ancestors`.
4. Aprovisionar la base con `scripts/aprovisionar_bd.sh` y subir `db_password`.
5. Ampliar `allowed_account`, revisando antes de quién es cada cuenta (ver "Logins y cuentas"). En una base limpia está vacía.
6. Crear los logins con `scripts/crear_login.js` (ver "Logins y cuentas").
7. `serverless create_domain`, solo la primera vez: sin esto, `deploy` crea el stack y aplica el throttling, pero termina con error,
   sin mapeo ni registro en Route 53. No se usa `autoDomain`, porque `serverless remove` borraría también el dominio.
8. `serverless deploy`.

Todo cambio en Parameter Store exige reciclar los contenedores, porque la configuración se lee una vez por contenedor. El
procedimiento es cambiar algo de la configuración de la función:

```sh
aws lambda update-function-configuration --function-name connectus-pages-prod-app --description "config $(date -u +%FT%TZ)"
```

`serverless deploy` ya no se omite con este template, aunque el código no cambie: el `DependsOn` de la asociación del WAF lleva el id
de instancia, que cambia en cada corrida. Aun así no se usa para reciclar contenedores, porque ese efecto no está verificado.

## Pruebas

- `npm test`: unitarias con `node:test`, sin red ni base.
- `npm run test:integration`: `scripts/mysql_prueba.sh up` levanta un `mysqld` desechable con `--no-defaults`, datadir propio y
  puerto 33077 en 127.0.0.1, carga `test/fixtures/dbconnectus.sql` (solo las columnas e índices que usa la consulta, con los mismos
  tipos que la plataforma) y corre el aprovisionamiento real. No toca el MySQL del puerto 3306 ni ninguna base remota. La suite debe pasar
  también con un `mysqld` 8.x o superior en el `PATH`: producción es 8.0 y hay comportamientos, como el error 4031, que 5.7 no tiene.
  `test/integration/cortes.test.js` pone un proxy TCP delante de ese `mysqld`, para probar con el handler real lo que pasa si la red
  se queda callada o se corta justo después de un commit.
