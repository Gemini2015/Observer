import path from 'node:path';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { openDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { ensureAdminPassword } from './services/admin.js';
import { runSchedulerTick } from './services/scheduler.js';

const env = loadEnv();
const dataDir = path.resolve(env.OBSERVER_DATA_DIR);
const db = openDb(path.join(dataDir, 'observer.db'));

migrate(db);
ensureAdminPassword(db, env.OBSERVER_ADMIN_PASSWORD);

const app = buildApp({ env, db });

if (env.OBSERVER_SCHEDULER_ENABLED) {
  const tick = () => {
    try {
      runSchedulerTick(db, Date.now(), {
        offlineAfterMs: env.OBSERVER_OFFLINE_AFTER_SECONDS * 1000,
      });
    } catch (error) {
      app.log.error({ err: error }, 'scheduler tick failed');
    }
  };
  const schedulerTimer = setInterval(tick, env.OBSERVER_SCHEDULER_INTERVAL_MS);
  schedulerTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(schedulerTimer);
  });
  tick();
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.OBSERVER_HOST, port: env.OBSERVER_PORT });
