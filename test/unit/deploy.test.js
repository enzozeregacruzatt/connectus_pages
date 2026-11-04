'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const StageThrottlingPlugin = require('../../scripts/throttling_etapa');
const { APP_PARAMETERS } = require('../../src/config');
const { DEADLINE_MARGIN_MS, DEFAULT_DEADLINE_MS } = require('../../src/handler');
const { searchSms } = require('../../src/sms');
const { WORKER_PARAMETERS } = require('../../src/worker/config');
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

test('.gitignore cubre los secretos y enlaces que se generan a mano en la raíz', () => {
  const ignored = read('.gitignore').split('\n');
  for (const pattern of ['/link_secret*', '/enlace*', '/worker_db_password*', '/token_secret*', '/db_password*']) {
    assert.ok(ignored.includes(pattern), `falta ${pattern}`);
  }
});

test('scripts/ no se despliega: crear_enlace.js y el secreto que lee quedan en el computador de quien emite', () => {
  assert.match(serverlessYml, /- '!scripts\/\*\*'/);
});

for (const name of ['README.md', 'docs/DISENO.md']) {
  test(`${name} documenta el despliegue limpio y cómo aplicar un cambio de Parameter Store`, () => {
    const text = read(name);
    const steps = /^1\. `npm ci`\.\n(?:[\s\S]*?\n)?10\. .*`serverless deploy`.*$/m.exec(text)?.[0];
    assert.ok(steps, 'la secuencia va de npm ci a serverless deploy, en 10 pasos');
    const positions = [
      /us-west-2/,
      /PAGES_DOMAIN_NAME/,
      /\/connectus-pages\/prod\//,
      /aprovisionar_bd\.sh/,
      /allowed_account/,
      /crear_login\.js/,
      /crear_enlace\.js/,
      /`serverless create_domain`/,
      /`serverless deploy`/,
    ].map((pattern) => steps.search(pattern));
    assert.ok(positions.every((position) => position >= 0), `falta un paso: ${positions}`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'los pasos van en este orden');
    assert.match(text, /aws lambda update-function-configuration/);
  });

  test(`${name} nombra todos los parámetros que piden los cargadores, y cómo apagar el trabajador`, () => {
    const text = read(name);
    for (const parameter of new Set([...APP_PARAMETERS, ...WORKER_PARAMETERS])) {
      assert.ok(text.includes(`\`${parameter}\``), parameter);
    }
    assert.match(text, /PAGES_ALARM_TOPIC_ARN/);
    assert.match(text, /put-function-concurrency --function-name connectus-pages-prod-worker --reserved-concurrent-executions 0/);
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
  assert.match(read('sql/00_cuentas.sql'), /IDENTIFIED BY __PW_APP__,/);
  assert.match(read('sql/00_cuentas.sql'), /IDENTIFIED BY __PW_WORKER__\n/);
});

function ssmParametersIn(block) {
  return [...block.matchAll(/parameter\/connectus-pages\/prod\/(\S*)$/gm)].map(([, name]) => name);
}

const appIam = /^ {2}iam:\n([\s\S]*?)^functions:/m.exec(serverlessYml)?.[1] ?? '';
const workerRole = /^ {4}WorkerRole:\n([\s\S]*?)^ {4}# Los eventos van en texto/m.exec(serverlessYml)?.[1] ?? '';
const workerFunction = /^ {2}worker:\n([\s\S]*?)^# El throttling primero/m.exec(serverlessYml)?.[1] ?? '';
const bucket = /^ {4}ExportsBucket:\n([\s\S]*?)^ {4}ExportsBucketPolicy:/m.exec(serverlessYml)?.[1] ?? '';

test('la lista de Parameter Store de la app es exactamente lo que pide su cargador, sin comodín', () => {
  assert.deepEqual(ssmParametersIn(appIam).sort(), [...APP_PARAMETERS].sort());
  assert.ok(!appIam.includes('prod/*'));
});

test('la lista de Parameter Store del trabajador es exactamente lo que pide su cargador', () => {
  assert.deepEqual(ssmParametersIn(workerRole).sort(), [...WORKER_PARAMETERS].sort());
});

test('el trabajador nunca lee los secretos de sesión ni de enlace, y la app nunca lee la clave del trabajador', () => {
  for (const name of ssmParametersIn(workerRole)) assert.doesNotMatch(name, /^(token_secret|link_secret_|db_user$|db_password$)/);
  for (const name of ssmParametersIn(appIam)) assert.doesNotMatch(name, /^worker_/);
});

test('el rol de la app solo puede leer exports/ de S3', () => {
  assert.deepEqual([...appIam.matchAll(/^\s+- (s3:\S+)$/gm)].map(([, action]) => action), ['s3:GetObject']);
  assert.match(appIam, /- \/exports\/\*$/m);
});

test('el rol del trabajador tiene solo lo que necesita sobre exports/, sin listar el bucket', () => {
  assert.deepEqual([...workerRole.matchAll(/^\s+- (s3:\S+)$/gm)].map(([, action]) => action).sort(), [
    's3:AbortMultipartUpload',
    's3:GetObject',
    's3:ListMultipartUploadParts',
    's3:PutObject',
  ]);
  assert.match(workerRole, /- \/exports\/\*$/m);
  assert.doesNotMatch(workerRole, /Action: ['"]?\*|s3:\*|Resource: ['"]?\*/);
});

test('la función del trabajador corre de a una, con su rol, sin reintentos y una vez por minuto', () => {
  assert.match(workerFunction, /handler: src\/worker\/handler\.worker\n/);
  assert.match(workerFunction, /role: WorkerRole\n/);
  assert.match(workerFunction, /reservedConcurrency: 1\n/);
  assert.match(workerFunction, /timeout: 900\n/);
  assert.match(workerFunction, /memorySize: 512\n/);
  assert.match(workerFunction, /maximumEventAge: 60\n/);
  assert.match(workerFunction, /maximumRetryAttempts: 0\n/);
  assert.match(workerFunction, /- schedule: rate\(1 minute\)\n/);
});

test('el bucket es privado, cifrado, solo con TLS, y expira lo exportado', () => {
  for (const flag of ['BlockPublicAcls', 'BlockPublicPolicy', 'IgnorePublicAcls', 'RestrictPublicBuckets']) {
    assert.match(bucket, new RegExp(`${flag}: true\\n`));
  }
  assert.match(bucket, /ObjectOwnership: BucketOwnerEnforced\n/);
  assert.match(bucket, /SSEAlgorithm: AES256\n/);
  assert.match(bucket, /Prefix: exports\/\n\s+ExpirationInDays: 7\n\s+AbortIncompleteMultipartUpload:\n\s+DaysAfterInitiation: 1\n/);
  assert.doesNotMatch(bucket, /BucketName:/);
  assert.match(serverlessYml, /aws:SecureTransport: 'false'/);
  assert.match(serverlessYml, /EXPORTS_BUCKET:\n\s+Ref: ExportsBucket\n/);
});

test('cada filtro de métrica depende de su grupo de registros, y cada alarma avisa al mismo tema', () => {
  const filters = [...serverlessYml.matchAll(/Type: AWS::Logs::MetricFilter\n\s+DependsOn: (\w+)\n\s+Properties:\n\s+LogGroupName:\n\s+Ref: (\w+)\n/g)];
  assert.equal(filters.length, (serverlessYml.match(/AWS::Logs::MetricFilter/g) ?? []).length);
  for (const [, dependsOn, group] of filters) {
    assert.equal(dependsOn, group);
    assert.ok(['AppLogGroup', 'WorkerLogGroup'].includes(group));
  }
  const alarms = serverlessYml.match(/Type: AWS::CloudWatch::Alarm/g) ?? [];
  assert.equal((serverlessYml.match(/- \$\{env:PAGES_ALARM_TOPIC_ARN\}/g) ?? []).length, alarms.length);
});

test('hay alarma para cada evento del contrato, y export_failed no cuenta too_many_rows', () => {
  assert.match(serverlessYml, /FilterPattern: '\?"request_failed" \?"handler_failed" \?"request_deadline_exceeded"'/);
  assert.match(serverlessYml, /FilterPattern: '"export_failed" -"too_many_rows"'/);
  for (const event of ['schema_error', 'link_suspect', 'export_create']) {
    assert.ok(serverlessYml.includes(`FilterPattern: '"${event}"'`), event);
  }
  assert.match(serverlessYml, /MetricName: Errors\n\s+Dimensions:\n\s+- Name: FunctionName\n\s+Value:\n\s+Ref: WorkerLambdaFunction/);
  assert.match(serverlessYml, /MetricName: Invocations[\s\S]*?Period: 1200\n\s+EvaluationPeriods: 1\n\s+ComparisonOperator: LessThanThreshold\n\s+Threshold: 1\n\s+TreatMissingData: breaching/);
  assert.match(serverlessYml, /MetricName: ExportCreate[\s\S]*?Period: 3600[\s\S]*?GreaterThanThreshold\n\s+Threshold: 20\n/);
});
