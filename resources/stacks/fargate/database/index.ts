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
export interface PostgresStackProps extends cdk.StackProps {
  readonly project: string;
  readonly service: string;
  readonly environment: string;
  readonly domain: string;
  readonly subdomain: string;
  readonly vpcId: string;
  readonly memoryLimitMiB: number;
  readonly cpu: number;
  readonly whitelist?: Array<{ address: string; description: string }>;
  readonly nlbLoadBalancerDns?: string;
}

/**
 * Stack that deploys a PostgreSQL database using ECS Fargate with:
 * - EFS for persistent storage with automatic backups
 * - Network Load Balancer for direct TCP access
 * - Security groups for access control
 * - CloudWatch logging
 * - Route53 DNS records
 */
export class PostgresStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PostgresStackProps) {
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
    const securityGroup = new ec2.SecurityGroup(this, `${prefix}-sg`, {
      vpc: vpc,
      description: `Security group for Postgres service in ${props.environment}`,
      allowAllOutbound: true,
      securityGroupName: `${prefix}`,
    });
    addStandardTags(securityGroup, taggingProps);

    // Configure inbound rules
    securityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80), "Allow HTTP from within VPC");
    securityGroup.addIngressRule(securityGroup, ec2.Port.tcp(5432), "Allow PostgreSQL from self");
    securityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allIcmp(), "Allow ICMP from within VPC");

    securityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(5432), `Allow TCP Traffic for ${vpc.vpcId}`);
    securityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80), `Allow TCP Traffic for ${vpc.vpcId}`);
    securityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allIcmp(), "Allow all ICMP traffic");
    securityGroup.addIngressRule(securityGroup, ec2.Port.tcp(5432), `Allow traffic from self on postgres port`);
    securityGroup.addIngressRule(ec2.Peer.ipv4("10.0.0.0/24"), ec2.Port.tcp(5432), `Allow postgres port for management vpc`);
    securityGroup.addIngressRule(ec2.Peer.ipv4("10.0.0.0/24"), ec2.Port.tcp(80), `Allow TCP Traffic for management vpc`);
    securityGroup.addIngressRule(ec2.Peer.ipv4("10.0.0.0/24"), ec2.Port.allIcmp(), `Allow ICMP Ping for management vpc`);

    // =============================================
    // EFS Storage Configuration
    // =============================================
    // Security group for EFS access
    const efsSecurityGroup = new ec2.SecurityGroup(this, `${prefix}-efs-security-group`, {
      vpc: vpc,
      securityGroupName: `${prefix}-efs`,
      description: `Security group for EFS mount targets in ${props.environment}`,
    });
    addStandardTags(efsSecurityGroup, taggingProps);

    // Configure EFS security rules
    efsSecurityGroup.addIngressRule(securityGroup, ec2.Port.tcp(2049), "Allow NFS from Fargate tasks");
    efsSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(2049), "Allow NFS from VPC");

    // Tag EFS security group
    cdk.Tags.of(efsSecurityGroup).add("environment", prefix);
    cdk.Tags.of(efsSecurityGroup).add("Name", `${prefix}-efs`);

    // Create EFS filesystem
    const fileSystem = new efs.FileSystem(this, `${prefix}-database-efs`, {
      vpc: vpc,
      vpcSubnets: {
        subnets: vpc.privateSubnets,
        availabilityZones: vpc.availabilityZones,
      },
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      fileSystemName: `${prefix}-database`,
      securityGroup: efsSecurityGroup,
      enableAutomaticBackups: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
    });
    fileSystem.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
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
    const accessPoint = new efs.AccessPoint(this, `${prefix}-access-point`, {
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
    addStandardTags(accessPoint, taggingProps);

    // =============================================
    // Task Definition Configuration
    // =============================================
    // Configure EFS volume for task
    const ecsEFSVolume: ecs.Volume = {
      name: "efs-volume",
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: "ENABLED",
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: "ENABLED",
        },
        rootDirectory: "/",
      },
    };

    // Create CloudWatch log group
    const logGroup = new logs.LogGroup(this, `${prefix}-logs`, {
      logGroupName: `/ecs/${prefix}`,
      retention: logs.RetentionDays.TWO_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    addStandardTags(logGroup, taggingProps);

    // Create task definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, `${prefix}-task-definition`, {
      family: `${props.environment}-${props.service}`,
      executionRole: role,
      taskRole: role,
      memoryLimitMiB: props.memoryLimitMiB,
      cpu: props.cpu,
      volumes: [ecsEFSVolume],
    });
    addStandardTags(taskDefinition, taggingProps);

    const secrets = new secretsmanager.Secret(this, `${prefix}-secret`, {
      secretName: prefix,
      secretObjectValue: {
        POSTGRES_HOST: cdk.SecretValue.unsafePlainText(`${props.subdomain}.${props.environment}.${props.domain}`),
        POSTGRES_USER: cdk.SecretValue.unsafePlainText("postgres"),
        POSTGRES_PASSWORD: cdk.SecretValue.unsafePlainText("R8D6Fy3csyg"),
        POSTGRES_DB: cdk.SecretValue.unsafePlainText("postgres"),
        POSTGRES_PORT: cdk.SecretValue.unsafePlainText("5432"),
        DATABASE_URL: cdk.SecretValue.unsafePlainText(`postgres://postgres:R8D6Fy3csyg@${props.subdomain}.${props.environment}.${props.domain}:5432/postgres`),
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // encryptionKey: kmsKey,
      description: `Environment Variables for ${props.service}`,
    });
    addStandardTags(secrets, taggingProps);

    // Create container definition
    const container = taskDefinition.addContainer(`${prefix}-fargate-container`, {
      image: ecs.ContainerImage.fromRegistry("public.ecr.aws/docker/library/postgres:17.4"),
      memoryLimitMiB: props.memoryLimitMiB,
      cpu: props.cpu,
      essential: true,
      stopTimeout: cdk.Duration.seconds(120),
      environment: {
        POSTGRES_USER: "postgres",
        POSTGRES_PASSWORD: "R8D6Fy3csyg",
        POSTGRES_DB: "postgres",
        PGDATA: "/var/lib/postgresql/data/pgdata",
        POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256",
        POSTGRES_HOST_AUTH_METHOD: "scram-sha-256",
        POSTGRES_STOP_MODE: "smart",
        POSTGRES_SHUTDOWN_TIMEOUT: "300",
      },
      dockerLabels: {
        "STOPSIGNAL": "SIGTERM"
      },
      linuxParameters: new ecs.LinuxParameters(this, `${prefix}-linux-parameters`, {
        initProcessEnabled: true,
      }),
      logging: new ecs.AwsLogDriver({
        streamPrefix: "ecs",
        logGroup: logGroup,
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
    container.addMountPoints({
      containerPath: "/var/lib/postgresql/data",
      readOnly: false,
      sourceVolume: ecsEFSVolume.name,
    });

    // Add ulimits for optimal PostgreSQL performance
    container.addUlimits({
      name: ecs.UlimitName.NOFILE,
      softLimit: 65536,
      hardLimit: 65536,
    });

    container.addUlimits({
      name: ecs.UlimitName.NPROC,
      softLimit: 65536,
      hardLimit: 65536,
    });

    // =============================================
    // Fargate Service Configuration
    // =============================================
    const service = new ecs.FargateService(this, `${prefix}-fargate-service`, {
      cluster: ecsCluster,
      taskDefinition: taskDefinition,
      assignPublicIp: false,
      desiredCount: 1,
      securityGroups: [securityGroup],
      vpcSubnets: {
        subnets: vpc.privateSubnets,
        availabilityZones: vpc.availabilityZones,
      },
      enableExecuteCommand: true,
      serviceName: props.service,
    });
    addStandardTags(service, taggingProps);
    // Ensure service depends on EFS
    service.node.addDependency(fileSystem);

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
      loadBalancerName: `${prefix}-nlb`,
      securityGroups: [securityGroup],
    });
    addStandardTags(networkLoadBalancer, taggingProps);

    cdk.Tags.of(networkLoadBalancer).add("Name", `${prefix}-nlb`);

    const targetGroup = new elbv2.NetworkTargetGroup(this, `${prefix}-nlb-tg`, {
      targetGroupName: `${prefix}-nlb-tg`,
      targets: [service],
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
    addStandardTags(targetGroup, taggingProps);

    const listener = networkLoadBalancer.addListener(`${prefix}-nlb-listener`, {
      port: 5432,
      defaultTargetGroups: [targetGroup],
    });
    addStandardTags(listener, taggingProps);

    // =============================================
    // DNS Configuration
    // =============================================

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, `${prefix}-imported-hosted-zone`, {
      hostedZoneId: cdk.Fn.importValue(`${props.environment}-${props.project}-hosted-zone-id`),
      zoneName: `${props.environment}.${props.domain}`,
    });
    const cnameRecord = new route53.CnameRecord(this, `${prefix}-route53-cname-record`, {
      domainName: networkLoadBalancer.loadBalancerDnsName,
      zone: hostedZone,
      comment: `Create the CNAME record for ${prefix} in ${props.project}`,
      recordName: `${props.subdomain}.${props.environment}.${props.domain}`,
      ttl: cdk.Duration.minutes(30),
    });
    addStandardTags(cnameRecord, taggingProps);

    /*  const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, `${prefix}-importing-hosted-zone`,
             {
                 zoneName: `${props.project}.internal`,
                 hostedZoneId: cdk.Fn.importValue(`${props.environment}-${props.project}-internal-zone-id`)
             }
         );
 
         new route53.CnameRecord(this, `${prefix}-route53-cname-record`, {
             domainName: networkLoadBalancer.loadBalancerDnsName,
             zone: hostedZone,
             comment: `Create the CNAME record for ${prefix} in ${props.project}.internal`,
             recordName: `${props.service}.${props.project}.internal`,
             ttl: cdk.Duration.minutes(30),
         }); */
  }
}
