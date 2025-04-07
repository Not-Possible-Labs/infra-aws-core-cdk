import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";

import { SharedServicesStack } from "../shared";
import { FargateStack as DefaultFargateService } from "../fargate/api";
import { FargateStack as WebSvcFargateService } from "../fargate/platform";
import { Service } from "../../../properties";
import { addStandardTags } from "../../../helpers/tag_resources";
import { PostgresStack } from "../fargate/database";

export interface MainStackProps extends cdk.StackProps {
  readonly environment: string;
  readonly project: string;
  readonly vpcId: string;
  readonly domain: string;
  readonly imageTag: string;
  readonly whitelist?: Array<{ address: string; description: string }>;
  readonly services: Service[];
}
export class MainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, props);

    // Create tagging props for the main stack
    const mainStackTaggingProps = {
      project: props.project,
      service: "main",
      environment: props.environment,
      customTags: {
        Stack: "main",
      },
    };

    // Add tags to the stack itself
    addStandardTags(this, mainStackTaggingProps);

    const shared = new SharedServicesStack(this, `${props.environment}-${props.project}-shared-services-cdk`, {
      stackName: `${props.environment}-${props.project}-shared-services-cdk`,
      environment: props.environment,
      project: props.project,
      domain: props.domain,
      vpcId: props.vpcId,
      whitelist: props.whitelist,
      env: { account: this.account, region: this.region },
      tags: {
        Environment: props.environment,
        Project: props.project,
        Service: "shared",
      },
    });



    props.services.forEach((service) => {
      /**************************** COMPUTE RESOURCES ********************************/

      switch (service.type) {
        case "database":
          const postgres = new PostgresStack(this, `${props.environment}-${props.project}-${service.name}-cdk`, {
            stackName: `${props.environment}-${props.project}-${service.name}-cdk`,
            environment: props.environment,
            project: props.project,
            subdomain: service.properties.subdomain,
            domain: props.domain,
            service: service.name,
            memoryLimitMiB: service.properties.memoryLimitMiB,
            cpu: service.properties.cpu,
            vpcId: props.vpcId,
            whitelist: props.whitelist,
            env: { account: this.account, region: this.region },
            description: "Postgres database running on docker/fargate",
            tags: {
              Environment: props.environment,
              Project: props.project,
              Service: service.name,
            },
          }).addDependency(shared);
          break;
        case "platform":
          const webSvc = new WebSvcFargateService(this, `${props.environment}-${props.project}-${service.name}-cdk`, {
            stackName: `${props.environment}-${props.project}-${service.name}-cdk`,
            environment: props.environment,
            project: props.project,
            microService: true,
            service: service.name,
            type: service.type,
            description: "Rest API Service that communicates with RDS Postgres",
            desiredCount: service.properties.desiredCount,
            secretVariables: service.secrets,
            internetFacing: false,
            healthCheck: service.healthCheck!,
            targetGroupPriority: service.properties.priority,
            imageTag: props.imageTag,
            subdomain: service.properties.subdomain,
            domain: props.domain,
            github: service.github!,
            vpcId: props.vpcId,
            whitelist: props.whitelist,
            memoryLimitMiB: service.properties.memoryLimitMiB,
            cpu: service.properties.cpu,
            env: { account: this.account, region: this.region },
            tags: {
              Environment: props.environment,
              Project: props.project,
              Service: service.name,
            },
          });
          webSvc.addDependency(shared);
          break;
        default:
          const defaultService = new DefaultFargateService(this, `${props.environment}-${props.project}-${service.name}-cdk`, {
            stackName: `${props.environment}-${props.project}-${service.name}-cdk`,
            environment: props.environment,
            project: props.project,
            microService: true,
            service: service.name,
            type: service.type,
            description: "Rest API Service that communicates with RDS Postgres",
            desiredCount: service.properties.desiredCount,
            secretVariables: service.secrets,
            internetFacing: false,
            healthCheck: service.healthCheck!,
            targetGroupPriority: service.properties.priority,
            imageTag: props.imageTag,
            subdomain: service.properties.subdomain,
            domain: props.domain,
            github: service.github!,
            vpcId: props.vpcId,
            whitelist: props.whitelist,
            memoryLimitMiB: service.properties.memoryLimitMiB,
            cpu: service.properties.cpu,
            env: { account: this.account, region: this.region },
            tags: {
              Environment: props.environment,
              Project: props.project,
              Service: service.name,
            },
          });
          defaultService.addDependency(shared);
      }

    });
  }
}
