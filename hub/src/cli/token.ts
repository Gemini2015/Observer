import path from 'node:path';
import { loadEnv } from '../env.js';
import { openDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { issueEnrollToken } from '../services/tokens.js';

interface Options {
  machineHint?: string;
  ttlHours: number;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { ttlHours: 24, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--machine') {
      options.machineHint = argv[++i];
    } else if (arg === '--ttl-hours') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--ttl-hours must be a positive number');
      }
      options.ttlHours = value;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`用法: pnpm --filter hub token:create -- [选项]

选项:
  --machine <id>    机器标识提示（可选）
  --ttl-hours <n>   有效期小时数，默认 24
  -h, --help        显示帮助`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const env = loadEnv();
  const dbPath = path.join(path.resolve(env.OBSERVER_DATA_DIR), 'observer.db');
  const db = openDb(dbPath);
  migrate(db);

  const issued = issueEnrollToken(db, {
    machineHint: options.machineHint,
    ttlHours: options.ttlHours,
  });
  db.close();

  console.log('');
  console.log('一次性注册 token（只显示这一次）:');
  console.log('');
  console.log(`  ${issued.token}`);
  console.log('');
  console.log(`有效期至: ${new Date(issued.expiresAt).toISOString()}`);
  console.log(`数据库  : ${dbPath}`);
} catch (error) {
  console.error(`创建注册 token 失败: ${(error as Error).message}`);
  process.exit(1);
}
