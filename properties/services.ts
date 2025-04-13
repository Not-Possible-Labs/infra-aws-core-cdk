import { Service } from "./index";

export const platformUi: Service = {
  name: "platform-ui",
  type: "platform",
  description: "NextJS Application - Main platform UI",
  ecrRepositoryRequired: true,
  github: "platform-ui",
  properties: {
    subdomain: "chess",
    priority: 1,
    memoryLimitMiB: 512,
    cpu: 256,
    desiredCount: 1,
  },
  healthCheck: "/healthcheck",
  secrets: [
    "AUTH_API_URL",
    "MATCHMAKING_API_URL",
    "GAME_STATE_API_URL",
    "BETTING_WAGER_API_URL",
    "MESSAGING_API_URL",
    "PAYMENTS_API_URL",
    "LEADERBOARD_RANKING_API_URL",
    "CHEAT_DETECTION_API_URL",
    "DISPUTE_RESOLUTION_API_URL",
  ],
};

export const authApi: Service = {
  name: "auth-api",
  type: "api",
  description: "Deno API for auth and user management",
  ecrRepositoryRequired: true,
  github: "auth-api",
  properties: {
    subdomain: "auth",
    priority: 2,
    memoryLimitMiB: 512,
    cpu: 256,
    desiredCount: 1,
  },
  healthCheck: "/healthcheck",
  secrets: ["NODE_ENV", "DATABASE_URL", "DIRECT_URL", "APIKEY", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"],
};

export const adminUi: Service = {
  name: "admin-ui",
  type: "platform",
  description: "Admin UI Dashboard",
  ecrRepositoryRequired: true,
  github: "admin-ui",
  properties: {
    subdomain: "admin",
    priority: 11,
    memoryLimitMiB: 512,
    cpu: 256,
    desiredCount: 1,
  },
  healthCheck: "/healthcheck",
  secrets: [
    "AUTH_API_URL",
    "MATCHMAKING_API_URL",
    "GAME_STATE_API_URL",
    "BETTING_WAGER_API_URL",
    "MESSAGING_API_URL",
    "PAYMENTS_API_URL",
    "LEADERBOARD_RANKING_API_URL",
    "CHEAT_DETECTION_API_URL",
    "DISPUTE_RESOLUTION_API_URL",
  ],
};

export const gameStateApi: Service = {
  name: "game-state-api",
  type: "api",
  description: "Deno API for managing the game state",
  ecrRepositoryRequired: true,
  github: "game-state-api",
  properties: {
    subdomain: "game",
    priority: 4,
    memoryLimitMiB: 512,
    cpu: 256,
    desiredCount: 1,
  },
  healthCheck: "/healthcheck",
  secrets: ["NODE_ENV", "DATABASE_URL", "APIKEY"],
};

export const messagingApi: Service = {
  name: "messaging-api",
  type: "api",
  description: "Deno API for managing the messaging",
  ecrRepositoryRequired: true,
  github: "messaging-api",
  properties: {
    subdomain: "messaging",
    priority: 7,
    memoryLimitMiB: 512,
    cpu: 256,
    desiredCount: 1,
  },
  healthCheck: "/healthcheck",
  secrets: ["NODE_ENV", "DATABASE_URL", "APIKEY"],
};

export const paymentsApi: Service = {
  name: "payments-api",
  type: "api",
  description: "Deno API for managing payments",
  ecrRepositoryRequired: true,
  github: "payments-api",
  properties: {
    subdomain: "payments",
    priority: 8,
    memoryLimitMiB: 512,
    cpu: 256,
    desiredCount: 1,
  },
  healthCheck: "/healthcheck",
  secrets: ["NODE_ENV", "DATABASE_URL", "APIKEY"],
};

export const leaderboardRankingApi: Service = {
  name: "leaderboard-api",
  type: "api",
  description: "Deno API for managing the leaderboard ranking",
  ecrRepositoryRequired: true,
  github: "leaderboard-ranking-api",
  properties: {
    subdomain: "leaderboard",
    priority: 5,
    memoryLimitMiB: 512,
    cpu: 256,
    desiredCount: 1,
  },
  healthCheck: "/healthcheck",
  secrets: ["NODE_ENV", "DATABASE_URL", "APIKEY"],
};

export const disputeResolutionApi: Service = {
  name: "dispute-api",
  type: "api",
  description: "Deno API for managing the dispute resolution",
  ecrRepositoryRequired: true,
  github: "dispute-resolution-api",
  properties: {
    subdomain: "dispute",
    priority: 9,
    memoryLimitMiB: 512,
    cpu: 256,
    desiredCount: 1,
  },
  healthCheck: "/healthcheck",
  secrets: ["NODE_ENV", "DATABASE_URL", "APIKEY"],
};

export const cheatDetectionApi: Service = {
  name: "cheat-api",
  type: "api",
  description: "Deno API for cheat detection",
  ecrRepositoryRequired: true,
  github: "cheat-detection-api",
  properties: {
    subdomain: "cheat",
    priority: 6,
    memoryLimitMiB: 512,
    cpu: 256,
    desiredCount: 1,
  },
  healthCheck: "/healthcheck",
  secrets: ["NODE_ENV", "DATABASE_URL", "APIKEY"],
};

export const bettingApi: Service = {
  name: "betting-api",
  type: "api",
  description: "Deno API for betting",
  ecrRepositoryRequired: true,
  github: "betting-wager-api",
  properties: {
    subdomain: "betting",
    priority: 10,
    memoryLimitMiB: 512,
    cpu: 256,
    desiredCount: 1,
  },
  healthCheck: "/healthcheck",
  secrets: ["NODE_ENV", "DATABASE_URL", "APIKEY"],
};

export const matchmakingApi: Service = {
  name: "matchmaking-api",
  type: "api",
  description: "Deno API for matchmaking",
  ecrRepositoryRequired: true,
  github: "matchmaking-api",
  properties: {
    subdomain: "matchmaking",
    priority: 13,
    memoryLimitMiB: 512,
    cpu: 256,
    desiredCount: 1,
  },
  healthCheck: "/healthcheck",
  secrets: ["NODE_ENV", "DATABASE_URL", "APIKEY"],
};

/* export const database: Service = {
  name: "postgres",
  type: "database",
  description: "Postgres database",
  ecrRepositoryRequired: false,
  properties: {
    subdomain: "postgres",
    priority: 1, //This can be 1 since it has it's own load balancer
    memoryLimitMiB: 1024,
    cpu: 512,
    desiredCount: 1,
  },
}; */

export const conduktor: Service = {
  name: "conduktor",
  type: "conduktor",
  description: "kakfa conduktor",
  ecrRepositoryRequired: false,
  properties: {
    subdomain: "conduktor",
    priority: 1, //This can be 1 since it has it's own load balancer
    memoryLimitMiB: 1024,
    cpu: 512,
    desiredCount: 1,
  },
  healthCheck: "/api/health/live",
};
