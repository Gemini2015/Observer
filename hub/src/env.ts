import { z } from 'zod';

const envSchema = z.object({
  OBSERVER_HOST: z.string().default('127.0.0.1'),
  OBSERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  OBSERVER_DATA_DIR: z.string().default('./data'),
  OBSERVER_ADMIN_PASSWORD: z.string().min(1).default('observer'),
  OBSERVER_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z.string().default('development'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid environment: ${detail}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.OBSERVER_ADMIN_PASSWORD === 'observer') {
    throw new Error('OBSERVER_ADMIN_PASSWORD must be set in production');
  }
  return env;
}
