import * as codebuild from "aws-cdk-lib/aws-codebuild";

interface NextJSDockerProps {
  imageTag: string;
  ecrURI: string;
  region: string;
  secretVariables: string[];
}

export const NextJSDockerBuildSpec = ({ imageTag, ecrURI, region, secretVariables }: NextJSDockerProps) => {
  return codebuild.BuildSpec.fromObject({
    version: "0.2",
    phases: {
      install: {
        "runtime-versions": { nodejs: "20" },
      },
      pre_build: {
        commands: [
          "echo Logging in to Amazon ECR...",
          "aws --version",
          `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${ecrURI}`,
        ],
      },
      build: {
        commands: [
          "echo Build started on `date`",
          "echo Building the Docker image...",
          //`docker build . -t ${ecrURI}:${imageTag}`,
          `docker build ${secretVariables.map((secret) => `--build-arg ${secret}=$${secret}`).join(" ")} . -t ${ecrURI}:${imageTag}`,
        ],
      },
      post_build: {
        commands: ["echo Build completed on `date`", "echo Pushing the Docker images...", `docker push ${ecrURI}:${imageTag}`],
      },
    },
  });
};

interface dockerProps {
  imageTag: string;
  ecrURI: string;
  region: string;
}

export const dockerBuildSpec = ({ imageTag, ecrURI, region }: dockerProps) => {
  return codebuild.BuildSpec.fromObject({
    version: "0.2",
    phases: {
      install: {
        "runtime-versions": { nodejs: "20" },
        commands: [
          "curl -fsSL https://deno.land/x/install/install.sh | sh",
          'export DENO_INSTALL="/root/.deno"',
          'export PATH="$DENO_INSTALL/bin:$PATH"',
          "deno --version",
        ],
      },
      pre_build: {
        commands: [
          "echo Logging in to Amazon ECR...",
          "aws --version",
          `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${ecrURI}`,
        ],
      },
      build: {
        commands: ["echo Build started on `date`", "echo Building the Docker image...", `docker build . -t ${ecrURI}:${imageTag}`],
      },
      post_build: {
        commands: ["echo Build completed on `date`", "echo Pushing the Docker images...", `docker push ${ecrURI}:${imageTag}`],
      },
    },
  });
};

interface ecsProps {
  cluster: string;
  service: string;
  roleARN: string;
  desiredCount: number;
  region: string;
}

export const ecsDeploymentBuildSpec = ({ cluster, service, roleARN, desiredCount, region }: ecsProps) => {
  return codebuild.BuildSpec.fromObject({
    version: "0.2",
    phases: {
      pre_build: {
        commands: ["aws --version"],
      },
      //https://github.com/Integralist/Shell-Scripts/blob/master/aws-cli-assumerole.sh
      build: {
        commands: [
          `OUT=$(aws sts assume-role --role-arn ${roleARN} --role-session-name AWSCLI-Session)`,
          `export AWS_ACCESS_KEY_ID=$(echo $OUT | jq -r '.Credentials''.AccessKeyId')`,
          `export AWS_SECRET_ACCESS_KEY=$(echo $OUT | jq -r '.Credentials''.SecretAccessKey')`,
          `export AWS_SESSION_TOKEN=$(echo $OUT | jq -r '.Credentials''.SessionToken')`,
          "echo Starting new container",
          `aws ecs update-service --cluster ${cluster} --service ${service} --desired-count ${desiredCount} --force-new-deployment --region ${region}`,
          `aws ecs wait services-stable --cluster ${cluster} --service ${service} --region ${region}`,
        ],
      },
    },
  });
};
