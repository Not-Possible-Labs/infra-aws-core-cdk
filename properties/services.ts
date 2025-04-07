import { Service } from "./index";

export const authApi: Service = {
  name: "auth-api",
  type: "api",
  description: "Deno API for auth and user management",
  ecrRepositoryRequired: true,
  github: "auth-api",
  properties: {
    subdomain: "auth",
    priority: 1,
    memoryLimitMiB: 512,
    cpu: 256,
    desiredCount: 1,
  },
  healthCheck: "/healthcheck",
  secrets: ["NODE_ENV", "DATABASE_URL", "APIKEY"],
};

export const platformUi: Service = {
  name: "platform-ui",
  type: "platform",
  description: "NextJS Application - Main platform UI",
  ecrRepositoryRequired: true,
  github: "platform-ui",
  properties: {
    subdomain: "chess",
    priority: 2,
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

export const adminUi: Service = {
  name: "admin-ui",
  type: "platform",
  description: "Admin UI Dashboard",
  ecrRepositoryRequired: true,
  github: "admin-ui",
  properties: {
    subdomain: "admin",
    priority: 3,
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

export const database: Service = {
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
};
