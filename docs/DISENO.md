# connectus_pages: diseño y contrato

Mini app de consulta de solo lectura sobre los SMS de una o más cuentas: búsqueda, historial de envíos, detalle de un envío con sus
conteos, y exportación a CSV y XLSX. Se abre desde un enlace firmado y además pide usuario y clave. Está pensada para mostrarse dentro de
un programa de terceros, como un BI de escritorio, pero también funciona en un navegador común. Es una app aparte de la plataforma:
no comparte con ella código, sesión ni credenciales.

**El repo es público.** Aquí no van secretos, enlaces reales, ids de cuenta, nombres ni dominios de clientes, ni el endpoint de la base.
Eso vive en Parameter Store, en la base o en un runbook privado.

## Alcance

Entra:

- Enlace firmado y login propio, con selector de cuenta si el login tiene más de una.
- Consulta de SMS por número y fechas, paginada, con el detalle de cada mensaje.
- Historial de envíos SMS, con buscador.
- Detalle de un envío, con sus variantes, tablas de conteo, gráfico, mensajes, respuestas y links cortos.
- Exportación: SMS del período en CSV, y reporte y respuestas de un envío en XLSX.

No entra: recuperar o cambiar la clave por el usuario (lo hace Connectus a mano), reporte de clics, saldo, gestión de desuscritos,
nada que escriba en la plataforma.

Lo que conviene tener presente al compararla con la plataforma:

- Los conteos y el gráfico son una foto, con "Actualizado el dd/mm/aaaa a las HH:MM". Pueden atrasarse hasta 10 minutos, más lo que tarde
  el cálculo, que en un envío grande son minutos.
- Las tablas suman el total: lo que no calza con una categoría va a "Otros estados" o a la columna "Otros".
- La paginación es por cursor, sin número de páginas.
- Los envíos sin fecha de creación no aparecen en la lista.
- El CSV no lleva columna de id: la referencia de cada fila es `Identificador único`.
- Ningún dato del usuario que creó un envío se lee ni se muestra.
- Un reporte o un archivo de respuestas ya generado es una foto de ese momento: muestra su fecha, y "Generar de nuevo" pide otro, dentro de los mismos topes. La plataforma lo genera de nuevo cada vez.
- Una descarga que falla por algo que no se puede revisar antes (S3 caído, una credencial vencida, un proxy corporativo, TLS) llega sin `attachment`: el navegador reemplaza el documento por ese error y hay que volver a ingresar la clave. Es el costo de usar un `<a>` sin iframe oculto. La app comprueba que el objeto exista antes de firmar y avisa con una línea fija antes del clic, y la sonda lo mide con `/descarga-falla`.

## Arquitectura

```
Documento que embebe → API Gateway REST + WAF → Lambda app (Node 22) → Aurora MySQL 8.0, usuario pages_app
                       front y API en el mismo origen     │ URL prefirmada
                                                          ▼
                              Lambda worker, cada minuto → S3 (exports/)
                              usuario pages_worker
```

Barreras, de afuera hacia adentro:

1. WAF y throttling de la etapa: limitan por IP y en total, antes de llegar a la app.
2. Enlace firmado: sin un enlace vigente, `POST /api/login` no toca la base.
3. Login: usuario y clave del mismo login que nombra el enlace, con bloqueo por usuario.
4. Membresía: en cada petición, la cuenta pedida tiene que estar en `login_account`.
5. Base: `pages_app` y `pages_worker` solo ven `connectus_pages`, y sus vistas solo devuelven filas de `allowed_account`. Aunque el
   backend tenga un bug, no puede leer otras cuentas ni escribir en `dbconnectus`.

`frame-ancestors` no se cuenta como barrera de acceso. Decide quién puede embeber, y con `sin-restriccion` no decide nada (ver "Embebido").

La sesión no usa cookies, porque los navegadores bloquean las de terceros dentro de un iframe y un sandbox las prohíbe. El token vive en
una variable de JS, dentro de la clausura del front, y viaja en `Authorization: Bearer`. Recargar la página pide la clave de nuevo. Sin
cookies no hay CSRF ni autoridad ambiental.

Una sola regla de datos: ningún `id` autoincremental sale a la pantalla, a la API ni a un archivo, salvo `account.id` y `login.id`, que ya
conoce quien los usa. Lo que identifica un SMS o un envío hacia afuera es su `id_unique`, y una exportación, su `public_id`.

## Enlace firmado

### Formato

```
https://<host>/#e=l1.<ranura a|b>.<id_login>.<link_version>.<exp>.<firma>
```

`firma` es HMAC-SHA256 en base64url sobre `connectus_pages/link/v1\n` seguido de todo lo anterior a la firma, con el secreto de esa
ranura. Regex exacta, con una sola escritura posible para cada enlace:

```
^(l1\.([ab])\.([1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.([1-9][0-9]{9}))\.([A-Za-z0-9_-]{43})$
```

`src/link.js` verifica en este orden: forma, ranura cargada, firma con `timingSafeEqual`, rangos, vencimiento y que falten como máximo
365 días. Solo depende de `node:crypto`.

El enlace va en el fragmento porque no viaja al servidor. El front también acepta `?e=` si no hay fragmento, para un producto que pierda
el `#`: basta cambiar `#e=` por `?e=` en la URL emitida. `GET /api/*` nunca acepta el enlace por query, y la API solo lo recibe en el
cuerpo de `POST /api/login`.

### Qué protege y qué no

Protege:

- Deja a internet anónimo fuera del login: sin enlace no se llega a la base, al scrypt ni al bloqueo por usuario.
- Una clave robada no basta por sí sola: además hay que tener el enlace.
- Da un corte independiente de la clave: se revoca sin cambiarla, y vence solo.
- Limita una filtración a un login, porque cada enlace nombra uno solo.

No protege:

- **No identifica a nadie.** Quien tenga el archivo tiene el enlace, y la firma solo prueba que lo emitió Connectus.
- **No es un segundo factor.** Es una cadena copiable, un segundo secreto sin dispositivo detrás.
- **No es de un solo uso.** El archivo es estático y cada apertura reutiliza la misma URL, así que un enlace filtrado sirve hasta que venza o
  se revoque.
- **No avisa de su filtración.** Solo dan indicios `audit_log` y la alarma de `link_suspect`.
- **No se esconde del lado del cliente.** El fragmento evita al servidor y a los registros, no al historial, al archivo del BI ni al `src` del
  iframe, que lo llevan entero.
- **No reemplaza a la clave.** Sin la clave, el enlace no da acceso a nada: esa regla no se suelta. Una URL que abriera la consulta por sí
  sola sería una capacidad sobre números y contenidos de SMS.

Lo que gana quien tiene cada cosa:

| Tiene | Puede | No puede |
| --- | --- | --- |
| Nada | Recibir un 401 sin costo para la base, y gastar su cupo del WAF | Tocar la base, gastar scrypt ni bloquear a un usuario |
| Solo el enlace | Ver el formulario y probar claves de ese login | Bloquearlo sin adivinar el usuario, porque un usuario distinto no suma fallos |
| Enlace y usuario | Probar 5 claves cada 15 minutos, y mantener el login bloqueado | Cortar sesiones abiertas |
| Solo la clave | Nada desde internet | Pasar de `invalid_link` |
| Enlace y clave | Leer y exportar las cuentas de ese login hasta que se corte | Escribir en la plataforma, o leer cuentas fuera de `login_account` |
| `link_secret_*` | Forjar enlaces de cualquier login | Entrar sin clave |
| `token_secret` | Forjar sesiones sin clave y descifrar cursores | Es el secreto crítico: el que emite enlaces nunca lo lee |

Si los datos exigen más barrera, lo que la sube sin cambiar este diseño es una lista de IP de salida en el WAF.

### Vigencia, revocación y rotación

- **Vigencia:** 180 días por omisión al emitir, y 365 de tope exigido también al verificar. Una sesión abierta sigue hasta que venza su token, como
  máximo 1 hora. La página avisa desde 30 días antes. Renovar sin corte es emitir otro con la misma versión.
- **Revocar un login, sin desplegar:** como master, `UPDATE connectus_pages.login SET link_version = link_version + 1 WHERE username = ?;`. Rige
  en la siguiente petición. Todos los enlaces del login se revocan juntos. El trigger no toca `link_version`, así que cambiar la clave no rompe el
  archivo, y `pages_app` no puede escribirla.
- **Cortar todo de inmediato:** `SET link_version = link_version + 1, token_version = token_version + 1`, o `active = 0`. Revocar solo el enlace no
  corta las sesiones abiertas.
- **Rotar el secreto:** dos ranuras, porque rotar significa que el cliente edite un archivo. Subir el secreto nuevo a la ranura vacía y reciclar
  contenedores; emitir con esa ranura; cuando `audit_log.detail` muestre que la vieja ya no se usa, borrar su parámetro y reciclar.
- **Emergencia:** con una sola ranura cargada, que es lo normal, primero subir un secreto nuevo a la otra, distinto de `token_secret`; después borrar la comprometida y reciclar. Todos sus enlaces mueren juntos, y sin enlace no hay login: hay que emitir otros con la ranura nueva. **Si se borra la única ranura, toda la app responde 500 hasta subir otra y reciclar,** incluidos los estáticos y las sesiones abiertas.

### Uno por login

Si varias personas usan el mismo archivo, comparten login: 5 fallos bloquean a todas, y la auditoría no es personal.

### Emisión y entrega

Como master, para obtener id y versión: `SELECT id, link_version FROM connectus_pages.login WHERE username = ?;`. Después:

```sh
aws ssm get-parameter --name /connectus-pages/prod/link_secret_a --with-decryption \
    --query Parameter.Value --output text \
  | node scripts/crear_enlace.js --base "https://$PAGES_DOMAIN_NAME/" --ranura a --login <id> --version <n> --dias 180 \
  | pbcopy
```

La URL sale por stdout, y por stderr la fecha, el login, la versión y la ranura. El script no toca la base: una versión equivocada da un enlace que
falla en el primer uso. El secreto entra por stdin, o sin eco desde la terminal, y nunca por argumento. Conviene dejar un recordatorio de calendario al
emitir, porque la página solo avisa a quien la mira; `login_ok` guarda el vencimiento en `detail`, para consultar qué enlaces activos están por vencer.

El enlace y la clave se entregan por **canales distintos y en momentos distintos**. Si un mismo mensaje lleva los dos, el enlace deja de aportar frente a esa
filtración. Al cliente se le explica que la clave no va en el archivo ni en la URL, que compartir el informe comparte el enlace pero no la clave, y que si el
archivo se filtra o alguien se va, hay que avisar para revocar y cambiar la clave.

## Embebido

- `frame_ancestors` admite una lista de orígenes `https://` separados por espacio, o el valor exacto `sin-restriccion`, que omite la directiva. Vacío o
  inválido, `'none'`. `failClosedResponse` del handler siempre responde `'none'`. Con `sin-restriccion` se registra `frame_ancestors_open` al crear la app.
- Se omite en vez de usar `*` porque `frame-ancestors *` bloquea justo a los ancestros probables de un BI de escritorio: `file:` y orígenes opacos. No se amplía
  la validación a esos esquemas hasta tener el resultado de la sonda.
- `cors_opaque`: apagado salvo con el valor exacto `on`. Un documento sandbox sin `allow-same-origin` tiene origen opaco, y `fetch` a su propia API es cross-origin.
  Encendido, y solo si llega `Origin: null` en `/api/*`, también en errores, responde `Access-Control-Allow-Origin: null` y `Vary: Origin`; `OPTIONS /api/*` responde
  204 con `Allow-Headers: Authorization, Content-Type`, `Allow-Methods: GET, POST, OPTIONS` y `Max-Age: 600`. Nunca `Allow-Credentials`. Con otro `Origin`, nada.
  Apagado, `OPTIONS` sigue en 404 o 405.
- Ningún formulario depende de `submit`, que un sandbox sin `allow-forms` no dispara: botón `type="button"` con `click`, Enter en los campos con guarda contra doble
  disparo, y un listener de `submit` que solo hace `preventDefault`. El `<form>` se conserva para el relleno automático.
- El front trata un `TypeError` de `fetch` como error genérico: bajo CORS, las respuestas del WAF y de API Gateway no se pueden leer.
- Nada de `localStorage`, `sessionStorage`, `document.cookie` ni `autofocus`.

**Regla:** con `sin-restriccion`, toda acción exige Bearer y ninguna puede depender de autoridad ambiental. El marco de un atacante empieza sin sesión. Una acción nueva
que no sea reversible o tenga costo se revisa de nuevo. Crear una exportación ya gasta cupo del login y carga la base, y por eso exige sesión, tiene topes y se audita.

## Sonda

`sonda/` es un servicio aparte, sin dependencias, que no entra en el paquete de la app. Se despliega por su cuenta, con `cd sonda && serverless deploy`, y da una
Function URL pública, en otro origen, para ver cómo trata un BI a una página ajena sin abrir `frame-ancestors` en la app. No tiene datos ni login. Va **antes** de fijar
`frame_ancestors` y `cors_opaque`, y se repite tras una actualización mayor del BI. Cuando ya no haga falta: `serverless remove`, desde esa carpeta.

El cliente pone la URL en el objeto web del BI, agregando un `?prueba=1#prueba=2` inventado, sigue los pasos de la página y manda una captura. Muestra:

| Prueba | Qué responde |
| --- | --- |
| `self.origin` | Si es `null`, hay sandbox sin `allow-same-origin` |
| `self === top` | Webview de nivel superior o iframe |
| `location.ancestorOrigins` | La cadena de padres, incluidos `null`, `qrc:` o `file:`. Puede faltar en motores viejos |
| `navigator.userAgent` | Motor y versión |
| `isSecureContext`, `document.referrer` | Contexto y padre |
| `document.cookie`, `localStorage`, `sessionStorage` | Si lanzan error |
| `fetch` sin CORS, con CORS `null` y con `Authorization` | Si hace falta `cors_opaque`, y si el preflight llega |
| Campos con eco por tecla | Si el teclado funciona: letras, Tab, Enter, pegar |
| Formulario: `click`, `keydown`, `submit` | Si hay `allow-forms` |
| `window.open`, `target=_blank` | Si hay popups, y si abren dentro del BI o en el navegador |
| `<a download>`, blob, `Content-Disposition` | Si hay descargas y a dónde van |
| Enlace a `/descarga-falla` | Si una descarga fallida reemplaza el documento |
| `location.search`, `location.hash` | Si `?` y `#` sobreviven |
| Segundos en memoria y hora de carga | Si la página se recargó |

Rutas: `/`, `/sonda.js`, `/eco` (CORS `null`, con su preflight, y texto fijo), `/eco-sin-cors`, `/descarga` (`Content-Disposition: attachment`, texto fijo) y `/descarga-falla` (403 sin `attachment`, texto fijo, como un error de S3). Ninguna refleja
parámetros ni cabeceras, y la página pinta todo con `textContent`. Lleva la CSP de la app sin `frame-ancestors`, para que lo que falle ahí falle también allá.

El servidor registra `Sec-Fetch-Dest`, `Sec-Fetch-Site`, `User-Agent` y **solo el origen** del `Referer`, o su esquema si no tiene origen, cada uno cortado a 256 caracteres dentro
de `JSON.stringify`. Así se sabe qué embebe sin preguntarle al cliente. Retención de registros de 7 días, `reservedConcurrency: 2`. Una página en blanco también informa: si no
carga ni con la directiva omitida, el producto no deja pasar la página.

Qué se decide con el resultado:

| Si la sonda muestra | Entonces |
| --- | --- |
| `document.referrer` o los registros dan un origen `https://` estable | `frame_ancestors` con esa lista |
| Padre opaco, `file:` o de otro esquema | `frame_ancestors` en `sin-restriccion` |
| `self.origin` en `null`, y `fetch` sin CORS falla | `cors_opaque` en `on` |
| `location.hash` vacío y `location.search` intacto | Emitir el enlace con `?e=` |
| La hora de carga cambia al volver o al actualizar | Cada recarga pide la clave. 30 logins en 5 minutos por IP topan el WAF |
| Las descargas no bajan | Queda "Mostrar enlace", que lleva la consulta al navegador |
| `/descarga-falla` reemplaza la página | Una descarga fallida cuesta la sesión: es lo que advierte la línea fija antes del clic |

## Base de datos

Corre en Aurora MySQL 8.0, y el SQL asume el binlog apagado y `activate_all_roles_on_login` en 0. Las pruebas corren en MySQL 5.7.44 y 9.3.0, así que el SQL tiene que funcionar en
las dos; lo exclusivo de 8.0 va con comentario condicional (`/*!80021 ... */`).

Tablas de origen, solo las columnas que usan las vistas: `dbconnectus.sms_outgoing`, `delivery`, `account`, `contact_list`, `sms_incoming`, `short_link_delivery`, `short_link` y
`short_link_sms_outgoings`. `auth_user` no se toca.

Fechas, una regla por origen. Las de `dbconnectus` están en hora de Chile, sin zona: se comparan y se muestran desde el texto, sin `Date`. Las de `connectus_pages` están en UTC, se
escriben con `UTC_TIMESTAMP()` o con la hora de Node en UTC, nunca con `NOW()`, y se convierten a `America/Santiago` con `Intl` en Node antes de mostrarlas o de usarlas en un nombre de archivo.

Números: con `bigNumberStrings`, todo `COUNT`, `SUM` y columna `BIGINT` llega como texto. Pasa por `toSafeId` antes de operar, y toda fila de `export_job`, por `parseJob`. Se prueba contra `mysqld`
real, porque una base falsa que devuelva números no lo detecta.

### Cuentas de base de datos

Listas cerradas: `test/integration/grants.test.js` las exige exactas.

- `pages_owner`@`%`, `REQUIRE SSL`: dueña y DEFINER de vistas, función, procedimiento y trigger. Permisos directos, no por rol, porque con `activate_all_roles_on_login=0` un DEFINER que dependa de un rol
  pierde el acceso. `SELECT` por columna sobre las tablas de origen, ver `sql/00_cuentas.sql`, y `ALL ... WITH GRANT OPTION` en `connectus_pages.*`. Queda con `ACCOUNT LOCK`; un DEFINER bloqueado sigue
  funcionando. Así no hace falta `SET_USER_ID`.
- `pages_app`@`%`, `REQUIRE SSL`, `MAX_USER_CONNECTIONS 8`, `MAX_CONNECTIONS_PER_HOUR 2000`, `MAX_QUERIES_PER_HOUR 0`: la app. No tiene tope de consultas por hora a propósito: lo comparte toda la app, y cualquiera lo
  agotaría dejándola en 503. La carga ya la acotan `reservedConcurrency`, las conexiones y `MAX_EXECUTION_TIME`, y el login lo frenan el enlace, el WAF y el throttling.
  - `SELECT` en `login`, `login_account`, `account`, `delivery`, `delivery_datos`, `sms`, `sms_de_cuenta`, `sms_de_numero`, `sms_de_envio`, `sms_ids_de_envio`, `incoming_ids_de_envio`, `link_de_envio`, `link_de_sms`;
  - `UPDATE (failed_attempts, locked_until, last_login_at)` en `login`;
  - `INSERT` en `audit_log`; `EXECUTE` en `sms_cutoff_id`; `SELECT, INSERT, UPDATE` en `delivery_stats`;
  - `SELECT` e `INSERT (public_id, id_login, id_account, kind, id_delivery, delivery_name, start_date, end_date, dst_number, created_at)` en `export_job`. El estado de un job solo lo escribe el trabajador.
  - Nada sobre `sms_incoming_de_envio`, `allowed_account` ni `dbconnectus`.
- `pages_worker`@`%`, `REQUIRE SSL`, `MAX_USER_CONNECTIONS 2`: el trabajador.
  - `SELECT` en `account`, `delivery`, `sms_de_cuenta`, `sms_de_numero`, `sms_de_envio`, `sms_incoming_de_envio`;
  - `EXECUTE` en `sms_cutoff_id` y `purge_audit_log`; `INSERT` en `audit_log`; `SELECT, UPDATE, DELETE` en `export_job`;
  - `DELETE` y `SELECT (id_delivery, updated_at)` en `delivery_stats`;
  - Nada en `login`, `login_account`, `allowed_account`, `sms_ids_de_envio` ni `dbconnectus`.

### Esquema `connectus_pages` (utf8mb4)

La definición completa está en `sql/01_esquema.sql`.

| Objeto | Para qué |
| --- | --- |
| `login` | Usuario, hash, `active`, `token_version`, `link_version`, intentos, bloqueo |
| trigger `login_password_changed` | Si cambia `password_hash`, sube `token_version`. No toca `link_version` |
| `allowed_account` | Lista dura de cuentas que las vistas pueden devolver |
| `login_account` | Qué cuentas tiene cada login, con FK a `allowed_account` |
| `audit_log` | Auditoría. Sin número ni contenido |
| `delivery_stats` | Foto de conteos por envío y su trabajo en curso |
| `export_job` | Una exportación y su avance. `public_id` es lo único que ve el cliente |
| `sms_cutoff_id(p_before)` | Id de la última fila anterior a una fecha |
| `purge_audit_log()` | Borra hasta 1000 filas de `audit_log` de más de 1 año. Es lo único con lo que el trabajador toca esa tabla más allá del `INSERT` |

Todas las vistas son `ALGORITHM=MERGE`, `DEFINER=CURRENT_USER`, `SQL SECURITY DEFINER`, y cruzan con `allowed_account`. El índice va fijado en la definición, y cada consulta elige la vista según su filtro: así el costo
queda acotado por las filas de esa cuenta, ese número o ese envío, sin depender del optimizador de cada versión. Si alguien borra un índice, la vista falla con 1176.

| Vista | Índice | Para |
| --- | --- | --- |
| `sms_de_cuenta` | `id_account__idx` | Búsqueda y exportación sin número |
| `sms_de_numero` | `dst_number_idx` | Búsqueda y exportación con número, mensajes de un envío con número |
| `sms_de_envio` | `id_delivery__idx` | Conteos, mensajes y reporte de un envío |
| `sms` | El único de `id_unique` | Detalle de un SMS |
| `sms_ids_de_envio`, `incoming_ids_de_envio` | Cubrientes, acotados por la cuenta del envío | Contar sin leer la fila. No devuelven datos |
| `delivery`, `delivery_datos`, `account` | | Envíos y nombres |
| `sms_incoming_de_envio` | `index_sms_incoming_on_id_delivery` | Reporte de respuestas. Solo la ve el trabajador |
| `link_de_envio`, `link_de_sms` | | Links cortos |

### Reglas de consulta

- `MAX_EXECUTION_TIME` en cada `SELECT`. Sin `OFFSET` sobre filas completas, y sin `COUNT` por cuenta.
- Se valida antes de consultar: `id_unique` con `typeof === 'string'` y `^[0-9A-Za-z-]{1,32}$`; `q` con un carácter sobre U+FFFF responde vacío sin consultar, porque las columnas de la plataforma son utf8mb3; `LIKE` con
  `ESCAPE '!'`; `dst` como número JS.
- Toda búsqueda de un envío lleva `id_account`, también al traer su nombre para un SMS.
- Se usa `pool.query()` con `?`, no `execute()`: `execute` manda los números como DOUBLE y compara mal contra BIGINT.

Búsqueda de SMS: `sms_outgoing` solo tiene índices de una columna, y en InnoDB los secundarios llevan `id` al final. Por eso se acota por `id`, con un margen de 1 día, y sin `COUNT(*)`:

```sql
SELECT /*+ MAX_EXECUTION_TIME(2000) */ connectus_pages.sms_cutoff_id(?) AS lo[, connectus_pages.sms_cutoff_id(?) AS hi];
-- lo: inicio del rango menos 1 día. hi: fin del rango (23:59:59) más 1 día.

SELECT /*+ MAX_EXECUTION_TIME(8000) */ id, id_delivery, dst_number, sms_content, status, created_at
FROM connectus_pages.sms_de_cuenta                -- o sms_de_numero, si hay número
WHERE id_account = ? AND id > ?                   -- lo
  [AND id <= ?]                                   -- hi
  AND created_at BETWEEN ? AND ?
  [AND dst_number = ?]
  [AND id < ?]                                    -- cursor
ORDER BY id DESC LIMIT 51;                        -- 50 de página; la fila 51 solo indica que hay más
```

La cota `hi` se usa solo si `end` es anterior a hoy en Chile menos 2 días. `hi` es la fila con el `created_at` mayor bajo el fin más 1 día: mientras ese día no pase no hay filas de margen delante del rango, y dejaría fuera
filas con id mayor y `created_at` menor. El día extra de holgura cubre el cambio de hora. Los nombres de envío se traen aparte, con `WHERE id IN (...) AND id_account = ?`. Las tres sentencias corren en serie y suman 12 s, que tienen que caber
en el plazo de la petición junto con el arranque en frío.

### Clasificación de errores

| Errores | Respuesta |
| --- | --- |
| 1267, 3854 (un carácter que la columna no puede guardar) | 400 `invalid_request`, y evento `bad_text`, sin alarma |
| 3024 (corte de `MAX_EXECUTION_TIME`), 1028 (el mismo corte durante un filesort, visto en 5.7), 1317 (`KILL QUERY`) | 504 `timeout`, y evento `request_cut`, sin alarma |
| 1040, 1053, 1203, 1205, 1213, 1226, 4031, y errores de conexión o de saludo TLS | 503 `busy`, y evento `request_failed` |
| 1054, 1142, 1143, 1146, 1176, 1305, 1356, 1370 | 500 `internal`, y evento `schema_error` en consola con el código |
| Otro | 500 `internal`, y evento `request_failed` |

**Nunca se registra ni se relanza un error de `mysql2`:** su `sql` trae el número ya interpolado, y el runtime de Lambda copia al registro las propiedades enumerables. Se registra `errorCode`, y si hay que lanzar, `new Error(codigo)`.

### Logins y cuentas

`scripts/crear_login.js` solo crea el login y sus vínculos en `login_account`. Si una cuenta no está en `allowed_account`, la FK rechaza el SQL (error 1452) y la transacción no deja nada: así un error de tipeo no abre las vistas a la cuenta de otro
cliente. Ampliar la lista es un paso aparte y previo, como master, revisando antes de quién es la cuenta:

```sql
SELECT id, name FROM dbconnectus.account WHERE id = ?;
INSERT INTO connectus_pages.allowed_account (id_account) VALUES (?);
```

Con una clave escrita a mano, el SQL va primero a un archivo, porque sin `--generar` el script termina con error si su salida es un pipe. Con `mysql -p` al otro lado, los dos procesos leerían la misma terminal, y la clave nueva quedaría a la vista:

```sh
(umask 077; node scripts/crear_login.js --usuario <u> --cuentas 1,2 > login.sql)
mysql ... < login.sql
rm login.sql
```

Con `--generar` se puede canalizar: `node scripts/crear_login.js ... --generar | mysql ...`. El script reabre a `/dev/null` sus descriptores de terminal antes de terminar, porque Node restaura al salir el estado que guardó al arrancar, y con `mysql -p` al otro lado le
devolvería el eco mientras se teclea la clave del master. Eso no está documentado en Node, así que lo comprueban pruebas en una terminal real.

Para cambiar una clave comprometida basta un `UPDATE` de `password_hash`: el trigger sube `token_version` y los tokens ya emitidos dejan de valer. Para cerrar las sesiones sin cambiarla: `SET token_version = token_version + 1`. Recuperar una clave olvidada es
hacer esto mismo, a mano, por Connectus.

## Backend

Node 22 en CommonJS, con `mysql2` y `aws-ssl-profiles`. Sin framework. Los SDK de AWS los pone el runtime de Lambda; se cargan de forma diferida, y solo fuera de `STAGE=local`.

| Archivo | Responsabilidad |
| --- | --- |
| `src/handler.js` | `exports.app`: adapta el evento de API Gateway REST a `createApp()` y le pone el plazo a la petición. |
| `src/app.js` | `createApp({ db, config, storage, clock })`: enrutador y clasificación de errores, testeable con una base falsa. |
| `src/config.js` | Fuera de `STAGE=local`, lee Parameter Store una vez por contenedor. |
| `src/db.js` | Pool `mysql2/promise`: `query` para leer y `write` para escribir, porque reintentan distinto. `audit_log`. |
| `src/auth.js`, `src/link.js` | Hash de clave, token, flujo de login y enlace firmado. |
| `src/sms.js` | Búsqueda y detalle de SMS. |
| `src/deliveries.js` | Lista y detalle de envíos, mensajes. |
| `src/stats.js` | Foto de conteos. |
| `src/exports.js` | Jobs: crear, listar, topes, duplicados. |
| `src/cursor.js` | Cifra y descifra los cursores. |
| `src/time.js` | Hora de Chile y UTC. |
| `src/headers.js` | Cabeceras de seguridad, `frame_ancestors` y CORS. |
| `src/static.js` | Sirve `public/` con un mapa fijo de rutas; nunca arma rutas desde la URL. |
| `src/storage.js`, `src/presign.js` | Almacén de archivos, S3 o disco local, y firma de la descarga. |
| `src/worker/` | Trabajador: `handler`, `config`, `quiet`, `run`, `sources`, `csv`, `xlsx`. |

### Configuración

Parameter Store, bajo `/connectus-pages/prod/`. Cada función tiene su propio cargador y su propio rol IAM, con la lista exacta de nombres y sin comodín: `test/unit/deploy.test.js` exige que `serverless.yml` calce con los cargadores, y que el trabajador nunca incluya
`token_secret` ni `link_secret_*`. La app no puede leer la clave de `pages_worker`.

| Parámetro | Quién lo lee | Obligatorio | Tipo | Qué es |
| --- | --- | --- | --- | --- |
| `db_host` | app y trabajador | Sí | String | Endpoint de la base |
| `db_user` | app | Sí | String | `pages_app` |
| `db_password` | app | Sí | SecureString | Clave de `pages_app` |
| `token_secret` | app | Sí | SecureString | 32 bytes o más |
| `link_secret_a`, `link_secret_b` | app | Al menos uno | SecureString | 32 bytes o más. No pueden ser iguales entre sí ni a `token_secret` |
| `frame_ancestors` | app | No | String | Lista de orígenes, o `sin-restriccion`. Sin él, `'none'` |
| `cors_opaque` | app | No | String | `on` lo enciende. Cualquier otro valor, apagado |
| `worker_db_user` | trabajador | Sí | String | `pages_worker` |
| `worker_db_password` | trabajador | Sí | SecureString | Clave de `pages_worker` |
| `worker_quiet_windows` | trabajador | Sí | String | Ventanas sin lectura (ver "Trabajador"). Su valor no se publica |

Si falta un obligatorio, o un secreto no cumple, la app no arranca y responde 500 con `frame-ancestors 'none'`.

La app lee sus parámetros una vez por contenedor, así que un cambio, también quitar un dominio de `frame_ancestors`, no rige en los contenedores calientes. Hay que reciclarlos; ver "Despliegue". El trabajador los relee en cada corrida.

`STAGE=local` usa en cambio `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_SSL_CA_FILE`, `TOKEN_SECRET`, `LINK_SECRET_A`, `LINK_SECRET_B`, `FRAME_ANCESTORS` y `CORS_OPAQUE`; el trabajador, `WORKER_DB_USER`, `WORKER_DB_PASSWORD` y `WORKER_QUIET_WINDOWS`; y el almacén local, `EXPORTS_DIR`
y `EXPORTS_BASE_URL`. Esa rama no puede activarse en producción: `serverless.yml` fija `STAGE: prod`.

### Conexión

- Fuera de local: `ssl: { ca: require('aws-ssl-profiles').ca, rejectUnauthorized: true, verifyIdentity: true }`. En local: `ca` del archivo, `rejectUnauthorized: true`, `verifyIdentity: false`.
- `connectionLimit: 1`, porque un contenedor Lambda atiende una petición a la vez. `connectTimeout: 5000`.
- `dateStrings: true`, `supportBigNumbers: true`, `bigNumberStrings: true`, `charset: 'utf8mb4'`, `stringifyObjects: true`.
- Al abrir cada conexión: `SET SESSION wait_timeout = 120, max_execution_time = 3000, lock_wait_timeout = 5, innodb_lock_wait_timeout = 5`.
  - `wait_timeout`: un contenedor congelado deja la conexión abierta, y con el valor por defecto se agotaría `MAX_USER_CONNECTIONS`.
  - `max_execution_time`: el tope de los `SELECT` sin hint. El hint de una sentencia gana sobre este valor.
  - `lock_wait_timeout` e `innodb_lock_wait_timeout`: el tope de un `UPDATE` o un `INSERT` esperando un bloqueo, que `max_execution_time` no cubre. Llega como 1205.
- Lecturas (`db.query`): una conexión que el servidor cerró se reintenta una vez, en una conexión nueva. Incluye el 4031 que MySQL 8.0.24 o superior envía al cerrar por `wait_timeout`: un contenedor que recién despierta lo recibe como respuesta de su consulta, sin `fatal`, y la conexión muerta sigue en
  el pool hasta que se la saca.
- Escrituras (`db.write`): se reenvían solo si es seguro que el servidor no las ejecutó, o sea con 4031 o con un error fatal sin código. Ante `PROTOCOL_CONNECTION_LOST`, `ECONNRESET` o `EPIPE` no se reenvían, porque el servidor pudo aplicarlas: un intento de login contaría doble. Los `UPDATE` de `login`
  responden 503, y `writeAudit` registra el código y deja seguir la petición.

### Plazo por petición

El handler corre cada petición en carrera con un temporizador: `context.getRemainingTimeInMillis()` menos 2 s, o 23 s si no hay `context`. Cubre cargar la configuración, conectar y todas las sentencias. Sin esto, si la base no contesta, ninguna sentencia vuelve, la Lambda muere y API Gateway da un 502 sin las
cabeceras de seguridad.

Si vence, la respuesta es 503 `busy`, con las cabeceras de seguridad y `frame-ancestors 'none'`, porque a esa altura puede no haber configuración. Se registra `request_deadline_exceeded`, sin datos de la petición, y se descarta la app del contenedor, para que la siguiente petición cree un pool nuevo: una conexión
colgada con `connectionLimit: 1` dejaría en cola todo lo que venga después. El pool viejo se cierra sin esperarlo, porque `pool.end()` no termina hasta que vuelva la sentencia colgada.

No hay plazo por sentencia del lado del cliente en la app: `pool.query({ sql, timeout })` deja la conexión tomada y, con `connectionLimit: 1`, la consulta siguiente queda en cola para siempre.

### API

Todas las respuestas de la app llevan las cabeceras de seguridad. Los errores son JSON: `{ "error": "<codigo>", "message": "<texto>" }`. Las que genera el WAF (429 `too_many_requests`, misma forma) o API Gateway no pasan por la app, y no llevan esas cabeceras ni las de CORS.

`routes` es un mapa exacto, así que los identificadores van por query, no en la ruta. Otra ruta, 404 `not_found`; método equivocado, 405 `method_not_allowed`.

Toda ruta de datos exige Bearer, relee el login y revisa la membresía de la cuenta en cada petición, con 403 `forbidden` y auditoría si no calza. Cada parámetro debe venir una sola vez; si viene repetido, 400. La lista de cuentas sale de `login_account` en esa misma petición, nunca del token.

| Ruta | Qué hace |
| --- | --- |
| `GET /`, `GET /app.js`, `GET /app.css` | Estáticos, con `Cache-Control: no-cache` |
| `POST /api/login` | Cuerpo `{ link, username, password }`. Ver abajo |
| `GET /api/sms?account&start&end[&dst][&cursor]` | 50 por página. Audita `search` |
| `GET /api/sms/detail?account&id` | Detalle de un SMS. Audita `sms_view` |
| `GET /api/deliveries?account[&q][&cursor]` | 10 por página, más nuevos primero, sin `created_at` nulo. `q` hasta 100 caracteres |
| `GET /api/delivery?account&id` | Cabecera y variante. Audita `delivery_view` |
| `GET /api/delivery/progress?account&id` | `{ variant, sent, contacts }`, para consultar un envío en curso. Sin auditoría |
| `GET /api/delivery/stats?account&id` | Foto de conteos |
| `GET /api/delivery/messages?account&id[&dst][&cursor]` | 10 por página, por `id` ascendente. Con `dst`, número exacto, y audita `delivery_search` con `con_numero` |
| `POST /api/exports` | Crea una exportación |
| `GET /api/exports[?kind][&cursor]` | Del login, 10 por página, más nuevos primero |
| `GET /api/exports/status?id` | Estado de una |
| `GET /api/exports/download?id` | Solo terminadas y con el archivo presente. `{ url, expiresIn: 300, filename }` |

**`POST /api/login`**, en este orden:

1. `Content-Type: application/json`, 415 si no. Cuerpo de 4 KB como máximo, 413 si no. JSON de objeto, 400 si no.
2. Enlace, con `verifyLink`. Un rechazo por forma o firma da 401 `invalid_link`, y **no toca la base, ni scrypt, ni piso de tiempo, ni `audit_log`**. Consola: `{ event: 'link_rejected', reason }`, con `reason` en `malformed`, `unknown_slot`, `bad_signature`, `out_of_range`, `expired`, `too_long`. Nunca el enlace.
3. `username` con `^[A-Za-z0-9._@-]{1,64}$` y `password` de 1 a 256 caracteres, ambos strings. Si no, 400.
4. Se lee el login que nombra el enlace. Si no existe, o tiene otra `link_version`: 401 `invalid_link`, `login_fail` con `enlace_revocado` y consola `link_suspect`, sin scrypt ni piso, porque se decide antes de mirar al usuario y dormir retendría un cupo de la Lambda.
5. Si el usuario no calza: scrypt contra un hash ficticio, no suma fallo, `login_fail` con `usuario_no_coincide`, consola `link_suspect`, piso de tiempo, y 401 `invalid_credentials`. Quien tiene un enlace y prueba otros usuarios no bloquea a nadie.
6. Inactivo, bloqueado o clave mala: 401 `invalid_credentials`, siempre con "Usuario o contraseña incorrectos, o acceso bloqueado temporalmente.", un scrypt y al menos 1500 ms, para que el tiempo no delate nada. Si una falla se pasa del piso, consola `login_floor_exceeded`.
7. Bloqueo: 5 fallos seguidos bloquean 15 minutos, en una sola sentencia atómica, y el orden del `SET` importa porque MySQL evalúa de izquierda a derecha. Mientras está bloqueado, los intentos no suman ni se compara contra un hash real. El bloqueo solo frena esta ruta: no corta las sesiones abiertas, porque si no cualquiera con el enlace y un usuario podría expulsarlo.
8. Éxito: 200 `{ "token": "...", "expiresIn": 3600, "accounts": [{ "id": 1, "name": "..." }] }`. `failed_attempts = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP()`, y `login_ok` con `enlace <ranura> v<versión> vence <fecha>` en `detail`.

**`GET /api/sms`**:

- `account`: entero positivo. `start`, `end`: `YYYY-MM-DD`, fecha real, `end >= start` y `end - start < 15`. `dst` (opcional): se dejan solo los dígitos, y deben quedar de 1 a 15. `cursor` (opcional): el `nextCursor` que la app emitió para esa misma cuenta.
- Respuesta:

```json
{
  "items": [{ "createdAt": "31/10/2026 14:05", "dst": "56900000000", "content": "...", "status": "Entregado", "delivery": "Nombre o null", "deliveryId": "<id_unique o null>" }],
  "nextCursor": "<base64url o null>"
}
```

`deliveryId` es el `id_unique` del envío si es del producto SMS; si no, `null`, y el nombre queda como texto.

**`GET /api/sms/detail`**: `{ id, delivery, src, dst, country, updatedAt, provider, status, content, equivalent }`. `equivalent` es `ceil(bytes UTF-8 / 160)`. Inexistente, 404.

Etiquetas de estado: `NEW` Programado; `DELIVRD` Entregado; `UNDELIV` No entregable; `SENT_TO_ESME` Enviado a proveedor; `ESME_ROK` Esperando respuesta; `QUEUED` Encolado; `OUTBALANCE` Sin saldo; otro que contenga `ESME_`, No entregable; cualquier otro, incluido `NULL`, "Sin información".

**`GET /api/delivery`**: `{ id, name, type, createdAt, deliverAt, hasBase, base, contacts, variant, report, incoming }`, más `errorMessage` en `failed`, y `responses` y `link` en `complete`. `report` e `incoming` son el último job de este login para ese envío, por tipo: `{ id, state, filename, errorMessage, createdAt }` o `null`. Envío inexistente, ajeno o de otro producto: 404 `not_found`, "Envío no encontrado."

Variantes: `reciente` = `deliver_at` nulo o de hace menos de 1 día, calculado en Node con hora de Chile. `en_curso` = `status` en `new` o `processing` y `has_base`. `reciente && en_curso` es `generating`; `reciente && status == 'failed'` es `failed`, con `error_status` o "No quedó registrado el motivo."; lo demás, `complete`.
`error_status` no se muestra si trae el texto de una excepción: la vista lo deja nulo.

**`POST /api/exports`**: mismo 415 y 413 que el login. El cuerpo acepta solo strings: `{ kind: 'sms_csv', account, start, end, dst }`, validado con `parseSearch`, con el mismo tope de 15 días, o `{ kind: 'delivery_xlsx' | 'incoming_xlsx', account, delivery }`.

- La lectura de topes y duplicado, más la inserción, van dentro de `GET_LOCK('pages_export:<login>', 2)`, con `RELEASE_LOCK` en `finally`, por la misma conexión; sin candado, 503 `busy`.
- Duplicado: mismo login, cuenta, tipo y filtros, sin terminar y con menos de 12 h 15 min. 200 con el mismo job. Si no, 201.
- Topes, 429 `export_limit` con mensaje: 3 jobs sin terminar por login (uno en curso y dos en cola, porque el trabajador toma de a uno), y 10 en 24 horas. Solo cuentan como sin terminar los de menos de 12 h 15 min.
- Audita `export_create` con tipo, período, `con_numero` o `sin_numero` y `public_id` en `detail`, y registra `{ event: 'export_create' }` en consola.

**Lectura de jobs:** toda lectura por id es `WHERE public_id = ? AND id_login = ?`, con 404 si no hay fila, validando antes `^[0-9a-f]{32}$`. La lista y el estado no muestran jobs de cuentas donde el login ya no tenga membresía. Un job sin terminar con más de 12 h 15 min se muestra `failed` con el mensaje de `too_old`, en todas partes.

Item: `{ id, kind, account, accountName, filter, start, end, state, errorMessage, createdAt, filename }`. `account` es el id de la cuenta, como string. `filter` es el número, "Todos los números" o el nombre del envío. `state` es `generating`, `ready` o `failed`. `errorMessage` sale de una tabla de código a mensaje, nunca el código crudo.

**`GET /api/exports/download`**: revisa además la membresía de la cuenta, 403 si no. Sin terminar, 409 `not_ready`. Antes de auditar y firmar comprueba que el objeto exista, con `HeadObject`: si no está, 404 `not_found` con "El archivo ya no está disponible. Genera uno nuevo."; si S3 falla de otra forma, 503 `busy` y evento `request_failed`. El rol no puede listar el bucket, así que un 403 de S3 también se lee como ausente, aunque sea por credenciales. Audita `export_download` con tipo y `public_id`; **si ese `INSERT` falla, 503 sin URL**: la descarga es lo único que se lleva datos fuera, y este registro es la señal de una filtración.

**Cursor:** AES-256-GCM del id, en 8 bytes, con IV al azar de 12 bytes, clave derivada de `token_secret` con HKDF-SHA256, y una etiqueta de ruta como dato autenticado: `sms:<cuenta>`, `deliveries:<cuenta>`, `messages:<cuenta>:<envío>`, `exports:<login>`. La lista de envíos suma `created_at`. Una sola escritura por cursor: se compara contra la recodificación. Viaja cifrado porque el id de
`sms_outgoing` es un autoincremental compartido por todas las cuentas, y restando dos un cliente estimaría el volumen de toda la plataforma.

**Formatos:** fechas de la plataforma `dd/mm/aaaa HH:MM`, en texto. `dst` va como string. `null` se muestra como "—" en el front.

Otros errores: 500 `internal`; 503 `busy`, con "El servicio está ocupado. Inténtalo de nuevo en unos minutos."; 504 `timeout`, con "La consulta tardó demasiado. Acota las fechas o indica un número." en `GET /api/sms` y "Inténtalo de nuevo" en las demás.

### Foto de conteos

La avanza la pantalla, sin trabajador: `GET /api/delivery/stats` adelanta **un tramo por petición**, solo si alguien está mirando. Así una exportación no la bloquea, y nadie gasta base por un envío que nadie abrió. Cada Lambda de la app puede correr un tramo, así que hay hasta 5 sentencias de hasta 8 s a la vez.

1. Resuelve el envío por la vista. Lee `delivery_stats`; si no hay fila, `INSERT IGNORE` y relee.
2. **Vigencia.** `base` es el mayor entre `deliver_at` y el `created_at` de la última fila. La foto está vencida si `counted_at` es nulo, o según la edad de `base`: futura, nula o de menos de 4 días, foto de más de 10 minutos; de 4 a 15 días, foto de más de 6 horas; más de 15 días, si `counted_at < base + 16 días`, y si no, es fija. Tras un fallo, no se recalcula por 10 minutos.
3. **Reclamo.** Si está vencida, y la petición lleva menos de 8 s desde el inicio del handler, un `UPDATE` atómico sobre `next_step_at`. Con `affectedRows` 1, relee la fila y corre un tramo; con 0, otro lo tiene, y responde el avance sin trabajar. Un trabajo sigue siendo de quien lo tomó, salvo que lleve 10 minutos sin moverse.
4. **Fase `counts`:** tramos de `work_step` (5000) filas, con el límite por índice y el `GROUP BY status, dst_provider, dst_country` en `sms_de_envio`. Suma en Node sobre `work_counts`.
5. **Fase `links`:** solo si el envío tiene `link_de_envio`. Tramos de 2000 sobre `link_de_sms`. Si el primero no trae ninguno, se acaba y queda el link del envío: es una diferencia aceptada, para un envío cuyos primeros 2000 SMS no tengan link y los siguientes sí. Clics: `clicks_sum` si es mayor que 0; si no, `clicks` de `link_de_envio`.
6. Cada tramo escribe todos los campos `work_*` juntos, con `WHERE id_delivery = ? AND work_last_id = ? AND work_started_at = ?`, para descartar a un escritor tardío. Si no terminó, el siguiente tramo espera `max(1000 ms, 3 × lo que tardó este)`.
7. **Publicar:** copia el trabajo a `counts` y `links_*`, con `counted_at = work_started_at`.
8. Con 3024, 1028 o 1317, `work_step` baja a la mitad, hasta 500. Bajo eso, `failed_at` y se reinicia el trabajo, sin borrar la foto anterior.

Respuesta: `{ state: 'ready' | 'computing' | 'failed', updatedAt, progressRows, retryAfterMs, national, international, chart, links }`. Mientras recalcula, entrega la foto anterior si hay.

Tablas, armadas y ordenadas en Node, porque 8.x no ordena el `GROUP BY`:

- Categorías, por `includes` sobre `status`, en este orden: `NEW`, `QUEUED`, `ESME_RI` Número inválido, `SENT_TO_ESME`, `ESME_ROK`, `UNDELIV`, `OUTBALANCE`, `DELIVRD`. Nulo o cualquier otro: "Otros estados".
- `international`: `dst_country` no nulo y distinto de `Chile`. Columnas Perú, Colombia, México, Brasil, Argentina, Otros, Total.
- `national`: el resto. Columnas Movistar, Entel, Claro, Wom, VTR, Virgin, Otros, Total.
- Filas y columnas suman el total. `chart`: las 8 categorías con sus colores, más "Otros estados" si es mayor que 0.

### Trabajador

`src/worker/`, función `worker`: `reservedConcurrency: 1`, `timeout: 900`, `memorySize: 512`, `rate(1 minute)`, `maximumEventAge: 60`, `maximumRetryAttempts: 0`. Rol propio: `ssm:GetParameters` solo sobre sus cuatro parámetros; S3 solo `PutObject`, `GetObject`, `AbortMultipartUpload`, `ListMultipartUploadParts` sobre `exports/*`; registros.

El handler captura todo: registra solo `errorCode`, y para disparar `Errors` lanza `new Error(codigo)`. El SDK usa `connectionTimeout` de 5 s y `requestTimeout` de 120 s. Cada sentencia corre en carrera con 30 s, y al vencer se destruye el pool y termina la corrida. Caché de nombres, búfer y CRC se crean por job, nunca a nivel de módulo.

Un job se elige por antigüedad: uno grande demora a los siguientes, a propósito. Por corrida, hasta que queden menos de 60 s:

1. `worker_quiet_windows`: ventanas en que el trabajador no lee la base, con forma `HH:MM-HH:MM,...` en hora de Chile, un prefijo `d<N>:` para el día N del mes, o `none`. Una ventana puede cruzar la medianoche. Ausente o malformado, no lee y lanza error. Se relee en cada corrida y se revisa antes de cada lote; al entrar en ventana, sale sin contar `stalls`. **El valor es privado**, y las pruebas usan valores inventados.
2. Cada hora a lo sumo: borra `export_job` de más de 7 días, `delivery_stats` sin actualizar hace más de 30 días (`LIMIT 200`), y llama a `purge_audit_log()`.
3. Toma el job más viejo sin terminar y suma 1 a `stalls`. Con `stalls >= 5`, `failed` con `stalled`. Más de 12 h desde `created_at`, `too_old`. `work_ms` sobre 2 h, `too_long`. **`stalls` cuenta solo muertes:** al salir por su propia guarda, una ventana o un fallo pasajero conocido (ver el paso 8), resta lo que sumó, y cerrar una parte lo deja en 0. `work_ms` cuenta solo lectura y escritura, sin pausas.
4. Primera vez, `upload_id` nulo: fija `lo` y `hi`, crea la carga en partes, y guarda todo en un solo `UPDATE`. El XLSX también fija `hi`, en la última fila del envío, para que la exportación no persiga un envío que sigue creciendo.
5. Lotes de `batch_size` (hasta 2000), por `id` ascendente y **sin transacción**. Sin número: límite solo por índice y datos sin `LIMIT`. Con número o en XLSX: un solo paso con `LIMIT`, por keyset.
6. Pausa de `max(250 ms, 3 × el lote)`; si el lote tardó más de 5 s, 60 s. Si en esta corrida no se ha cerrado ninguna parte y lleva más de 6 minutos, la pausa es 1 × el lote, para no perder lo leído.
7. Con 3024, 1028 o 1317, el lote baja a la mitad, hasta 500. `batch_size` se guarda al cambiar, y se duplica hasta 2000 al cerrar cada parte. Un corte en lote 500 termina la corrida sin abortar, y cuenta como `stalls`.
8. **Lista cerrada de `failed` inmediato:** `too_many_rows` (1.000.000 de filas), `too_large`, `too_old`, `too_long`, `stalled`, `inconsistent`, `schema_error` y `storage_denied`. **Todo lo demás termina la corrida sin abortar.** Al fallar, aborta la carga y registra `export_failed` con el código, nunca datos.
   - **Pasajeros conocidos, que no cuentan en `stalls`:** `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, `ENOTFOUND`, `EAI_AGAIN`, `PROTOCOL_CONNECTION_LOST`, 1040, 1053, 1205, 1213, 4031, `SlowDown`, `TimeoutError`, `RequestTimeout`, `ServiceUnavailable`, `InternalError` y cualquier respuesta 5xx de S3.
   - **Lo demás cuenta como una muerte,** para que un error determinista no bloquee la cola hasta `too_old`: el job termina en `stalled` al sexto reclamo y el siguiente avanza en esa misma corrida. Un corte al fijar `lo` y `hi` también queda contado, porque no pasa por el manejo de lotes: unos 5 minutos de base saturada al inicio de un job lo dejan en `stalled`. Se acepta.
9. **`last_id` solo avanza al cerrar una parte.** Una parte mide al menos 5 MiB en bytes finales, salvo la última. Al cerrarla guarda en un solo `UPDATE` `last_id`, `rows_written`, `next_part`, `plain_bytes`, `file_bytes`, `crc32`, `batch_size`, `work_ms` y `stalls = 0`. Si muere, la próxima corrida relee desde el último cierre, con el mismo número de parte, que S3 sobrescribe.
10. Cierre por guarda: cerca del límite de la corrida, el XLSX cierra la parte rellenando con bloques vacíos `00 00 00 FF FF` hasta 5 MiB, para no perder lo leído. El CSV no puede, y descarta lo no cerrado.
11. Completar: `ListParts`, y se completa **solo con las partes 1..N**, N = `next_part - 1`. Exige que estén contiguas y que la suma de tamaños sea `file_bytes`; si no, `inconsistent`. Una parte N+1 sobrante se descarta. Con `MpuObjectSize: file_bytes`. Luego `finished`, y `export_finished` en `audit_log` con `public_id` y filas.
12. `NoSuchUpload` con `upload_id` guardado: `HeadObject`. Si el tamaño es `file_bytes`, `finished`; si no, `inconsistent`.

Una exportación grande puede tardar unos 40 minutos, más si la base está lenta.

### Formatos de archivo

**CSV (`sms_csv`):** UTF-8 con BOM solo en la primera parte, `;`, LF. Comillas si el campo tiene `;`, `"`, LF o CR. Columnas: `Identificador único; Cuenta; Envío; Número origen; Número destino; Mensaje; Estado; Proveedor; Fecha`. `Estado` crudo. `Fecha` `dd/mm/aaaa HH:MM:SS`. Cabecera aunque no haya filas. Nombre `sms_<desde>_<hasta>.csv`.

Las hojas de cálculo evalúan texto como fórmula, así que los campos de texto se neutralizan con `'`, lo que en casos raros altera el texto:

- Al inicio, si empieza con `=`, `+`, `-`, `@`, tabulador, CR, LF, `＝`, `＋`, `－` o `＠`.
- Dentro, después de `,`, tabulador, CR o LF, si sigue `=`, `@`, `＝`, `＠`, o `+`, `-`, `＋`, `－` seguido de un carácter que no sea espacio. Así `$10.000,-` queda intacto, y `hola,=1+1` no se evalúa aunque se lea con otro separador.

**XLSX:** escritor propio en `src/worker/xlsx.js`, sobre `node:zlib`. ZIP con entradas fijas pequeñas y `xl/worksheets/sheet1.xml` en flujo, con bit 3 y descriptor de datos. Comprime por lote con `deflateRawSync(..., { finishFlush: Z_FULL_FLUSH })`, que deja un corte alineado y se puede reanudar en otra invocación. Falla con `too_large` si el contenido llega a 4 GiB, porque no hay ZIP64.

Celdas `t="inlineStr"` con `xml:space="preserve"`, que no se evalúan y no necesitan neutralizar. Se quita lo que no calce con los caracteres válidos de XML 1.0, se escapa `&`, `<`, `>`, `_xHHHH_` pasa a `_x005F_xHHHH_`, y se trunca a 32.767 unidades UTF-16 sin cortar un par sustituto.

- `delivery_xlsx`, hoja `Detalle`: `Identificador único, Número de origen, Número de destino, Contenido mensaje, Multiplicador, País de destino, Proveedor de destino, Fecha y Hora, Fecha y hora de entrega, Estado, Nombre de envío`. `Reporte_de_envío_<dd-mm-aaaa>_<8 hex>.xlsx`.
- `incoming_xlsx`, hoja `Respuestas`: `Identificador, Número de origen, Número destino, Contenido, Creación, Envío`. `Respuestas_de_envío_<dd-mm-aaaa>_<8 hex>.xlsx`. Son datos personales de terceros.

### Almacén y descarga

Bucket S3 propio: nombre generado por CloudFormation, pasado como `EXPORTS_BUCKET`; `BlockPublicAccess` completo; `BucketOwnerEnforced`; AES256; política que niega sin TLS; ciclo de vida que expira `exports/` a los 7 días y aborta cargas incompletas al día. Clave `exports/<public_id>`. Guarda SMS completos, y es un almacén más de datos personales.

La descarga se firma con SigV4 propio en `src/presign.js`, sobre `node:crypto`, porque no consta que el presigner venga en el runtime. Codificación RFC 3986 estricta. Credenciales de las variables de Lambda, incluida `AWS_SESSION_TOKEN`. Vigencia 300 s. Parámetros firmados: `response-content-disposition`, con `filename` ASCII y `filename*` UTF-8, y `response-cache-control=private, no-store`.

El front pide la URL y hace clic en un `<a>`, sin iframe oculto. **La URL prefirmada no se muestra nunca.** Vale con los permisos de quien la firma, y mientras viva sirve a cualquiera que la tenga.

En local, `src/storage.js` usa un almacén en disco bajo `TMPDIR`, y `scripts/dev.js` corre el trabajador en el mismo proceso.

### Clave y token

- Hash: `crypto.scrypt`, N=2^15, r=8, p=1, 32 bytes, sal de 16 bytes, formato `scrypt$32768$8$1$<sal_b64>$<hash_b64>`. Comparación con `timingSafeEqual`. `maxmem` de 64 MB.
- Token: formato JWT con HMAC-SHA256, sobre `node:crypto`. Cabecera fija `{"alg":"HS256","typ":"JWT"}`, que se exige byte a byte. Payload `{ "iss": "connectus_pages", "sub": <id de login>, "ver": <token_version>, "iat": n, "exp": n }`, con 1 hora de vigencia. No se acepta otro `alg`, otro `iss`, un `sub` que no sea entero positivo, un `ver` que no sea entero mayor o igual a 0 ni un token vencido.
- En cada petición se relee el login: si no existe, está inactivo o su `token_version` ya no es la del token, 401 `unauthorized`. Por eso revocar un acceso con `active = 0` o cambiar la clave tiene efecto inmediato.
- Sin OTP ni captcha. Con exportación masiva, esta es la barrera que hay; ver "Qué protege y qué no".

### Cabeceras de seguridad

En todas las respuestas:

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'[; frame-ancestors <lista o 'none'>]
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Robots-Tag: noindex
```

Nunca `X-Frame-Options`. En `/api/*`, además, `Cache-Control: no-store`. Cada elemento de `frame_ancestors` debe calzar con `^https://[a-z0-9.-]+(:[0-9]{1,5})?$`; en `STAGE=local` también se acepta `http://` a localhost o 127.0.0.1. Un elemento que no calza se descarta y se registra. Si no queda ninguno, `'none'`.

### Registro y retención

`audit_log`, **nunca con el número ni el contenido**:

| Acción | Cuándo | `detail` |
| --- | --- | --- |
| `login_ok` | Entró | `enlace <ranura> v<versión> vence <fecha>` |
| `login_fail` | Falló | Vacío, `enlace_revocado` o `usuario_no_coincide` |
| `forbidden` | Pidió una cuenta ajena | Vacío, o `cuenta_fuera_de_rango` |
| `search` | Búsqueda | `<desde>..<hasta> con_numero` o `sin_numero` |
| `sms_view`, `delivery_view` | Abrió un detalle | `id_unique` |
| `delivery_search` | Buscó un número en un envío | `<id_unique> con_numero` |
| `export_create` | Pidió un archivo | Tipo, período, `con_numero` o `sin_numero`, `public_id` |
| `export_download` | Pidió la URL | Tipo y `public_id` |
| `export_finished` | Terminó un archivo | `public_id` y filas |

Si la inserción falla, se registra el código y la petición sigue, salvo en `export_download`.

Consola: solo eventos y códigos. Nunca claves, tokens, enlaces, números, contenido de SMS ni parámetros de SQL. Eventos: `link_rejected`, `link_suspect`, `login_floor_exceeded`, `frame_ancestors_open`, `frame_ancestors_invalid`, `request_failed`, `request_cut`, `bad_text`, `schema_error`, `handler_failed`, `request_deadline_exceeded`, `session_setup_failed`, `audit_insert_failed`, `app_close_failed`, `export_create`, `export_failed`, `abort_failed`, `cleanup_failed`, `worker_failed`, `worker_close_failed`.

Retención:

| Dato | Cuánto |
| --- | --- |
| `audit_log` | 1 año. Se borran hasta 1000 filas por hora |
| Archivos en S3, y `export_job` | 7 días |
| Cargas incompletas en S3 | 1 día |
| `delivery_stats` | 30 días sin actualizarse |
| Registros de Lambda | 30 días; los de la sonda, 7 |
| Muestras del WAF | 3 horas |

### Reglas de operación

- **Data tracing de API Gateway está prohibido en esta API.** Registraría el cuerpo de `POST /api/login`, con el enlace y la clave.
- **Si se activa el registro del WAF, hay que redactar `args`**, porque ahí queda la query.
- **El número viaja en la query de `GET /api/sms` y `GET /api/delivery/messages`.** La app no lo registra, pero queda en cualquier registro de acceso de API Gateway o del WAF que se active, y en un proxy corporativo con inspección TLS. Quien active uno decide con esto a la vista.
- Las muestras del WAF incluyen cabeceras, también `Authorization`, por 3 horas, para quien tenga `wafv2:GetSampledRequests`. Si esos roles no deben ver sesiones, hay que excluirla con data protection.
- `serverless package` no es de solo lectura: con credenciales reales consulta AWS y crea el bucket de despliegue por defecto si no existe.

## Front

`public/index.html`, `public/app.js` y `public/app.css`. Un solo IIFE, para que el token quede en la clausura. JS sin dependencias ni CDN, sin scripts ni estilos en línea ni atributos `style`. Todo el contenido dinámico se pinta con `textContent`. Solo texto, sin logos ni banderas. Solo modo claro, con `color-scheme: light` y fondo explícito. Sin rutas en la URL, porque el fragmento lleva el enlace: la navegación es una pila en memoria con botón "Volver".

- **Arranque:** el estado inicial de `index.html` es un aviso estático y neutro, con el login oculto. `app.js` los cambia al terminar de arrancar: si API Gateway rechaza ese archivo, el login no queda a la vista sin hacer nada. El CSS solo muestra el aviso a los 3 s.
- **Enlace:** fragmento `#e=` primero, `?e=` de respaldo, y no se borra de la URL. Sin enlace o con forma inválida, "Esta consulta se abre desde el enlace que te entregó Connectus.", sin formulario. Vencido, "El enlace venció el dd/mm/aaaa. Pide uno nuevo a tu contacto de Connectus.", sin formulario. Desde 30 días antes, formulario y aviso. La fecha sale del propio enlace, y quien decide es el servidor: al recibir `invalid_link` se oculta el formulario.
- **Login:** el foco inicial va solo fuera de un iframe, porque embebida le quitaría el foco a la página que la contiene. La contraseña se borra del campo al enviar.
- **Barra:** selector de cuenta (texto si hay una sola), menú "Consulta de SMS" y "Envíos SMS", "Salir". Cambiar de cuenta vuelve a Consulta con los filtros limpios.
- **Consulta:** "Número destino" opcional, "Desde" y "Hasta" (por defecto, los últimos 15 días, en `America/Santiago`), tabla Fecha, Número destino, Mensaje, Estado, Envío, con el envío como enlace a su detalle cuando hay `deliveryId`. "Exportar resultados", tarjeta "Reporte completo" con "Generar CSV", y "Exportaciones recientes" (Cuenta, Filtro, Período, Estado, Archivo), con botón "Actualizar". Esa lista pide `kind=sms_csv`: los reportes de un envío se ven en su detalle.
- **Envíos:** "Historial de envíos SMS", buscador, tabla Nombre, Tipo, Creado, Envío y lupa.
- **Detalle de envío:** 3 variantes, con barra `<progress>` en la que está en curso. Tarjetas "Detalles" (pestañas en el cliente, sin pedir nada), "Mensajes del envío", "Datos del envío", "Entregas" (dona SVG propia), "Respuestas" y "Link corto" o "Links cortos". "Generar reporte" pasa a "Generando" y a "Descargar reporte", y muestra el fallo. Al volver al detalle, retoma con `report` e `incoming`. Con uno listo, en el reporte y en las respuestas, se ve "Generado el dd/mm/aaaa a las HH:MM" y un botón "Generar de nuevo", que hace el mismo pedido.
- **Detalle de SMS:** datos del mensaje, su contenido y los mensajes equivalentes.
- **Consultas repetidas,** con la misma regla en exportaciones, reporte y envío en curso: mínimo 5 s, ×1,5 hasta 30 s, pausa con la pestaña oculta, tope de 60. La foto es distinta: mientras suba `progressRows`, cada `max(5 s, retryAfterMs)`, sin espera creciente y sin gastar el tope, que cuenta solo respuestas sin avance. Al llegar a un tope, "Sigue calculando" o "Sigue generando" y botón "Actualizar". Una respuesta vieja nunca pisa a la vigente. Al salir de la pantalla se cancelan. En la foto, un fallo muestra "Reintentando…", y el tercero seguido muestra el error con "Actualizar" y deja de consultar; "Sigue calculando" sale solo si la última respuesta fue un 200 que sigue calculando. Mientras calcula, "Calculando: N filas procesadas.", porque el contador también sube en la fase de links.
- **Encolar un CSV:** el resultado se pinta aunque se haya salido de Consulta, y solo se descarta al cambiar de cuenta o de sesión. La lista se pide de nuevo si Consulta está a la vista; si no, al volver.
- **Descarga:** donde hay un archivo listo se ve desde antes del clic "Si la descarga falla, esta página puede cerrarse y tendrás que volver a ingresar tu clave."
- **Salida al navegador:** tras cada intento de descarga, "¿No se descargó? Abre esta consulta en tu navegador." con un botón "Mostrar enlace". Solo al pulsarlo aparece un campo de solo lectura con la URL de la app, enlace incluido, para que una captura no lo revele. El navegador la dejará en su historial.
- **Sesión:** un 401 borra todo y vuelve al login. Un 403 saca la cuenta: si es la que está en uso, vuelve a Consulta con los filtros limpios; si es otra, se queda en la cuenta, los filtros y los resultados actuales, y recarga las exportaciones. "Salir" borra el token y los datos.
- Debe verse bien en un marco angosto: sin scroll horizontal de página a 360 px; las tablas hacen scroll dentro de su contenedor.

## Despliegue

`serverless.yml`: `service: connectus-pages`, framework v4, `runtime: nodejs22.x`, `us-west-2`, `logRetentionInDays: 30`, `STAGE: prod`. Función `app`: `memorySize: 256`, `timeout: 25`, `reservedConcurrency: 5`, eventos `http` (REST regional) `/` y `/{proxy+}`. Función `worker`: ver "Trabajador". Dominio con `serverless-domain-manager`, con `createRoute53Record: true`. El paquete incluye `src/**`, `public/**` y `node_modules/**`, y nada más: ni `sonda/`, `test/`, `docs/`, `sql/` ni `scripts/`.

El `timeout` supera los 12 s de consultas de una búsqueda más el arranque en frío, con el margen del plazo por petición, para que la app alcance a responder su 504 o su 503, y queda bajo los 29 s de API Gateway.

Límites antes de la base:

- WAF regional, asociado a la etapa, con dos reglas rate-based por IP que al pasarse responden 429 `too_many_requests`:
  - `login-por-ip`, prioridad 0: `POST` a rutas que terminan en `/api/login`, 30 peticiones cada 5 minutos. Termina en esa ruta, y no es exacta, porque el endpoint por defecto de API Gateway antepone la etapa. Si un BI recarga seguido, cada recarga pide la clave y gasta este cupo, compartido por toda una oficina detrás de una IP.
  - `general-por-ip`, prioridad 1: todas las rutas, 1500 peticiones cada 5 minutos. Sin ella, una sola IP con `GET /app.js` agotaría el throttling de la etapa, que no distingue clientes.
- Throttling de la etapa `prod`: 20 peticiones por segundo, ráfaga de 40 (`custom.stageThrottling`). El framework no tiene opción para esto, y la etapa la crea un `Deployment` de id lógico cambiante, así que lo aplica `scripts/throttling_etapa.js`, un plugin local, con `updateStage` después de cada `serverless deploy`. Va antes de `serverless-domain-manager` en `plugins:`: los hooks corren en serie y se detienen en el primer error, y al revés, si el dominio fallara, la etapa quedaría sin throttling.

Alarmas, con acción en un SNS cuyo ARN llega por `${env:PAGES_ALARM_TOPIC_ARN}`:

| Alarma | Qué mira |
| --- | --- |
| `connectus-pages-worker-errors` | `Errors` del trabajador |
| `connectus-pages-worker-invocations` | `Invocations < 1` en 20 minutos (`Period` 1200, 1 evaluación), con datos faltantes como alarma: un trabajador detenido no registra nada. Con menos, la dispara cualquier exportación larga, porque una corrida dura hasta 15 minutos y las invocaciones que llegan mientras tanto no cuentan. Un trabajador detenido se detecta en hasta unos 40 minutos |
| `connectus-pages-app-failures` | Filtro sobre `request_failed` (los 503 y los 500 que no son de esquema), `handler_failed` y `request_deadline_exceeded`. `request_cut` y `bad_text` no la disparan: son respuestas previstas. `Errors` de la app no ve casi nada, porque el handler captura todo |
| `connectus-pages-export-failed` | Filtro sobre `export_failed`, excluyendo `too_many_rows` |
| `connectus-pages-schema-error` | Filtro sobre `schema_error`, en las dos funciones |
| `connectus-pages-link-suspect` | Filtro sobre `link_suspect`, cualquiera |
| `connectus-pages-exports-unusual` | Más de 20 `export_create` en 1 hora, en total |

Los filtros buscan por palabra y no con un patrón JSON, porque los eventos van en texto después de la marca del runtime.

### Despliegue limpio, en orden

1. `npm ci`.
2. **Sonda**, si no se conoce el producto que va a embeber: ver "Sonda". Su resultado fija `frame_ancestors` y `cors_opaque`.
3. **Certificado** de ACM emitido en `us-west-2`, la región de la API, porque el dominio es regional. Un tema SNS para las alarmas. Y estas variables exportadas, que `serverless` resuelve en los dos últimos pasos:

   ```sh
   export PAGES_DOMAIN_NAME=<host>
   export PAGES_CERTIFICATE_ARN=<arn del certificado>
   export PAGES_ALARM_TOPIC_ARN=<arn del tema SNS>
   ```

4. **Parámetros,** todos bajo `/connectus-pages/prod/`, con los nombres exactos de la tabla de "Configuración". Aquí van todos menos las dos claves que genera el paso siguiente. Los secretos, con `SecureString` y desde un archivo, para que no queden en argv ni en el historial:

   ```sh
   secreto=$(mktemp)
   openssl rand -hex 32 | tr -d '\n' > "$secreto"
   aws ssm put-parameter --name /connectus-pages/prod/token_secret --type SecureString --value "file://$secreto"
   openssl rand -hex 32 | tr -d '\n' > "$secreto"
   aws ssm put-parameter --name /connectus-pages/prod/link_secret_a --type SecureString --value "file://$secreto"
   rm "$secreto"

   aws ssm put-parameter --name /connectus-pages/prod/db_host --type String --value <endpoint>
   aws ssm put-parameter --name /connectus-pages/prod/db_user --type String --value pages_app
   aws ssm put-parameter --name /connectus-pages/prod/worker_db_user --type String --value pages_worker
   aws ssm put-parameter --name /connectus-pages/prod/worker_quiet_windows --type String --value <ventanas o none>
   aws ssm put-parameter --name /connectus-pages/prod/frame_ancestors --type String --value <lista o sin-restriccion>
   aws ssm put-parameter --name /connectus-pages/prod/cors_opaque --type String --value on   # solo si la sonda lo pide
   ```

   `link_secret_b` no se sube hasta una rotación.
5. **Aprovisionar la base,** que crea las tres cuentas con claves generadas y deja las de `pages_app` y `pages_worker` en `OUT_ENV`, un archivo nuevo, 0600 y fuera del repo. Después se suben esas dos claves, los últimos parámetros obligatorios: sin ellas, ni la app ni el trabajador arrancan.

   ```sh
   salida=$(mktemp -u)
   MYSQL_ADMIN_ARGS='-u <master> -p' \
     MYSQL_HOST_ARGS='-h <endpoint> -P 3306 --ssl-mode=VERIFY_IDENTITY --ssl-ca=<ca.pem>' \
     OUT_ENV="$salida" scripts/aprovisionar_bd.sh

   secreto=$(mktemp)
   sed -n 's/^DB_PASSWORD=//p' "$salida" | tr -d '\n' > "$secreto"
   aws ssm put-parameter --name /connectus-pages/prod/db_password --type SecureString --value "file://$secreto"
   sed -n 's/^WORKER_DB_PASSWORD=//p' "$salida" | tr -d '\n' > "$secreto"
   aws ssm put-parameter --name /connectus-pages/prod/worker_db_password --type SecureString --value "file://$secreto"
   rm "$secreto" "$salida"
   ```

   Si falla a mitad de camino, la vuelta atrás está en la cabecera del script.
6. **Cuentas:** ampliar `allowed_account`, revisando antes de quién es cada cuenta (ver "Logins y cuentas"). En una base limpia está vacía. La lista va en el runbook privado.
7. **Logins:** `scripts/crear_login.js`, uno por cada conjunto de personas que comparten archivo.
8. **Enlace:** `scripts/crear_enlace.js`, uno por login (ver "Emisión y entrega").
9. **`serverless create_domain`**, solo la primera vez. Sin esto, `deploy` crea el stack y aplica el throttling, pero termina con error, sin mapeo ni registro en Route 53. No se usa `autoDomain`, porque `serverless remove` borraría también el dominio.
10. **`serverless deploy`.** Se aprueba antes, sabiendo que crea un bucket con SMS completos.

El enlace se puede emitir antes de desplegar, porque el script no toca la base ni la app, pero se entrega cuando la página ya responde.

### Después de desplegar

Todo cambio de un parámetro de la app exige reciclar sus contenedores, porque la configuración se lee una vez por contenedor. El procedimiento es cambiar algo de la configuración de la función:

```sh
aws lambda update-function-configuration --function-name connectus-pages-prod-app --description "config $(date -u +%FT%TZ)"
```

`serverless deploy` ya no se omite con este template, aunque el código no cambie, porque el `DependsOn` de la asociación del WAF lleva el id de instancia. Aun así no se usa para reciclar, porque ese efecto no está verificado.

**Apagar el trabajador,** en una emergencia, sin desplegar:

```sh
aws lambda put-function-concurrency --function-name connectus-pages-prod-worker --reserved-concurrent-executions 0
```

Para volver, el mismo comando con `1`. Lo mismo queda fijo poniendo `reservedConcurrency: 0` en `serverless.yml` y desplegando. Detenido, no lee nada y no gasta base: los jobs quedan generando, se muestran fallidos con `too_old` a las 12 h 15 min, y salta la alarma de invocaciones, que es lo esperado. Para detener solo las lecturas por un rato, sin alarma, basta una ventana en `worker_quiet_windows`, que rige desde la corrida siguiente.

## Pruebas

- `npm test`: unitarias con `node:test`, sin red ni base.
- `npm run test:integration`: `scripts/mysql_prueba.sh up` levanta un `mysqld` desechable con `--no-defaults`, datadir propio y puerto 33077 en 127.0.0.1, carga `test/fixtures/dbconnectus.sql` (solo las columnas e índices que usan las vistas, con los mismos tipos que la plataforma, y datos inventados) y corre el aprovisionamiento real. No toca el MySQL del puerto 3306 ni ninguna base remota. Corre **en serie** (`--test-concurrency=1`), porque todos los archivos comparten esa base.
- La suite debe pasar en `mysqld` 5.7.44 y 9.3.0: `PATH=/opt/homebrew/opt/mysql/bin:$PATH npm run test:integration` usa el segundo. Hay comportamientos, como el error 4031, que 5.7 no tiene. También debe pasar con `TZ=UTC`, porque nada puede depender de la zona del proceso.
- `test/integration/planes.test.js` comprueba el `key` de `EXPLAIN` de cada consulta en las dos versiones, y `Handler_read_*` para el costo de las más importantes.
- `test/integration/cortes.test.js` pone un proxy TCP delante de ese `mysqld`, para probar con el handler real lo que pasa si la red se queda callada o se corta justo después de un commit.
- `test/integration/export_files.test.js` abre los archivos con `python3 -I` (`csv`, `zipfile`, `openpyxl`), `unzip -t` y `soffice --headless`, si están instalados; si no, esas pruebas se saltan. Excel real no se prueba.
- `test/unit/presign.test.js` compara la firma con un vector congelado del SDK y con el ejemplo publicado por AWS.

Lo que estas pruebas no ven: el producto que embebe (para eso está la sonda), los filtros de métrica contra AWS, y el comportamiento en la base real.
