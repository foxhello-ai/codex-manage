import type { FastifyReply } from "fastify";

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown
) {
  return reply.status(statusCode).send({
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  });
}
