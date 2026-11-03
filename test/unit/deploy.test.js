'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const StageThrottlingPlugin = require('../../scripts/throttling_etapa');
const { DEADLINE_MARGIN_MS, DEFAULT_DEADLINE_MS } = require('../../src/handler');
const { searchSms } = require('../../src/sms');
const { createFakeDb } = require('./support/fake_db');

const ROOT = path.join(__dirname, '..', '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const serverlessYml = read('serverless.yml');

const loginRule = /- Name: login-por-ip\n([\s\S]*?)\n\s+# Sobre todas las rutas/.exec(serverlessYml)?.[1] ?? '';
const generalRule = /- Name: general-por-ip\n([\s\S]*?)\n {4}LoginRateLimitAclAssociation:/.exec(serverlessYml)?.[1] ?? '';

// Parameter Store y el TLS de la primera conexión, con su connectTimeout de 5 s.
const COLD_START_ALLOWANCE_MS = 8000;
const API_GATEWAY_LIMIT_MS = 29000;

function ymlNumber(pattern) {
  const match = pattern.exec(serverlessYml);
  assert.ok(match, `serverless.yml no calza con ${pattern}`);
  return Number(match[1]);
}

test('los topes de una búsqueda más el arranque en frío caben en el plazo de la petición, sin pasar el de API Gateway', async () => {
  const db = createFakeDb({
    sms: [{
      id: 1,
      id_account: 101,
      id_delivery: 7,
      dst_number: '56900000001',
      sms_content: 'x',
      status: 'DELIVRD',
      created_at: '2026-10-10 12:00:00',
    }],
    deliveries: [{ id: 7, id_account: 101, name: 'Envío' }],
  });
  await searchSms(
    db,
    { account: 101, start: '2026-10-05', end: '2026-10-10', dst: null, cursor: null },
    { nowMs: Date.parse('2026-11-20T15:00:00Z'), cursorSecret: 'secreto-de-pruebas-que-supera-los-32-bytes' }
  );
  assert.equal(db.calls.length, 3);
  const limits = db.calls.map(({ sql }) => Number(/MAX_EXECUTION_TIME\((\d+)\)/.exec(sql)?.[1]));
  assert.deepEqual(limits, [2000, 8000, 2000]);

  const budget = limits.reduce((sum, limit) => sum + limit, 0);
  const timeoutMs = ymlNumber(/^ {2}timeout: (\d+)$/m) * 1000;
  assert.equal(DEFAULT_DEADLINE_MS, timeoutMs - DEADLINE_MARGIN_MS);
  assert.ok(budget + COLD_START_ALLOWANCE_MS < DEFAULT_DEADLINE_MS, `${budget} ms de consultas no caben en ${DEFAULT_DEADLINE_MS} ms`);
  assert.ok(timeoutMs < API_GATEWAY_LIMIT_MS);
});

test('serverless.yml limita POST /api/login por IP con una regla WAF regional asociada a la etapa', () => {
  assert.match(serverlessYml, /Type: AWS::WAFv2::WebACL\n/);
  assert.match(serverlessYml, /Scope: REGIONAL/);
  assert.match(serverlessYml, /AggregateKeyType: IP/);
  assert.match(serverlessYml, /SearchString: POST/);
  assert.match(serverlessYml, /PositionalConstraint: ENDS_WITH\n\s+SearchString: \/api\/login/);
  assert.match(serverlessYml, /ResponseCode: 429/);
  assert.match(loginRule, /Priority: 0\n/);
  assert.match(loginRule, /ScopeDownStatement:/);
  const limit = Number(/Limit: (\d+)/.exec(loginRule)?.[1]);
  assert.ok(limit >= 10 && limit <= 100, `Limit ${limit}`);

  assert.match(serverlessYml, /Type: AWS::WAFv2::WebACLAssociation\n/);
  assert.match(serverlessYml, /DependsOn: ApiGatewayDeployment\$\{sls:instanceId\}/);
  assert.match(serverlessYml, /\/stages\/prod/);
});

test('serverless.yml limita todas las rutas por IP, para que una sola IP no agote el throttling de la etapa', () => {
  assert.match(generalRule, /Priority: 1\n/);
  assert.match(generalRule, /AggregateKeyType: IP/);
  assert.match(generalRule, /EvaluationWindowSec: 300/);
  assert.match(generalRule, /Limit: 1500$/);
  assert.doesNotMatch(generalRule, /ScopeDownStatement/);
  assert.match(generalRule, /ResponseCode: 429/);
  assert.match(generalRule, /CustomResponseBodyKey: too_many_requests/);
  assert.match(serverlessYml, /DefaultAction:\n\s+Allow: \{\}/);
});

test('los cuerpos del 429 del WAF son JSON en la forma de los errores de la app, y el general no habla de intentos', () => {
  const bodies = new Map(
    [...serverlessYml.matchAll(/^ {10}(\w+):\n\s+ContentType: APPLICATION_JSON\n\s+Content: '(\{.*\})'/gm)]
      .map(([, key, content]) => [key, JSON.parse(content)])
  );
  assert.deepEqual([...bodies.keys()].sort(), ['too_many_attempts', 'too_many_requests']);
  for (const body of bodies.values()) {
    assert.deepEqual(Object.keys(body).sort(), ['error', 'message']);
    assert.equal(body.error, 'too_many_requests');
  }
  assert.match(bodies.get('too_many_attempts').message, /intentos/);
  assert.doesNotMatch(bodies.get('too_many_requests').message, /intentos/);
  assert.match(loginRule, /CustomResponseBodyKey: too_many_attempts/);
});

test('serverless.yml declara el throttling de la etapa y carga el plugin que lo aplica', () => {
  assert.match(serverlessYml, /^ {2}- \.\/scripts\/throttling_etapa\.js$/m);
  assert.ok(ymlNumber(/stageThrottling:\n\s+rateLimit: (\d+)/) > 0);
  assert.ok(ymlNumber(/stageThrottling:\n\s+rateLimit: \d+\n\s+burstLimit: (\d+)/) > 0);
});

test('el plugin del throttling corre antes que el del dominio: si el dominio falla, la etapa no queda sin límite', () => {
  const block = /^plugins:\n((?: {2}- .*\n)+)/m.exec(serverlessYml)?.[1];
  const plugins = block.trim().split('\n').map((line) => line.replace(/^\s*- /, ''));
  assert.deepEqual(plugins, ['./scripts/throttling_etapa.js', 'serverless-domain-manager']);
});

function fakeServerless(custom) {
  const requests = [];
  const provider = {
    naming: { getStackName: () => 'pila', getRestApiLogicalId: () => 'ApiGatewayRestApi' },
    getApiGatewayStage: () => 'prod',
    async request(service, method, params) {
      requests.push({ service, method, params });
      return method === 'describeStackResource' ? { StackResourceDetail: { PhysicalResourceId: 'abc123' } } : {};
    },
  };
  return { requests, serverless: { service: { custom }, getProvider: () => provider } };
}

test('el plugin fija el throttling de toda la etapa después de desplegar', async () => {
  const { requests, serverless } = fakeServerless({ stageThrottling: { rateLimit: 20, burstLimit: 40 } });
  await new StageThrottlingPlugin(serverless).hooks['after:deploy:deploy']();
  assert.deepEqual(requests, [
    {
      service: 'CloudFormation',
      method: 'describeStackResource',
      params: { StackName: 'pila', LogicalResourceId: 'ApiGatewayRestApi' },
    },
    {
      service: 'APIGateway',
      method: 'updateStage',
      params: {
        restApiId: 'abc123',
        stageName: 'prod',
        patchOperations: [
          { op: 'replace', path: '/*/*/throttling/rateLimit', value: '20' },
          { op: 'replace', path: '/*/*/throttling/burstLimit', value: '40' },
        ],
      },
    },
  ]);
});

test('sin la configuración, el plugin hace fallar el despliegue en vez de dejar la etapa sin límite', async () => {
  for (const custom of [undefined, {}, { stageThrottling: { rateLimit: 20 } }, { stageThrottling: { burstLimit: 40 } }]) {
    const { requests, serverless } = fakeServerless(custom);
    await assert.rejects(new StageThrottlingPlugin(serverless).hooks['after:deploy:deploy'](), /stageThrottling/);
    assert.equal(requests.length, 0);
  }
});

for (const name of ['README.md', 'docs/DISENO.md']) {
  test(`${name} documenta el despliegue limpio y cómo aplicar un cambio de Parameter Store`, () => {
    const text = read(name);
    const steps = /^1\. `npm ci`\.\n(?:[\s\S]*?\n)?8\. `serverless deploy`.*$/m.exec(text)?.[0];
    assert.ok(steps, 'la secuencia va de npm ci a serverless deploy, en 8 pasos');
    const positions = [
      /us-west-2/,
      /PAGES_DOMAIN_NAME/,
      /Parameter Store/,
      /aprovisionar_bd\.sh/,
      /allowed_account/,
      /crear_login\.js/,
      /`serverless create_domain`/,
      /`serverless deploy`/,
    ].map((pattern) => steps.search(pattern));
    assert.ok(positions.every((position) => position >= 0), `falta un paso: ${positions}`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'los pasos van en este orden');
    assert.match(text, /aws lambda update-function-configuration/);
  });

  test(`${name} no da a serverless deploy como forma de reciclar contenedores`, () => {
    const text = read(name);
    assert.doesNotMatch(text, /omite el despliegue/);
    assert.match(text, /`serverless deploy` ya no se omite/);
    assert.match(text, /DependsOn/);
  });
}

test('el contrato público no nombra namespaces de la plataforma', () => {
  assert.doesNotMatch(read('docs/DISENO.md'), /\b[A-Z][a-z]+::[A-Z]/);
});

test('un marcador de clave sin comillas no se puede correr a mano', () => {
  assert.match(read('sql/00_cuentas.sql'), /IDENTIFIED BY __PW_OWNER__,/);
  assert.match(read('sql/00_cuentas.sql'), /IDENTIFIED BY __PW_APP__\n/);
});
