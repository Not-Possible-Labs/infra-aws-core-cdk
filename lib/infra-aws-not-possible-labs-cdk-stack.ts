import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
// import * as sqs from 'aws-cdk-lib/aws-sqs';
import { projects } from "../properties";
import * as dotenv from "dotenv";
dotenv.config();

// Define the valid environment keys
type EnvironmentKey = "prod" | "dev" | "mgmt";

const config: Record<
  EnvironmentKey,
  {
    east: { account: string | undefined; region: string | undefined };
  }
> = {
  prod: {
    east: { account: process.env.CDK_PROD_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  },
  dev: {
    east: { account: process.env.CDK_DEV_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  },
  mgmt: {
    east: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  },
} as const;

import { MainStack } from "../resources/stacks/main/index";
import { DevOpsStack } from "../resources/stacks/shared/index";

export class InfraAwsNotPossibleLabsCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const whitelist = [
      { address: "10.0.0.0/24", description: "mgmt us-east-1 vpc" },
      //{ address: "10.1.0.0/16", description: "dev us-east-1 vpc" },
      //{ address: "10.2.0.0/16", description: "prod us-east-1 vpc" },
      //{ address: "10.3.0.0/16", description: "dev us-west-1 vpc" },
      //{ address: "10.4.0.0/16", description: "prod us-west-1 vpc" },
      //{ address: "10.5.0.0/24", description: "prod us-west-1 vpc" },
    ];

    projects.forEach((project) => {
      const devOpsStack = new DevOpsStack(this, `${project.name}-devops-stack-cdk`, {
        project: project.name,
        stackName: `${project.name}-devops-stack-cdk`,
        env: config.mgmt.east,
        slackWorkspaceId: project.slackWorkspaceId,
        pipelineSlackChannelId: project.pipelineSlackChannelId,
        description: `Devops stack for ${project.name} contains ECR repositories for services`,
        services: project.services,
      });

      project.envs.forEach((env) => {
        const envKey = env as EnvironmentKey;
        if (!(envKey in config)) {
          throw new Error(`Invalid environment: ${env}`);
        }
        const mainStack = new MainStack(this, `${project.name}-${env}-cdk`, {
          environment: env,
          project: project.name,
          services: project.services,
          domain: project.domain,
          imageTag: env,
          whitelist: whitelist,
          vpcId: `${process.env[`${env.toUpperCase()}_VPC`]}`,
          stackName: `${project.name}-${env}-cdk`,
          env: config[envKey].east,
          description: `Stack for ${project.name} in ${env} environment`,
        });
        mainStack.addDependency(devOpsStack);
      });
    });
  }
}
