import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { addStandardTags } from "../../../../helpers/tag_resources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as efs from "aws-cdk-lib/aws-efs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as backup from "aws-cdk-lib/aws-backup";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

const mgmt = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

/**
 * Configuration properties for the PostgreSQL Stack
 */
export interface ConduktorStackProps extends cdk.StackProps {
  readonly project: string;
  readonly service: string;
  readonly environment: string;
  readonly domain: string;
  readonly subdomain: string;
  readonly vpcId: string;
  readonly memoryLimitMiB: number;
  readonly cpu: number;
  readonly desiredCount: number;
  readonly whitelist?: Array<{ address: string; description: string }>;
  readonly targetGroupPriority?: number;
  readonly healthCheck: string;
}

/**
 * Stack that deploys a PostgreSQL database using ECS Fargate with:
 * - EFS for persistent storage with automatic backups
 * - Network Load Balancer for direct TCP access
 * - Security groups for access control
 * - CloudWatch logging
 * - Route53 DNS records
 */
export class ConduktorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ConduktorStackProps) {
    super(scope, id, props);

    // =============================================
    // Core Infrastructure Setup
    // =============================================
    const prefix = `${props.environment}-${props.project}-${props.service}`;
    const vpc = ec2.Vpc.fromLookup(this, `importing-${prefix}-vpc`, {
      isDefault: false,
      vpcId: props.vpcId,
    });

    // Stack tagging configuration
    const taggingProps = {
      project: props.project,
      service: props.service,
      environment: props.environment,
      prefix: prefix,
      customTags: {
        ...(props.tags || {}),
        Stack: "fargate",
      },
    };

    // Add tags to the stack itself
    addStandardTags(this, taggingProps);

    // =============================================
    // IAM Role Configuration
    // =============================================
    const role = new iam.Role(this, `${prefix}-role`, {
      assumedBy: new iam.CompositePrincipal(new iam.ServicePrincipal("ecs-tasks.amazonaws.com"), new iam.ServicePrincipal("ecs.amazonaws.com")),
      roleName: `${prefix}-role`,
    });
    addStandardTags(role, taggingProps);

    // Allow role assumption
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [`arn:aws:iam::${process.env.CDK_DEFAULT_ACCOUNT}:role/*`, `arn:aws:iam::${this.account}:role/*`],
        actions: ["sts:AssumeRole"],
      })
    );

    // Grant AWS service permissions
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: ["*"],
        actions: ["logs:*", "s3:*", "kms:*", "ecr:*", "ecs:*", "rds:*", "secretsmanager:*", "iam:PassRole", "elasticfilesystem:*"],
      })
    );

    // =============================================
    // ECS Cluster Configuration
    // =============================================
    const ecsCluster = ecs.Cluster.fromClusterAttributes(this, `import-${prefix}-fargate-cluster`, {
      clusterName: `${props.project}`,
      vpc: vpc,
      securityGroups: [],
    });

    // =============================================
    // Security Group Configuration
    // =============================================
    // Main security group for PostgreSQL service
    const defaultSecurityGroup = new ec2.SecurityGroup(this, `${prefix}-postgres-sg`, {
      vpc: vpc,
      description: `Security group for Postgres service in ${props.environment}`,
      allowAllOutbound: true,
      securityGroupName: `${prefix}-postgres`,
    });
    addStandardTags(defaultSecurityGroup, taggingProps);

    // Configure inbound rules
    defaultSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80), "Allow HTTP from within VPC");
    defaultSecurityGroup.addIngressRule(defaultSecurityGroup, ec2.Port.tcp(5432), "Allow PostgreSQL from self");

    defaultSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(8080), "Allow HTTP from within VPC");
    defaultSecurityGroup.addIngressRule(ec2.Peer.ipv4("10.0.0.0/24"), ec2.Port.tcp(8080), `Allow conduktor console port for management vpc`);

    defaultSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allIcmp(), "Allow ICMP from within VPC");

    defaultSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(5432), `Allow TCP Traffic for ${vpc.vpcId}`);
    defaultSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80), `Allow TCP Traffic for ${vpc.vpcId}`);
    defaultSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allIcmp(), "Allow all ICMP traffic");
    defaultSecurityGroup.addIngressRule(defaultSecurityGroup, ec2.Port.tcp(5432), `Allow traffic from self on postgres port`);
    defaultSecurityGroup.addIngressRule(ec2.Peer.ipv4("10.0.0.0/24"), ec2.Port.tcp(5432), `Allow postgres port for management vpc`);
    defaultSecurityGroup.addIngressRule(ec2.Peer.ipv4("10.0.0.0/24"), ec2.Port.tcp(80), `Allow TCP Traffic for management vpc`);
    defaultSecurityGroup.addIngressRule(ec2.Peer.ipv4("10.0.0.0/24"), ec2.Port.allIcmp(), `Allow ICMP Ping for management vpc`);

    const conduktorPorts = [8080, 9090, 9010, 9009, 9095];

    conduktorPorts.forEach((port) => {
      defaultSecurityGroup.addIngressRule(defaultSecurityGroup, ec2.Port.tcp(port), `Allow traffic from self on port ${port}`);
    });

    // =============================================
    // Load Balancer Configuration
    // =============================================
    const networkLoadBalancer = new elbv2.NetworkLoadBalancer(this, `${prefix}-nlb`, {
      vpc: vpc,
      internetFacing: false,
      vpcSubnets: {
        subnets: vpc.privateSubnets,
        availabilityZones: vpc.availabilityZones,
      },
      loadBalancerName: `${prefix}`,
      securityGroups: [defaultSecurityGroup],
    });
    addStandardTags(networkLoadBalancer, taggingProps);

    cdk.Tags.of(networkLoadBalancer).add("Name", `${prefix}`);

    // =============================================
    // EFS Storage Configuration
    // =============================================
    // Security group for EFS access
    const postgresEfsSecurityGroup = new ec2.SecurityGroup(this, `${prefix}-postgres-efs-security-group`, {
      vpc: vpc,
      securityGroupName: `${prefix}-postgres-efs`,
      description: `Security group for EFS mount targets in ${props.environment}`,
    });
    addStandardTags(postgresEfsSecurityGroup, taggingProps);

    // Configure EFS security rules
    postgresEfsSecurityGroup.addIngressRule(defaultSecurityGroup, ec2.Port.tcp(2049), "Allow NFS from Fargate tasks");
    postgresEfsSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(2049), "Allow NFS from VPC");

    // Tag EFS security group
    cdk.Tags.of(postgresEfsSecurityGroup).add("environment", prefix);
    cdk.Tags.of(postgresEfsSecurityGroup).add("Name", `${prefix}-postgres-efs`);

    // Create EFS filesystem
    const fileSystem = new efs.FileSystem(this, `${prefix}-postgres-efs`, {
      vpc: vpc,
      vpcSubnets: {
        subnets: vpc.privateSubnets,
        availabilityZones: vpc.availabilityZones,
      },
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      fileSystemName: `${prefix}`,
      securityGroup: postgresEfsSecurityGroup,
      enableAutomaticBackups: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
    });
    addStandardTags(fileSystem, taggingProps);

    // Tag EFS filesystem
    cdk.Tags.of(fileSystem).add("environment", prefix);

    // =============================================
    // Backup Configuration
    // =============================================
    /*  const backupVault = new backup.BackupVault(this, `${prefix}-backup-vault`, {
             backupVaultName: `${prefix}-vault`,
             removalPolicy: cdk.RemovalPolicy.DESTROY,
         });
 
         const backupPlan = new backup.BackupPlan(this, `${prefix}-backup-plan`, {
             backupPlanName: `${prefix}-plan`,
             backupVault: backupVault,
         });
 
         // Configure daily backups
         backupPlan.addRule(
             new backup.BackupPlanRule({
                 ruleName: "DailyBackup",
                 scheduleExpression: cdk.aws_events.Schedule.cron({ hour: "2", minute: "0" }),
                 deleteAfter: cdk.Duration.days(2),
             })
         );
 
         backupPlan.addSelection(`${prefix}-efs-selection`, {
             resources: [
                 backup.BackupResource.fromArn(fileSystem.fileSystemArn),
             ],
         }); */

    // =============================================
    // EFS Access Point Configuration
    // =============================================
    const postgresAccessPoint = new efs.AccessPoint(this, `${prefix}-postgres-access-point`, {
      fileSystem: fileSystem,
      path: "/postgresql",
      createAcl: {
        ownerGid: "999",
        ownerUid: "999",
        permissions: "755",
      },
      posixUser: {
        gid: "999",
        uid: "999",
      },
    });
    addStandardTags(postgresAccessPoint, taggingProps);

    // =============================================
    // Task Definition Configuration
    // =============================================
    // Configure EFS volume for task
    const efsVolume: ecs.Volume = {
      name: "efs-volume",
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: "ENABLED",
        authorizationConfig: {
          accessPointId: postgresAccessPoint.accessPointId,
          iam: "ENABLED",
        },
        rootDirectory: "/",
      },
    };

    // Create CloudWatch log group
    const postgresLogGroup = new logs.LogGroup(this, `${prefix}-postgres-logs`, {
      logGroupName: `/ecs/${prefix}-postgres`,
      retention: logs.RetentionDays.TWO_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    addStandardTags(postgresLogGroup, taggingProps);

    // Create task definition
    const postgresTaskDefinition = new ecs.FargateTaskDefinition(this, `${prefix}-postgres-task-definition`, {
      family: `${props.environment}-postgres`,
      executionRole: role,
      taskRole: role,
      memoryLimitMiB: props.memoryLimitMiB,
      cpu: props.cpu,
      volumes: [efsVolume],
    });
    addStandardTags(postgresTaskDefinition, taggingProps);

    const secrets = new secretsmanager.Secret(this, `${prefix}-secret`, {
      secretName: `${prefix}`,
      secretObjectValue: {
        POSTGRES_USER: cdk.SecretValue.unsafePlainText(""), //postgres
        POSTGRES_PASSWORD: cdk.SecretValue.unsafePlainText(""), //R8D6Fy3csyg
        POSTGRES_DB: cdk.SecretValue.unsafePlainText(""), //postgres
        POSTGRES_PORT: cdk.SecretValue.unsafePlainText("5432"),
        CDK_ADMIN_EMAIL: cdk.SecretValue.unsafePlainText(""), //"kaise@mostrom.io",
        CDK_ADMIN_PASSWORD: cdk.SecretValue.unsafePlainText(""), //"HsK6EAyy789c9j?$",
        CDK_DATABASE_NAME: cdk.SecretValue.unsafePlainText(""), //"postgres",
        CDK_DATABASE_PASSWORD: cdk.SecretValue.unsafePlainText(""), //"R8D6Fy3csyg",
        CDK_DATABASE_PORT: cdk.SecretValue.unsafePlainText("5432"),
        CDK_DATABASE_USERNAME: cdk.SecretValue.unsafePlainText(""), //"postgres",
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // encryptionKey: kmsKey,
      description: `Environment Variables for ${props.service}`,
    });
    addStandardTags(secrets, taggingProps);

    // Create container definition
    const postgresContainer = postgresTaskDefinition.addContainer(`${prefix}-postgres-container`, {
      image: ecs.ContainerImage.fromRegistry("public.ecr.aws/docker/library/postgres:17.4"),
      memoryLimitMiB: 1024,
      cpu: 512,
      essential: true,
      stopTimeout: cdk.Duration.seconds(120),
      environment: {
        PGDATA: "/var/lib/postgresql/data/pgdata",
        POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256",
        POSTGRES_HOST_AUTH_METHOD: "scram-sha-256",
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(secrets, "POSTGRES_PASSWORD"),
        POSTGRES_USER: ecs.Secret.fromSecretsManager(secrets, "POSTGRES_USER"),
        POSTGRES_DB: ecs.Secret.fromSecretsManager(secrets, "POSTGRES_DB"),
      },
      linuxParameters: new ecs.LinuxParameters(this, `${prefix}-postgres-linux-parameters`, {
        initProcessEnabled: true,
      }),
      logging: new ecs.AwsLogDriver({
        streamPrefix: "ecs",
        logGroup: postgresLogGroup,
        multilinePattern: "^(INFO|DEBUG|WARN|ERROR|CRITICAL)",
      }),
      healthCheck: {
        command: ["CMD-SHELL", "pg_isready -U postgres || exit 1"],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      portMappings: [
        {
          name: "postgresql",
          hostPort: 5432,
          containerPort: 5432,
          protocol: ecs.Protocol.TCP,
          //appProtocol: ecs.AppProtocol.,
        },
      ],
    });

    // Configure container mount points and parameters
    postgresContainer.addMountPoints({
      containerPath: "/var/lib/postgresql/data",
      readOnly: false,
      sourceVolume: efsVolume.name,
    });

    // Add ulimits for optimal PostgreSQL performance
    postgresContainer.addUlimits({
      name: ecs.UlimitName.NOFILE,
      softLimit: 65536,
      hardLimit: 65536,
    });

    postgresContainer.addUlimits({
      name: ecs.UlimitName.NPROC,
      softLimit: 65536,
      hardLimit: 65536,
    });

    // =============================================
    // Fargate Service Configuration
    // =============================================
    const postgresService = new ecs.FargateService(this, `${prefix}-postgres-service`, {
      cluster: ecsCluster,
      taskDefinition: postgresTaskDefinition,
      assignPublicIp: false,
      desiredCount: props.desiredCount,
      securityGroups: [defaultSecurityGroup],
      vpcSubnets: {
        subnets: vpc.privateSubnets,
        availabilityZones: vpc.availabilityZones,
      },
      enableExecuteCommand: true,
      serviceName: `${props.service}-postgres`,
    });
    addStandardTags(postgresService, taggingProps);

    // Ensure service depends on EFS
    postgresService.node.addDependency(fileSystem);

    const postgresTargetGroup = new elbv2.NetworkTargetGroup(this, `${prefix}-postgres-target-group-construct`, {
      targetGroupName: `${prefix}-pg-tg`,
      targets: [postgresService],
      protocol: elbv2.Protocol.TCP,
      port: 5432,
      vpc: vpc,
      healthCheck: {
        protocol: elbv2.Protocol.TCP,
        port: "5432",
        interval: cdk.Duration.seconds(6),
        timeout: cdk.Duration.seconds(5),
        unhealthyThresholdCount: 2,
        healthyThresholdCount: 2,
      },
    });
    addStandardTags(postgresTargetGroup, taggingProps);

    const postgresListener = networkLoadBalancer.addListener(`${prefix}-postgres-listener-construct`, {
      port: 5432,
      defaultTargetGroups: [postgresTargetGroup],
    });
    addStandardTags(postgresListener, taggingProps);

    // Ensure service depends on EFS
    /*  postgresService.node.addDependency(fileSystem); */

    /**
     * EventBridge Rules for ecs-service Service
     * Start Fargate Service at 05:00 EST (10:00 UTC)
     * Stop ecs-service at 23:00 EST (04:00 UTC next day)
     */
    // Start Fargate Service service at 05:00 EST (10:00 UTC)
    /*  const startPostgresRule = new events.Rule(this, `${prefix}-start-postgres-service-rule`, {
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "14",
        month: "*",
        day: "*",
      }),
      enabled: false,
      ruleName: `${prefix}-start-postgres-service`,
      description: `Start Fargate Service service at 05:00 EST (10:00 UTC)`,
      targets: [
        new targets.AwsApi({
          service: "ECS",
          action: "updateService",
          parameters: {
            cluster: ecsCluster.clusterName,
            service: postgresService.serviceName,
            desiredCount: 1,
          },
          catchErrorPattern: "ServiceNotFoundException",
          policyStatement: new iam.PolicyStatement({
            actions: ["ecs:UpdateService"],
            resources: [postgresService.serviceArn],
          }),
        }),
      ],
    });
    addStandardTags(startPostgresRule, taggingProps); */

    // Stop ecs-service service at 23:00 EST (04:00 UTC next day)
    /*   const stopPostgresRule = new events.Rule(this, `${prefix}-stop-postgres-service-rule`, {
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "2", // 04:00 UTC = 23:00 EST (previous day)
        month: "*",
        day: "*",
      }),
      ruleName: `${props.service}-stop-postgres-service`,
      description: `Stop ecs-service service at 23:00 EST (04:00 UTC next day)`,
      targets: [
        new targets.AwsApi({
          service: "ECS",
          action: "updateService",
          parameters: {
            cluster: ecsCluster.clusterName,
            service: postgresService.serviceName,
            desiredCount: 0,
          },
          catchErrorPattern: "ServiceNotFoundException",
          policyStatement: new iam.PolicyStatement({
            actions: ["ecs:UpdateService"],
            resources: [postgresService.serviceArn],
          }),
        }),
      ],
    });
    addStandardTags(stopPostgresRule, taggingProps); */

    // =============================================
    // Conduktor Configuration
    // =============================================

    const conduktorLogGroup = new logs.LogGroup(this, `${prefix}-console-logs`, {
      logGroupName: `/ecs/${prefix}-console`,
      retention: logs.RetentionDays.TWO_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    addStandardTags(conduktorLogGroup, taggingProps);

    const conduktorTaskDefinition = new ecs.FargateTaskDefinition(this, `${prefix}-console-task-definition`, {
      family: `${prefix}-console`,
      executionRole: role,
      taskRole: role,
      memoryLimitMiB: 8192,
      cpu: 4096, // 2 vCPU total for the task
      volumes: [efsVolume],
    });
    addStandardTags(conduktorTaskDefinition, taggingProps);

    const dockerCredentials = secretsmanager.Secret.fromSecretNameV2(this, `${prefix}-dockerhub-credentials`, "dockerhub-credentials");

    const conduktorConsoleContainer = conduktorTaskDefinition.addContainer(`${prefix}-console-container`, {
      image: ecs.ContainerImage.fromRegistry("conduktor/conduktor-console:1.30.0", { credentials: dockerCredentials }),
      memoryLimitMiB: 3072, // 3GB of the 4GB total
      cpu: 1536, // 1.5 vCPU (1536 of 2048)
      essential: true,
      stopTimeout: cdk.Duration.seconds(120),
      secrets: {
        CDK_ADMIN_EMAIL: ecs.Secret.fromSecretsManager(secrets, "CDK_ADMIN_EMAIL"),
        CDK_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(secrets, "CDK_ADMIN_PASSWORD"),
        CDK_DATABASE_NAME: ecs.Secret.fromSecretsManager(secrets, "CDK_DATABASE_NAME"),
        CDK_DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(secrets, "CDK_DATABASE_PASSWORD"),
        CDK_DATABASE_USERNAME: ecs.Secret.fromSecretsManager(secrets, "CDK_DATABASE_USERNAME"),
      },
      /*  healthCheck: {
        command: [`CMD-SHELL", "curl -f http://localhost:8080${props.healthCheck} || exit 1`],
        interval: cdk.Duration.seconds(15),
        retries: 5,
        startPeriod: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(10),
      }, */
      environment: {
        CDK_DATABASE_HOST: networkLoadBalancer.loadBalancerDnsName,
        CDK_DATABASE_PORT: "5432",
        "CDK_MONITORING_ALERT-MANAGER-URL": "http://localhost:9010/",
        "CDK_MONITORING_CALLBACK-URL": "http://localhost:8080/monitoring/api/",
        "CDK_MONITORING_CORTEX-URL": "http://localhost:9009/",
        "CDK_MONITORING_NOTIFICATIONS-CALLBACK-URL": "http://localhost:8080",
      },
      logging: new ecs.AwsLogDriver({
        streamPrefix: "ecs",
        logGroup: conduktorLogGroup,
        multilinePattern: "^(INFO|DEBUG|WARN|ERROR|CRITICAL)",
      }),
      portMappings: [
        {
          name: "console-8080-tcp",
          hostPort: 8080,
          containerPort: 8080,
          protocol: ecs.Protocol.TCP,
        },
      ],
    });

    // =============================================
    // conduktorMonitoring Configuration
    // =============================================

    const conduktorMonitoringLogGroup = new logs.LogGroup(this, `${prefix}-logs`, {
      logGroupName: `/ecs/${prefix}-monitoring`,
      retention: logs.RetentionDays.TWO_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    addStandardTags(conduktorMonitoringLogGroup, taggingProps);

    const conduktorMonitoringContainer = conduktorTaskDefinition.addContainer(`${prefix}-monitoring-container`, {
      image: ecs.ContainerImage.fromRegistry("conduktor/conduktor-console-cortex:1.30.0", { credentials: dockerCredentials }),
      memoryLimitMiB: 1024, // 1GB of the 4GB total
      cpu: 512, // 0.5 vCPU (512 of 2048)
      essential: true,
      stopTimeout: cdk.Duration.seconds(120),
      environment: {
        "CDK_CONSOLE-URL": `http://localhost:8080`,
      },
      logging: new ecs.AwsLogDriver({
        streamPrefix: "ecs",
        logGroup: conduktorMonitoringLogGroup,
        multilinePattern: "^(INFO|DEBUG|WARN|ERROR|CRITICAL)",
      }),
      portMappings: [
        {
          name: "console-9090-tcp",
          hostPort: 9090,
          containerPort: 9090,
          protocol: ecs.Protocol.TCP,
        },
        {
          name: "conduktor-cortex-9010-tcp",
          hostPort: 9010,
          containerPort: 9010,
          protocol: ecs.Protocol.TCP,
        },
        {
          name: "conduktor-cortex-9009-tcp",
          hostPort: 9009,
          containerPort: 9009,
          protocol: ecs.Protocol.TCP,
        },
      ],
    });

    // =============================================
    // Fargate Service Configuration
    // =============================================
    const conduktorService = new ecs.FargateService(this, `${prefix}-service`, {
      cluster: ecsCluster,
      taskDefinition: conduktorTaskDefinition,
      assignPublicIp: false,
      desiredCount: props.desiredCount,
      securityGroups: [defaultSecurityGroup],
      vpcSubnets: {
        subnets: vpc.privateSubnets,
        availabilityZones: vpc.availabilityZones,
      },
      //enableExecuteCommand: true,
      serviceName: `${props.service}`,
    });
    addStandardTags(conduktorService, taggingProps);

    // =============================================
    // DNS Configuration
    // =============================================

    /**
     * CREATE ALB
     */
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, `${prefix}-application-load-balancer`, {
      vpc: vpc,
      internetFacing: false,
      loadBalancerName: `${prefix}`,
      deletionProtection: false,
      vpcSubnets: { subnets: vpc.privateSubnets, availabilityZones: this.availabilityZones },
      ipAddressType: elbv2.IpAddressType.IPV4,
      securityGroup: defaultSecurityGroup,
      idleTimeout: cdk.Duration.seconds(30),
    });
    addStandardTags(loadBalancer, taggingProps);

    loadBalancer.addRedirect({
      sourceProtocol: elbv2.ApplicationProtocol.HTTP,
      sourcePort: 80,
      targetProtocol: elbv2.ApplicationProtocol.HTTP,
      targetPort: 8080,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, `${prefix}-target-group`, {
      port: 8080,
      vpc: vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: {
        port: "8080",
        interval: cdk.Duration.seconds(15),
        path: props.healthCheck,
        healthyHttpCodes: "200",
        timeout: cdk.Duration.seconds(10),
        unhealthyThresholdCount: 5,
        healthyThresholdCount: 2,
      },
      targetGroupName: `${prefix}`,
      targets: [conduktorService],
      deregistrationDelay: cdk.Duration.seconds(10),
    });

    addStandardTags(targetGroup, taggingProps);

    const HTTPListener = loadBalancer.addListener(`${prefix}-http-listener`, {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: true,
      defaultAction: elbv2.ListenerAction.forward([targetGroup]),
    });

    addStandardTags(HTTPListener, taggingProps);

    const recordName = props.environment === "prod" ? `${props.subdomain}.${props.domain}` : `${props.subdomain}.${props.environment}.${props.domain}`;

    //Setup Listener Action
    HTTPListener.addAction(`${prefix}-http-listener-action`, {
      priority: props.targetGroupPriority,
      conditions: [elbv2.ListenerCondition.hostHeaders([recordName])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    HTTPListener.connections.allowFrom(loadBalancer, ec2.Port.tcp(8080), `Allow connections from ${prefix} load balancer on port 8080`);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, `${prefix}-imported-hosted-zone`, {
      hostedZoneId: cdk.Fn.importValue(`${props.environment}-${props.project}-hosted-zone-id`),
      zoneName: `${props.environment}.${props.domain}`,
    });
    const cnameRecord = new route53.CnameRecord(this, `${prefix}-route53-cname-record`, {
      domainName: loadBalancer.loadBalancerDnsName,
      zone: hostedZone,
      comment: `Create the CNAME record for ${prefix} in ${props.project}`,
      recordName: recordName,
      ttl: cdk.Duration.minutes(30),
    });
    addStandardTags(cnameRecord, taggingProps);

    /**
     * EventBridge Rules for ecs-service Service
     * Start Fargate Service at 05:00 EST (10:00 UTC)
     * Stop ecs-service at 23:00 EST (04:00 UTC next day)
     */
    // Start Fargate Service service at 05:00 EST (10:00 UTC)
    const startRule = new events.Rule(this, `${prefix}-start-ecs-service-rule`, {
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "14", // 10:00 UTC = 05:00 EST
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
            service: `${conduktorService.serviceName}`,
            desiredCount: 1,
          },
          catchErrorPattern: "ServiceNotFoundException",
          policyStatement: new iam.PolicyStatement({
            actions: ["ecs:UpdateService"],
            resources: [conduktorService.serviceArn],
          }),
        }),
        new targets.AwsApi({
          service: "ECS",
          action: "updateService",
          parameters: {
            cluster: ecsCluster.clusterName,
            service: `${postgresService.serviceName}`,
            desiredCount: 1,
          },
          catchErrorPattern: "ServiceNotFoundException",
          policyStatement: new iam.PolicyStatement({
            actions: ["ecs:UpdateService"],
            resources: [postgresService.serviceArn],
          }),
        }),
      ],
    });
    addStandardTags(startRule, taggingProps);

    // Stop ecs-service service at 23:00 EST (04:00 UTC next day)
    const stopRule = new events.Rule(this, `${prefix}-stop-ecs-service-rule`, {
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "2", // 04:00 UTC = 10:00 EST (previous day)
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
            service: `${conduktorService.serviceName}`,
            desiredCount: 0,
          },
          catchErrorPattern: "ServiceNotFoundException",
          policyStatement: new iam.PolicyStatement({
            actions: ["ecs:UpdateService"],
            resources: [conduktorService.serviceArn],
          }),
        }),
        new targets.AwsApi({
          service: "ECS",
          action: "updateService",
          parameters: {
            cluster: ecsCluster.clusterName,
            service: `${postgresService.serviceName}`,
            desiredCount: 0,
          },
          catchErrorPattern: "ServiceNotFoundException",
          policyStatement: new iam.PolicyStatement({
            actions: ["ecs:UpdateService"],
            resources: [postgresService.serviceArn],
          }),
        }),
      ],
    });
    addStandardTags(stopRule, taggingProps);
  }
}
