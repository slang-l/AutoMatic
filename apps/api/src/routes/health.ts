import { Router } from 'express';

export interface HealthResponse {
  status: 'ok';
  service: 'automatic-api';
  timestamp: string;
  uptime: number;
  release?: string;
  commit?: string;
}

export const healthRouter = Router();

healthRouter.get('/health', (_request, response) => {
  const body: HealthResponse = {
    status: 'ok',
    service: 'automatic-api',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ...(process.env.AUTOMATIC_RELEASE ? { release: process.env.AUTOMATIC_RELEASE } : {}),
    ...(process.env.AUTOMATIC_COMMIT ? { commit: process.env.AUTOMATIC_COMMIT } : {}),
  };

  response.json(body);
});
