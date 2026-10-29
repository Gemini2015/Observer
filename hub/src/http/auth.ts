import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { getAgentByToken, type AgentRow } from '../services/registry.js';
import { findSession, SESSION_COOKIE, type SessionRow } from '../services/sessions.js';
import { HttpError } from './errors.js';

export function requireAgent(db: Db, request: FastifyRequest): AgentRow {
  const header = request.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    throw new HttpError(401, 'unauthorized', 'missing bearer token');
  }
  const token = header.slice('bearer '.length).trim();
  const agent = token ? getAgentByToken(db, token) : undefined;
  if (!agent) {
    throw new HttpError(401, 'unauthorized', 'invalid or revoked agent token');
  }
  return agent;
}

export function requireSession(db: Db, request: FastifyRequest): SessionRow {
  const id = request.cookies?.[SESSION_COOKIE];
  if (!id) {
    throw new HttpError(401, 'unauthorized', 'missing session cookie');
  }
  const session = findSession(db, id);
  if (!session) {
    throw new HttpError(401, 'unauthorized', 'session expired');
  }
  return session;
}
