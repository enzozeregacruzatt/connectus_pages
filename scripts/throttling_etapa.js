'use strict';

// Plugin de Serverless que fija el throttling de la etapa REST con custom.stageThrottling.
//
// El framework no tiene una opción para esto, y la etapa la crea el recurso Deployment, cuyo id lógico cambia en cada despliegue,
// así que tampoco se puede declarar en CloudFormation. Se aplica como el framework aplica sus propios ajustes de etapa: con
// updateStage, después de desplegar. Es idempotente, y los despliegues siguientes no lo deshacen.
class StageThrottlingPlugin {
  constructor(serverless) {
    this.serverless = serverless;
    this.hooks = { 'after:deploy:deploy': () => this.applyThrottling() };
  }

  async applyThrottling() {
    const { rateLimit, burstLimit } = this.serverless.service.custom?.stageThrottling ?? {};
    if (!(rateLimit > 0) || !(burstLimit > 0)) {
      throw new Error('Falta custom.stageThrottling con rateLimit y burstLimit: la etapa quedaría sin throttling.');
    }
    const provider = this.serverless.getProvider('aws');
    const { StackResourceDetail } = await provider.request('CloudFormation', 'describeStackResource', {
      StackName: provider.naming.getStackName(),
      LogicalResourceId: provider.naming.getRestApiLogicalId(),
    });
    await provider.request('APIGateway', 'updateStage', {
      restApiId: StackResourceDetail.PhysicalResourceId,
      stageName: provider.getApiGatewayStage(),
      patchOperations: [
        { op: 'replace', path: '/*/*/throttling/rateLimit', value: String(rateLimit) },
        { op: 'replace', path: '/*/*/throttling/burstLimit', value: String(burstLimit) },
      ],
    });
  }
}

module.exports = StageThrottlingPlugin;
