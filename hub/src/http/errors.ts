import type { FastifyReply } from 'fastify';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly title: string,
    public readonly detail?: string,
    public readonly retryable = false,
  ) {
    super(detail ?? title);
    this.name = 'HttpError';
  }
}

export function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
  retryable = false,
): FastifyReply {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title, status, detail, retryable });
}
