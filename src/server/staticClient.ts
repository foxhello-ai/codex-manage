import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sendError } from "./httpErrors";

export async function registerStaticClient(app: FastifyInstance, clientRoot: string) {
  await app.register(fastifyStatic, {
    root: clientRoot,
    prefix: "/"
  });

  app.setNotFoundHandler((request, reply) => {
    if (shouldServeSpaIndex(request)) {
      return reply
        .header("cache-control", "no-cache")
        .type("text/html")
        .sendFile("index.html", { cacheControl: false });
    }

    return sendError(reply, 404, "NOT_FOUND", "请求的资源不存在");
  });
}

export function shouldServeSpaIndex(request: Pick<FastifyRequest, "method" | "url" | "headers">): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  const pathname = new URL(request.url, "http://local").pathname;
  if (pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/assets/")) return false;

  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (lastSegment.includes(".")) return false;

  const accept = request.headers.accept;
  return !accept || accept.includes("text/html") || accept.includes("*/*");
}
