import * as service from "./services";

interface propertiesConfig {
  subdomain: string;
  priority: number;
  desiredCount: number;
  memoryLimitMiB: number;
  cpu: number;
}

export interface Service {
  name: string;
  description: string;
  type: "platform" | "database" | "api" | "conduktor";
  ecrRepositoryRequired: boolean;
  github?: string;
  properties: propertiesConfig;
  secrets?: string[];
  environmentVariables?: Record<string, string>;
  healthCheck?: string;
}

export interface Project {
  name: string;
  domain: string;
  envs: string[];
  slackWorkspaceId: string;
  pipelineSlackChannelId: string;
  services: Service[];
}

export const projects: Project[] = [
  {
    name: "not-possible",
    domain: "notpossiblelabs.com",
    envs: ["dev"],
    slackWorkspaceId: "T08L3S9A1D3",
    pipelineSlackChannelId: "C08LXDDRZA9",
    services: [
      service.platformUi,
      service.authApi,
      service.matchmakingApi,
      service.gameStateApi,
      service.leaderboardRankingApi,
      service.cheatDetectionApi,
      //service.messagingApi,
      //service.paymentsApi,
      //service.disputeResolutionApi,
      //service.bettingApi,
      service.adminUi,
      service.database,
      service.conduktor,
    ],
  },
] as const;
