import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import { PipelineStack } from "../../../pipelines/index";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { addStandardTags } from "../../../../helpers/tag_resources";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as kms from "aws-cdk-lib/aws-kms";

const mgmt = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

export interface FargateStackStackProps extends cdk.StackProps {
  readonly environment: string;
  //
  readonly project: string;
  readonly service: string;
  readonly type: string;
  readonly internetFacing: boolean;
  readonly healthCheck: string;
  readonly imageTag: string;
  readonly desiredCount: number;
  readonly secretVariables: string[] | undefined;
  readonly vpcId: string;
  readonly domain: string;
  readonly github: string;
  readonly memoryLimitMiB: number;
  readonly cpu: number;
  readonly targetGroupPriority?: number;
  readonly microService?: boolean;
  readonly loadBalancerDns?: string;
  readonly subdomain: string;
  readonly containerPort?: number;
  readonly whitelist?: Array<{ address: string; description: string }>;
}
export class FargateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FargateStackStackProps) {
    super(scope, id, props);

    /************************************************** VARIABLES ******************************************************* */

    const prefix = `${props.environment}-${props.project}-${props.service}`;

    // Create tagging props object that includes any custom tags from the parent stack
    const taggingProps = {
      project: props.project,
      service: props.service,
      environment: props.environment,
      prefix: prefix,
      customTags: {
        ...(props.tags || {}), // Include any tags passed from parent stack
        Stack: "fargate", // Add stack identifier
      },
    };

    // Add tags to the stack itself
    addStandardTags(this, taggingProps);

    /**
     * KMS Encryption Configuration
     * Sets up encryption key for sensitive data
     */
    const kmsKey = new kms.Key(this, `${prefix}-rds-kms-key`, {
      description: `KMS key for ${prefix}`,
      enableKeyRotation: true,
      alias: `${prefix}-rds-kms-key`,
    });

    kmsKey.grantDecrypt(new iam.AccountPrincipal(process.env.CDK_DEFAULT_ACCOUNT!));
    kmsKey.grantDecrypt(new iam.ArnPrincipal(`arn:aws:iam::${process.env.CDK_DEFAULT_ACCOUNT}:role/${prefix}-pipeline-role`));

    const secrets = new secretsmanager.Secret(this, `${prefix}-secret`, {
      secretName: prefix,
      secretObjectValue: {
        PUBLICA_API_TOKEN: cdk.SecretValue.unsafePlainText(""),
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryptionKey: kmsKey,
      description: `Environment Variables for ${props.service}`,
    });
    addStandardTags(secrets, taggingProps);

    /**
     * Grant cross-account access to secrets for pipeline role
     */
    secrets.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ArnPrincipal(`arn:aws:iam::${process.env.CDK_DEFAULT_ACCOUNT}:role/${prefix}-pipeline-role`),
          //new iam.AccountPrincipal(process.env.CDK_DEFAULT_ACCOUNT!),
        ],
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: ["*"],
      })
    );

    // Generate container secrets based on the specified list of secret names.
    const generateSecrets = (list: string[] | undefined) => {
      let containerSecrets: { [key: string]: any } = {};
      list?.forEach((item) => {
        containerSecrets[item] = ecs.Secret.fromSecretsManager(secrets, item);
      });
      return containerSecrets;
    };

    /************************************************** IMPORTS ******************************************************* */

    const vpc = ec2.Vpc.fromLookup(this, `importing-${prefix}-vpc`, { isDefault: false, vpcId: props.vpcId });

    var ecsCluster = ecs.Cluster.fromClusterAttributes(this, `import-${prefix}-fargate-cluster`, {
      clusterName: `${props.project}`,
      vpc: vpc,
      securityGroups: [],
    });

    const ecrRepository = ecr.Repository.fromRepositoryArn(
      this,
      `import-${prefix}-ecr-repository`,
      `arn:aws:ecr:${this.region}:${process.env.CDK_DEFAULT_ACCOUNT}:repository/${props.project}-${props.service}`
    );

    /**************************************************************************************** */

    /**
     * IAM Role and Permissions Configuration
     * Sets up IAM roles and policies for ECS task execution
     */
    const role = new iam.Role(this, `${prefix}-ecs-task-role`, {
      assumedBy: new iam.CompositePrincipal(
        new iam.AccountPrincipal(`${process.env.CDK_DEFAULT_ACCOUNT}`),
        new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        new iam.ServicePrincipal("ecs.amazonaws.com")
      ),
      roleName: `${prefix}-ecs-task-role`,
    });
    addStandardTags(role, taggingProps);

    secrets.grantRead(role);
    ecrRepository.grantPullPush(new iam.ArnPrincipal(role.roleArn));

    /**
     * Configure cross-account image pulling permissions
     */
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [`arn:aws:iam::${process.env.CDK_DEFAULT_ACCOUNT}:role/*`],
        actions: ["sts:AssumeRole"],
      })
    );

    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"));

    // Grant AWS service permissions
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: ["*"],
        actions: [
          "logs:*",
          "s3:*",
          "kms:*",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability",
          "ecs:UpdateService",
          "ecs:DescribeServices",
          "ecs:WaitUntilServiceStable",
        ],
      })
    );

    const logGroup = new logs.LogGroup(this, `${prefix}-container-log-group`, {
      logGroupName: `ecs/container/${props.project}/${props.environment}/${props.service}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    addStandardTags(logGroup, taggingProps);

    /************************************ FARGATE *********************************/

    /**
     * SECURITY
     */
    const fargateSecurityGroup = new ec2.SecurityGroup(this, `${prefix}-fargate-security-group`, {
      vpc: vpc,
      securityGroupName: `${prefix}-fargate`,
      allowAllOutbound: true,
    });
    addStandardTags(fargateSecurityGroup, taggingProps);

    fargateSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80), `Allow TCP Traffic for ${vpc.vpcId}`);
    fargateSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allIcmp(), "Allow all ICMP traffic");
    fargateSecurityGroup.addIngressRule(ec2.Peer.ipv4("10.0.0.0/24"), ec2.Port.tcp(80), `Allow TCP Traffic for management vpc`);
    fargateSecurityGroup.addIngressRule(ec2.Peer.ipv4("10.0.0.0/24"), ec2.Port.allIcmp(), `Allow ICMP Ping for management vpc`);

    const taskDef = new ecs.FargateTaskDefinition(this, `${prefix}-fargate-task-definition`, {
      family: prefix,
      executionRole: role,
      taskRole: role,
      memoryLimitMiB: props.memoryLimitMiB,
      cpu: props.cpu,
    });
    addStandardTags(taskDef, taggingProps);

    const container = taskDef.addContainer(`${prefix}-fargate-container`, {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepository, `${props.imageTag}`),
      memoryLimitMiB: props.memoryLimitMiB,
      cpu: props.cpu,
      essential: true,
      logging: new ecs.AwsLogDriver({
        streamPrefix: "ecs",
        logGroup: logGroup,
        multilinePattern: "^(INFO|DEBUG|WARN|ERROR|CRITICAL)",
      }),
      /*  healthCheck: {
        command: ["CMD-SHELL", "curl -f http://localhost:80/ || exit 1"],
        interval: cdk.Duration.seconds(15),
        retries: 5,
        startPeriod: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(10),
      }, */
      portMappings: [
        {
          containerPort: 80,
          protocol: ecs.Protocol.TCP,
          hostPort: 80,
        },
      ],
      secrets: generateSecrets(props.secretVariables),
      environment: {
        PORT: `80`,
        HOST: `${props.subdomain}.${props.environment}.${props.domain}`,
      },
    });

    /**
     * FARGATE
     * The weight determines the proportion of tasks that should be placed on instances associated
     * with this capacity provider relative to the total weight of all strategies.
     * So, for example, if FARGATE_SPOT is set with a weight of 2 and FARGATE is set with a weight of 1
     * then in this case, for every 3 tasks, 2 will be placed on Fargate Spot instances,
     * and 1 will be placed on regular Fargate instances.
     */
    const capacityProviderStrategies = [
      {
        capacityProvider: "FARGATE_SPOT",
        weight: props.desiredCount === 0 ? 1 : props.desiredCount,
      },
    ];

    //Define service
    const service = new ecs.FargateService(this, `${prefix}-fargate-service`, {
      serviceName: props.service,
      desiredCount: props.desiredCount,
      cluster: ecsCluster,
      deploymentController: { type: ecs.DeploymentControllerType.ECS },
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      taskDefinition: taskDef,
      vpcSubnets: { subnets: vpc.privateSubnets, onePerAz: true },
      assignPublicIp: false,
      securityGroups: [fargateSecurityGroup],
      healthCheckGracePeriod: cdk.Duration.seconds(15),
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      capacityProviderStrategies: capacityProviderStrategies,
    });
    addStandardTags(service, taggingProps);

    service.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    //if (props.environment === "prod") {
    const scalingPolicy = service.autoScaleTaskCount({
      minCapacity: props.desiredCount != 0 ? props.desiredCount : 1,
      maxCapacity: props.desiredCount != 0 ? props.desiredCount * 5 : 2,
    });
    addStandardTags(scalingPolicy, taggingProps);

    const cpuScaling = scalingPolicy.scaleOnCpuUtilization(`${prefix}-cpu-autoscaling`, {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
      policyName: `${prefix}-cpu-autoscaling`,
    });

    const memoryScaling = scalingPolicy.scaleOnMemoryUtilization(`${prefix}-memory-autoscaling`, {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
      policyName: `${prefix}-memory-autoscaling`,
    });

    //}

    /**
     * EventBridge Rules for ecs-service Service
     * Start Fargate Service at 05:00 EST (10:00 UTC)
     * Stop ecs-service at 23:00 EST (04:00 UTC next day)
     */
    // Start Fargate Service service at 05:00 EST (10:00 UTC)
    const startRule = new events.Rule(this, `${prefix}-start-ecs-service-rule`, {
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "14",
        month: "*",
        day: "*",
      }),
      enabled: false,
      ruleName: `${prefix}-start-ecs-service`,
      description: `Start Fargate Service service at 05:00 EST (10:00 UTC)`,
      targets: [
        new targets.AwsApi({
          service: "ECS",
          action: "updateService",
          parameters: {
            cluster: ecsCluster.clusterName,
            service: `${service.serviceName}`,
            desiredCount: 1,
          },
          catchErrorPattern: "ServiceNotFoundException",
          policyStatement: new iam.PolicyStatement({
            actions: ["ecs:UpdateService"],
            resources: [service.serviceArn],
          }),
        }),
      ],
    });
    addStandardTags(startRule, taggingProps);

    // Stop ecs-service service at 23:00 EST (04:00 UTC next day)
    const stopRule = new events.Rule(this, `${prefix}-stop-ecs-service-rule`, {
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "2", // 04:00 UTC = 23:00 EST (previous day)
        month: "*",
        day: "*",
      }),
      ruleName: `${props.service}-stop-ecs-service`,
      description: `Stop ecs-service service at 23:00 EST (04:00 UTC next day)`,
      targets: [
        new targets.AwsApi({
          service: "ECS",
          action: "updateService",
          parameters: {
            cluster: ecsCluster.clusterName,
            service: `${service.serviceName}`,
            desiredCount: 0,
          },
          catchErrorPattern: "ServiceNotFoundException",
          policyStatement: new iam.PolicyStatement({
            actions: ["ecs:UpdateService"],
            resources: [service.serviceArn],
          }),
        }),
      ],
    });
    addStandardTags(stopRule, taggingProps);

    /***************************** TARGET GROUP *****************************/

    const targetGroup = new elbv2.ApplicationTargetGroup(this, `${prefix}-target-group`, {
      port: 80,
      vpc: vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: {
        interval: cdk.Duration.seconds(15),
        path: props.healthCheck,
        healthyHttpCodes: "200",
        timeout: cdk.Duration.seconds(10),
        unhealthyThresholdCount: 5,
        healthyThresholdCount: 2,
      },
      targetGroupName: `${prefix}`,
      targets: [service],
      deregistrationDelay: cdk.Duration.seconds(10),
    });
    //Import HTTPS Listener from ./shared
    const HTTPSListener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, `${prefix}-https-listener`, {
      listenerArn: cdk.Fn.importValue(`${props.environment}-${props.project}-https-listener-arn`),
      securityGroup: ec2.SecurityGroup.fromSecurityGroupId(
        this,
        `imported-${prefix}-load-balancer-sg-id`,
        cdk.Fn.importValue(`${props.environment}-${props.project}-load-balancer-sg-id`),
        {
          allowAllOutbound: true,
          mutable: true,
        }
      ),
    });

    //Setup Listener Action
    HTTPSListener.addAction(`${prefix}-https-listener-action`, {
      priority: props.targetGroupPriority,
      conditions: [elbv2.ListenerCondition.hostHeaders([`${props.subdomain}.${props.environment}.${props.domain}`])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    addStandardTags(targetGroup, taggingProps);
    addStandardTags(HTTPSListener, taggingProps);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, `${prefix}-imported-hosted-zone`, {
      hostedZoneId: cdk.Fn.importValue(`${props.environment}-${props.project}-hosted-zone-id`),
      zoneName: `${props.environment}.${props.domain}`,
    });

    const cnameRecord = new route53.CnameRecord(this, `${prefix}-route53-cname-record`, {
      domainName: cdk.Fn.importValue(`${props.environment}-${props.project}-load-balancer-dns`),
      zone: hostedZone,
      comment: `Create the CNAME record for ${prefix} in ${props.project}.internal`,
      recordName: props.environment === "prod" ? `${props.subdomain}.${props.domain}` : `${props.subdomain}.${props.environment}.${props.domain}`,
      ttl: cdk.Duration.minutes(30),
    });
    addStandardTags(cnameRecord, taggingProps);

    /************************************ CODEPIPELINE STACK ******************************************** */
    /**
     * Adding if condition so that this stack only gets deployed once
     */

    const pipelineStack = new PipelineStack(this, `${prefix}-pipeline-cdk`, {
      stackName: `${prefix}-pipeline-cdk`,
      env: mgmt,
      description: `Codepipeline resources for ${props.service}`,
      terminationProtection: false,
      project: props.project,
      type: props.type,
      vpcId: `${process.env.MGMT_VPC}`, //MGMT VPC
      service: props.service,
      secretArn: secrets.secretFullArn!,
      ecsCluster: props.project,
      ecsService: service.serviceName,
      desiredCount: props.desiredCount,
      roleARN: role.roleArn,
      environment: props.environment,
      github: props.github,
      ecrURI: `${process.env.CDK_DEFAULT_ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/${props.project}-${props.service}`, //ecrRepository.repositoryUri,
      targetBranch: props.imageTag,
      imageTag: props.imageTag,
      secretVariables: props.secretVariables,
    });

    addStandardTags(pipelineStack, taggingProps);
  }
}
