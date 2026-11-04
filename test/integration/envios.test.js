'use strict';

// Las rutas de envíos y detalle contra el mysqld desechable, con pages_app y sus permisos de verdad. Requiere scripts/mysql_prueba.sh up.

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const { restEvent, startEnvironment, uniqueOf } = require('./support/envios_env');

const ACCOUNT = '101';
// Ver la cabecera del fixture. La hora fija queda 2 horas después de los envíos 9, 10 y 11.
const NOW = '2026-11-20T15:00:00Z';
const ROUTES = ['/api/sms/detail', '/api/deliveries', '/api/delivery', '/api/delivery/progress', '/api/delivery/stats', '/api/delivery/messages'];
const FORBIDDEN_FOR_101 = [4, 5, 6, 7];
const OTHER_PRODUCT = 12;
const MEMBER_ID = /^[0-9a-f]{32}$/;
const NOT_FOUND = { error: 'not_found', message: 'Envío no encontrado.' };

// Filas propias, por encima de las del fixture, para no mover lo que miden otras pruebas que corren a la vez.
const TEMP_LIST = 70000;
const TEMP_DELIVERIES = 70100;
const TEMP_CONTACTS = 70000;

describe('rutas de envíos', () => {
  let environment;
  let admin;
  let handler;
  let token;

  function call(path, params, using = handler, usingToken = token) {
    return using(restEvent(path, usingToken, params));
  }

  async function ok(path, params, using, usingToken) {
    const response = await call(path, params, using, usingToken);
    assert.equal(response.statusCode, 200, response.body);
    return JSON.parse(response.body);
  }

  async function audits() {
    const [rows] = await admin.query(
      'SELECT action, id_account, detail FROM connectus_pages.audit_log WHERE id_login = ? ORDER BY id',
      [environment.loginId]
    );
    return rows;
  }

  async function lastAudit() {
    return (await audits()).at(-1);
  }

  async function insertDelivery(id, fields) {
    const row = {
      id,
      id_unique: `temporal${id}`,
      id_account: 101,
      delivery_type: 'CUSTOM',
      name: `Temporal ${id}`,
      deliver_at: '2026-11-20 10:00:00',
      created_at: '2020-01-01 00:00:00',
      id_product: 1,
      status: 'completed',
      ...fields,
    };
    await admin.query('INSERT INTO dbconnectus.delivery SET ?', [row]);
    return row.id_unique;
  }

  async function cleanUp() {
    await admin.query('DELETE FROM dbconnectus.delivery WHERE id >= ?', [TEMP_LIST]);
    await admin.query('DELETE FROM dbconnectus.contact_list WHERE id >= ?', [TEMP_CONTACTS]);
  }

  before(async () => {
    environment = await startEnvironment('api_envios', [101]);
    admin = environment.admin;
    handler = environment.handlerAt(NOW);
    token = await environment.tokenAt(NOW);
    await cleanUp();
  });

  after(async () => {
    await cleanUp();
    await environment.stop();
  });

  describe('autorización', () => {
    for (const path of ROUTES) {
      it(`${path} exige token`, async () => {
        const response = await call(path, { account: ACCOUNT, id: uniqueOf(1) }, handler, null);
        assert.equal(response.statusCode, 401);
      });

      it(`${path} rechaza una cuenta ajena con 403 y auditoría`, async () => {
        const response = await call(path, { account: '102', id: uniqueOf(4) });
        assert.equal(response.statusCode, 403);
        assert.doesNotMatch(response.body, /Campaña|56900/);
        const last = await lastAudit();
        assert.deepEqual([last.action, Number(last.id_account)], ['forbidden', 102]);
      });

      it(`${path} rechaza un parámetro repetido`, async () => {
        const response = await handler({
          ...restEvent(path, token),
          multiValueQueryStringParameters: { account: ['101', '102'], id: [uniqueOf(1)] },
        });
        assert.equal(response.statusCode, 400);
      });
    }

    for (const path of ['/api/delivery', '/api/delivery/progress', '/api/delivery/stats', '/api/delivery/messages']) {
      for (const deliveryId of FORBIDDEN_FOR_101) {
        it(`${path}: el envío ${deliveryId}, de otra cuenta, responde 404`, async () => {
          const response = await call(path, { account: ACCOUNT, id: uniqueOf(deliveryId) });
          assert.equal(response.statusCode, 404);
          assert.deepEqual(JSON.parse(response.body), NOT_FOUND);
        });
      }

      it(`${path}: un envío de otro producto responde 404`, async () => {
        const response = await call(path, { account: ACCOUNT, id: uniqueOf(OTHER_PRODUCT) });
        assert.equal(response.statusCode, 404);
      });

      it(`${path}: uno inexistente responde 404`, async () => {
        const response = await call(path, { account: ACCOUNT, id: 'noexiste' });
        assert.deepEqual(JSON.parse(response.body), NOT_FOUND);
      });

      it(`${path}: valida la forma del identificador antes de consultar`, async () => {
        for (const id of ['😀', "a' OR 1=1", '%', 'a'.repeat(33), '']) {
          const response = await call(path, { account: ACCOUNT, id });
          assert.equal(response.statusCode, 400, id);
        }
      });
    }

    it('la fila mezclada no filtra datos: un SMS de otra cuenta en un envío propio no aparece', async () => {
      const [[{ id_unique: mixed }]] = await admin.query('SELECT id_unique FROM dbconnectus.sms_outgoing WHERE id = 9012');
      const response = await call('/api/sms/detail', { account: ACCOUNT, id: mixed });
      assert.equal(response.statusCode, 404);
    });

    it('un SMS de la cuenta que cita un envío ajeno no trae el nombre del envío', async () => {
      const [[{ id_unique: citing }]] = await admin.query('SELECT id_unique FROM dbconnectus.sms_outgoing WHERE id = 9002');
      const detail = await ok('/api/sms/detail', { account: ACCOUNT, id: citing });
      assert.equal(detail.delivery, null);
    });

    it('un SMS de una cuenta no permitida responde 404, aunque el envío citado sea propio', async () => {
      const [[{ id_unique: foreign }]] = await admin.query('SELECT id_unique FROM dbconnectus.sms_outgoing WHERE id = 9011');
      assert.equal((await call('/api/sms/detail', { account: ACCOUNT, id: foreign })).statusCode, 404);
    });
  });

  describe('GET /api/sms/detail', () => {
    it('trae el detalle, sin el id de la tabla, y audita sms_view sin número ni contenido', async () => {
      const [[row]] = await admin.query('SELECT * FROM dbconnectus.sms_outgoing WHERE id = 9000');
      const detail = await ok('/api/sms/detail', { account: ACCOUNT, id: row.id_unique });
      assert.deepEqual(Object.keys(detail).sort(), [
        'content', 'country', 'delivery', 'dst', 'equivalent', 'id', 'provider', 'src', 'status', 'updatedAt',
      ]);
      assert.equal(detail.id, row.id_unique);
      assert.equal(detail.delivery, 'Campaña de prueba 101-A');
      assert.equal(detail.src, String(row.src_number));
      assert.equal(detail.dst, '56900000002');
      assert.equal(detail.status, 'Entregado');
      assert.match(detail.updatedAt, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
      assert.equal(detail.content, 'Campaña con acentos: ¿qué tal, canción?');

      const last = await lastAudit();
      assert.deepEqual([last.action, Number(last.id_account), last.detail], ['sms_view', 101, row.id_unique]);
    });

    it('equivalent es por bytes UTF-8, no por caracteres', async () => {
      const [[row]] = await admin.query('SELECT id_unique, sms_content FROM dbconnectus.sms_outgoing WHERE id = 9000');
      const detail = await ok('/api/sms/detail', { account: ACCOUNT, id: row.id_unique });
      assert.equal(detail.equivalent, Math.ceil(Buffer.byteLength(row.sms_content, 'utf8') / 160));
    });

    it('sin envío: delivery null, y proveedor nulo como Otros', async () => {
      const [[row]] = await admin.query('SELECT id_unique FROM dbconnectus.sms_outgoing WHERE id = 9004');
      const detail = await ok('/api/sms/detail', { account: ACCOUNT, id: row.id_unique });
      assert.equal(detail.delivery, null);
    });

    it('uno inexistente responde 404 y no audita', async () => {
      const before = (await audits()).length;
      const response = await call('/api/sms/detail', { account: ACCOUNT, id: 'noexiste' });
      assert.equal(response.statusCode, 404);
      assert.equal((await audits()).length, before);
    });

    it('un id con forma de número se busca como texto', async () => {
      assert.equal((await call('/api/sms/detail', { account: ACCOUNT, id: '12345' })).statusCode, 404);
    });
  });

  describe('GET /api/deliveries', () => {
    async function walk(params) {
      const items = [];
      let cursor;
      for (let page = 0; page < 200; page += 1) {
        const body = await ok('/api/deliveries', { account: ACCOUNT, ...params, ...(cursor ? { cursor } : {}) });
        assert.ok(body.items.length <= 10);
        items.push(...body.items);
        if (body.nextCursor === null) return items;
        assert.equal(body.items.length, 10);
        cursor = body.nextCursor;
      }
      throw new Error('demasiadas páginas');
    }

    // Lo que debe salir, en el orden en que debe salir. COUNT y orden salen de la base, como master.
    async function expected(where = '1 = 1', params = []) {
      const [rows] = await admin.query(
        `SELECT id_unique FROM dbconnectus.delivery WHERE id_account = 101 AND id_product = 1 AND created_at IS NOT NULL AND ${where} `
        + 'ORDER BY created_at DESC, id DESC',
        params
      );
      return rows.map((row) => row.id_unique);
    }

    it('recorre todos, del más nuevo al más viejo, sin nulos ni de otros productos', async () => {
      const items = await walk({});
      assert.deepEqual(items.map((item) => item.id), await expected());
      assert.ok(items.length >= 30);
      assert.ok(!items.some((item) => item.id === uniqueOf(OTHER_PRODUCT)));
      assert.ok(!items.some((item) => item.id === uniqueOf(14)), 'el de created_at nulo no aparece');
    });

    it('un item no lleva el id de la tabla', async () => {
      const [first] = (await ok('/api/deliveries', { account: ACCOUNT })).items;
      assert.deepEqual(Object.keys(first).sort(), ['createdAt', 'deliverAt', 'id', 'name', 'type']);
      assert.match(first.id, MEMBER_ID);
    });

    it('de a 3 con el mismo created_at no se pierde ni se repite ninguno entre páginas', async () => {
      const ids = (await walk({})).map((item) => item.id);
      assert.equal(new Set(ids).size, ids.length);
    });

    it('deliver_at nulo y fecha de creación en cero se muestran vacíos', async () => {
      const items = await walk({});
      assert.equal(items.find((item) => item.id === uniqueOf(13)).deliverAt, null);
      assert.equal(items.find((item) => item.id === uniqueOf(15)).createdAt, null);
    });

    it('el cursor admite la fecha en cero, también con más filas en cero después', async () => {
      const zeroRows = [];
      await admin.query("SET SESSION sql_mode = ''");
      try {
        for (let index = 0; index < 25; index += 1) {
          zeroRows.push(await insertDelivery(TEMP_LIST + index, { created_at: '0000-00-00 00:00:00', name: `En cero ${index}` }));
        }
      } finally {
        await admin.query('SET SESSION sql_mode = DEFAULT');
      }
      try {
        const items = await walk({ q: 'en cero' });
        assert.deepEqual(items.map((item) => item.id), [...zeroRows].reverse().concat(uniqueOf(15)), 'las temporales y la del fixture');
        assert.ok(items.every((item) => item.createdAt === null));
        assert.deepEqual((await walk({})).map((item) => item.id), await expected());
      } finally {
        await cleanUp();
      }
    });

    it('q no distingue mayúsculas ni acentos', async () => {
      const items = await walk({ q: 'CAMPANA de prueba' });
      assert.ok(items.some((item) => item.name === 'Campaña de prueba 101-A'));
    });

    it('% y _ en q son texto y no comodines', async () => {
      assert.deepEqual((await walk({ q: '100%' })).map((item) => item.id), [uniqueOf(20)]);
      assert.deepEqual((await walk({ q: '_especial_' })).map((item) => item.id), [uniqueOf(20)]);
      assert.deepEqual((await walk({ q: '%' })).map((item) => item.id), [uniqueOf(20)]);
      assert.deepEqual(await walk({ q: 'Promo_100' }), []);
      assert.deepEqual(await walk({ q: 'Prom%special' }), []);
      assert.deepEqual(await walk({ q: 'a!b' }), []);
    });

    it('q con emoji responde vacío, sin error', async () => {
      assert.deepEqual(await ok('/api/deliveries', { account: ACCOUNT, q: 'campaña 😀' }), { items: [], nextCursor: null });
    });

    it('q de hasta 100 caracteres: 101 responde 400', async () => {
      assert.deepEqual(await walk({ q: 'ñ'.repeat(100) }), []);
      assert.equal((await call('/api/deliveries', { account: ACCOUNT, q: 'ñ'.repeat(101) })).statusCode, 400);
    });

    it('q vacío o con solo espacios cuenta como no indicado', async () => {
      const all = await ok('/api/deliveries', { account: ACCOUNT });
      assert.deepEqual((await ok('/api/deliveries', { account: ACCOUNT, q: '   ' })).items, all.items);
    });

    it('un cursor de otra cuenta, de otra ruta o manipulado responde 400', async () => {
      const { nextCursor } = await ok('/api/deliveries', { account: ACCOUNT });
      const flipped = (nextCursor[0] === 'A' ? 'B' : 'A') + nextCursor.slice(1);
      for (const cursor of [flipped, '12345', '']) {
        assert.equal((await call('/api/deliveries', { account: ACCOUNT, cursor })).statusCode, 400);
      }
      const messages = await ok('/api/delivery/messages', { account: ACCOUNT, id: uniqueOf(1) });
      assert.equal((await call('/api/deliveries', { account: ACCOUNT, cursor: messages.nextCursor })).statusCode, 400);
    });
  });

  describe('GET /api/delivery', () => {
    const detailOf = (id, using, usingToken) => ok('/api/delivery', { account: ACCOUNT, id }, using, usingToken);

    it('complete: cabecera, respuestas y link, y audita delivery_view', async () => {
      const detail = await detailOf(uniqueOf(8));
      assert.equal(detail.variant, 'complete');
      assert.equal(detail.name, 'Envío chico con link único');
      assert.equal(detail.type, 'CUSTOM');
      assert.equal(detail.createdAt, '24/10/2026 08:55');
      assert.equal(detail.deliverAt, '24/10/2026 09:00');
      assert.equal(detail.base, 'Base de prueba 101');
      assert.equal(detail.responses, 3);
      assert.deepEqual(detail.link, { address: 'http://cnct.us/lnkuno1', clicks: 42 });
      assert.equal(detail.report, null);
      assert.equal(detail.incoming, null);
      assert.ok(!('errorMessage' in detail));

      const last = await lastAudit();
      assert.deepEqual([last.action, Number(last.id_account), last.detail], ['delivery_view', 101, uniqueOf(8)]);
    });

    it('generating: envío reciente en curso, con base', async () => {
      const detail = await detailOf(uniqueOf(9));
      assert.equal(detail.variant, 'generating');
      assert.equal(detail.contacts, 100);
      assert.ok(!('responses' in detail));
      assert.ok(!('link' in detail));
    });

    it('failed: con el motivo si es de negocio', async () => {
      const detail = await detailOf(uniqueOf(10));
      assert.equal(detail.variant, 'failed');
      assert.equal(detail.errorMessage, 'No hay saldo suficiente para el envío');
    });

    it('failed: el texto de una excepción no sale, y queda el mensaje genérico', async () => {
      const response = await call('/api/delivery', { account: ACCOUNT, id: uniqueOf(11) });
      assert.doesNotMatch(response.body, /detalle interno|Error al procesar/);
      assert.equal(JSON.parse(response.body).errorMessage, 'No quedó registrado el motivo.');
    });

    it('un envío de más de 1 día va al detalle completo, aunque figure en curso o fallido', async () => {
      // Chile en UTC-3: el envío se programó a las 13:00 UTC del 20.
      const later = '2026-11-21T13:00:01Z';
      const laterToken = await environment.tokenAt(later);
      for (const id of [9, 10]) {
        assert.equal((await detailOf(uniqueOf(id), environment.handlerAt(later), laterToken)).variant, 'complete');
      }
      const justBefore = '2026-11-21T12:59:00Z';
      const beforeToken = await environment.tokenAt(justBefore);
      assert.equal((await detailOf(uniqueOf(9), environment.handlerAt(justBefore), beforeToken)).variant, 'generating');
    });

    it('sin base no está en curso, aunque el estado diga new', async () => {
      const detail = await detailOf(await insertDeliveryOnce(TEMP_DELIVERIES, { status: 'new' }));
      assert.equal(detail.variant, 'complete');
    });

    async function insertDeliveryOnce(id, fields) {
      await admin.query('DELETE FROM dbconnectus.delivery WHERE id = ?', [id]);
      return insertDelivery(id, fields);
    }

    async function contactList(id, fields) {
      await admin.query('DELETE FROM dbconnectus.contact_list WHERE id = ?', [id]);
      await admin.query('INSERT INTO dbconnectus.contact_list SET ?', [{ id, id_account: 101, ...fields }]);
      return id;
    }

    it('deliver_at nulo, en curso y con base: generating sin error', async () => {
      const list = await contactList(TEMP_CONTACTS, { name: 'Base', number_of_contacts: 5 });
      const id = await insertDeliveryOnce(TEMP_DELIVERIES + 1, { status: 'processing', deliver_at: null, id_contact_list: list });
      const detail = await detailOf(id);
      assert.equal(detail.variant, 'generating');
      assert.equal(detail.deliverAt, null);
    });

    it('has_base con nombre y contactos nulos: sigue contando como que tiene base', async () => {
      const list = await contactList(TEMP_CONTACTS + 1, { name: null, number_of_contacts: null });
      const id = await insertDeliveryOnce(TEMP_DELIVERIES + 2, { status: 'new', id_contact_list: list });
      const detail = await detailOf(id);
      assert.equal(detail.variant, 'generating');
      assert.deepEqual([detail.hasBase, detail.base, detail.contacts], [true, null, null]);
    });

    it('number_of_contacts 0 se entrega tal cual, en el detalle y en el avance', async () => {
      const list = await contactList(TEMP_CONTACTS + 2, { name: 'Vacía', number_of_contacts: 0 });
      const id = await insertDeliveryOnce(TEMP_DELIVERIES + 3, { status: 'processing', id_contact_list: list });
      assert.equal((await detailOf(id)).contacts, 0);
      assert.deepEqual(await ok('/api/delivery/progress', { account: ACCOUNT, id }), { variant: 'generating', sent: 0, contacts: 0 });
    });

    it('una base de otra cuenta no se ve, y no cuenta como base', async () => {
      const detail = await detailOf(uniqueOf(19));
      assert.equal(detail.hasBase, false);
      assert.equal(detail.base, null);
      assert.equal(detail.contacts, null);
    });

    it('un estado nulo y las fechas nulas o en cero no rompen', async () => {
      assert.equal((await detailOf(uniqueOf(16))).variant, 'complete');
      assert.equal((await detailOf(uniqueOf(14))).createdAt, null);
      assert.equal((await detailOf(uniqueOf(15))).createdAt, null);
      assert.equal((await detailOf(uniqueOf(13))).deliverAt, null);
    });

    it('sin link: link null', async () => {
      assert.equal((await detailOf(uniqueOf(13))).link, null);
    });

    it('con un contenido HTML en el nombre, se entrega tal cual', async () => {
      assert.equal((await detailOf(uniqueOf(20))).name, 'Promo 100% _especial_ <b>ñandú</b>');
    });

    describe('report e incoming', () => {
      const job = async (fields) => {
        const row = {
          id_login: environment.loginId,
          id_account: 101,
          id_delivery: 8,
          kind: 'delivery_xlsx',
          state: 'new',
          created_at: '2026-11-20 14:00:00',
          ...fields,
        };
        await admin.query('INSERT INTO connectus_pages.export_job SET ?', [row]);
      };

      beforeEach(() => admin.query('DELETE FROM connectus_pages.export_job WHERE id_login = ?', [environment.loginId]));

      it('muestra el último de este login y de ese tipo, sin el id de la tabla', async () => {
        await job({ public_id: 'a'.repeat(32), state: 'failed', error_code: 'stalled', created_at: '2026-11-20 13:00:00' });
        await job({ public_id: 'b'.repeat(32), state: 'finished', created_at: '2026-11-20 02:30:00' });
        await job({ public_id: 'c'.repeat(32), kind: 'incoming_xlsx', state: 'processing' });
        const detail = await detailOf(uniqueOf(8));
        assert.deepEqual(detail.report, {
          id: 'b'.repeat(32),
          state: 'ready',
          filename: 'Reporte_de_envío_19-11-2026_bbbbbbbb.xlsx',
          errorMessage: null,
          createdAt: '19/11/2026 23:30',
        });
        assert.deepEqual(detail.incoming, { id: 'c'.repeat(32), state: 'generating', filename: null, errorMessage: null, createdAt: '20/11/2026 11:00' });
      });

      it('el de otro login o de otro envío no aparece', async () => {
        await job({ public_id: 'd'.repeat(32), id_login: environment.loginId + 100000 });
        await job({ public_id: 'e'.repeat(32), id_delivery: 13 });
        try {
          assert.equal((await detailOf(uniqueOf(8))).report, null);
        } finally {
          await admin.query('DELETE FROM connectus_pages.export_job WHERE id_login = ?', [environment.loginId + 100000]);
        }
      });

      it('uno sin terminar de más de 12 h 15 min se muestra failed, y el motivo no es el código crudo', async () => {
        await job({ public_id: 'f'.repeat(32), state: 'processing', created_at: '2026-11-20 02:44:00' });
        const { report } = await detailOf(uniqueOf(8));
        assert.equal(report.state, 'failed');
        assert.doesNotMatch(report.errorMessage, /too_old/);
      });

      it('uno terminado no pasa a failed por viejo', async () => {
        await job({ public_id: '1'.repeat(32), state: 'finished', created_at: '2026-11-15 02:44:00' });
        assert.equal((await detailOf(uniqueOf(8))).report.state, 'ready');
      });
    });
  });

  describe('GET /api/delivery/progress', () => {
    it('cuenta lo enviado del envío en curso, sin auditoría', async () => {
      const before = (await audits()).length;
      const [[{ n }]] = await admin.query('SELECT COUNT(*) AS n FROM dbconnectus.sms_outgoing WHERE id_delivery = 9');
      const body = await ok('/api/delivery/progress', { account: ACCOUNT, id: uniqueOf(9) });
      assert.deepEqual(body, { variant: 'generating', sent: Number(n), contacts: 100 });
      assert.equal(typeof body.sent, 'number');
      assert.equal((await audits()).length, before);
    });

    it('si ya no está en curso, no cuenta', async () => {
      assert.deepEqual(await ok('/api/delivery/progress', { account: ACCOUNT, id: uniqueOf(8) }), {
        variant: 'complete',
        sent: null,
        contacts: 9000,
      });
    });

    it('si el conteo se corta, sent queda null', async () => {
      const { db } = environment;
      const cutting = {
        ...db,
        query: (sql, params) => (/sms_ids_de_envio/.test(sql)
          ? Promise.reject(Object.assign(new Error('corte'), { errno: 3024, code: 'ER_QUERY_TIMEOUT' }))
          : db.query(sql, params)),
      };
      const body = await ok('/api/delivery/progress', { account: ACCOUNT, id: uniqueOf(9) }, environment.handlerAt(NOW, cutting));
      assert.deepEqual(body, { variant: 'generating', sent: null, contacts: 100 });
    });
  });

  describe('GET /api/delivery/messages', () => {
    const params = (extra) => ({ account: ACCOUNT, id: uniqueOf(8), ...extra });

    async function walk(extra) {
      const items = [];
      let cursor;
      for (let page = 0; page < 100; page += 1) {
        const body = await ok('/api/delivery/messages', params({ ...extra, ...(cursor ? { cursor } : {}) }));
        items.push(...body.items);
        if (body.nextCursor === null) return items;
        assert.equal(body.items.length, 10);
        cursor = body.nextCursor;
      }
      throw new Error('demasiadas páginas');
    }

    it('10 por página, por id, sin contenido ni el id de la tabla', async () => {
      const items = await walk({});
      const [rows] = await admin.query('SELECT id_unique FROM dbconnectus.sms_outgoing WHERE id_delivery = 8 AND id_account = 101 ORDER BY id');
      assert.deepEqual(items.map((item) => item.id), rows.map((row) => row.id_unique));
      assert.deepEqual(Object.keys(items[0]).sort(), ['country', 'dst', 'id', 'provider', 'status', 'updatedAt']);
    });

    it('la fila mezclada no aparece', async () => {
      const [[{ id_unique: mixed }]] = await admin.query('SELECT id_unique FROM dbconnectus.sms_outgoing WHERE id = 9011');
      for (let page = 0, cursor; page < 3; page += 1) {
        const body = await ok('/api/delivery/messages', { account: ACCOUNT, id: uniqueOf(1), ...(cursor ? { cursor } : {}) });
        assert.ok(!body.items.some((item) => item.id === mixed));
        cursor = body.nextCursor;
      }
      const [[own]] = await admin.query('SELECT dst_number FROM dbconnectus.sms_outgoing WHERE id = 9011');
      const filtered = await ok('/api/delivery/messages', { account: ACCOUNT, id: uniqueOf(1), dst: String(own.dst_number) });
      assert.ok(!filtered.items.some((item) => item.id === mixed));
    });

    it('un cursor es de ese envío y de esa cuenta', async () => {
      const { nextCursor } = await ok('/api/delivery/messages', params());
      assert.equal((await call('/api/delivery/messages', { account: ACCOUNT, id: uniqueOf(1), cursor: nextCursor })).statusCode, 400);
    });

    it('con dst filtra por número exacto y audita con_numero, sin el número', async () => {
      const [[{ dst_number: number }]] = await admin.query(
        'SELECT dst_number FROM dbconnectus.sms_outgoing WHERE id_delivery = 8 AND id_account = 101 ORDER BY id LIMIT 1'
      );
      const items = await walk({ dst: String(number) });
      const [rows] = await admin.query(
        'SELECT id_unique FROM dbconnectus.sms_outgoing WHERE id_delivery = 8 AND id_account = 101 AND dst_number = ? ORDER BY id',
        [number]
      );
      assert.ok(rows.length > 0);
      assert.deepEqual(items.map((item) => item.id), rows.map((row) => row.id_unique));
      assert.ok(items.every((item) => item.dst === String(number)));
      const last = await lastAudit();
      assert.deepEqual([last.action, Number(last.id_account), last.detail], ['delivery_search', 101, `${uniqueOf(8)} con_numero`]);
    });

    it('sin dst no audita', async () => {
      const before = (await audits()).length;
      await ok('/api/delivery/messages', params());
      assert.equal((await audits()).length, before);
    });

    it('un dst inválido responde 400, y un número de otro envío, vacío', async () => {
      assert.equal((await call('/api/delivery/messages', params({ dst: 'abc' }))).statusCode, 400);
      assert.equal((await call('/api/delivery/messages', params({ dst: '1'.repeat(16) }))).statusCode, 400);
      assert.deepEqual(await ok('/api/delivery/messages', params({ dst: '56900000999' })), { items: [], nextCursor: null });
    });
  });
});
