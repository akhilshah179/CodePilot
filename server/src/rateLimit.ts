import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors.ts';

export interface RateLimitConfig {
  max: number;
  windowMs: number;
}

export interface RateLimitRule {
  max: number;
  windowMs: number;
}

interface WindowRecord {
  count: number;
  resetAt: number;
}

/**
 * Production-grade in-memory rate limiter using sliding-window / fixed-interval reset.
 * Automatically cleans up expired tracking records to prevent memory leaks.
 */
export class RateLimiter {
  private readonly records = new Map<string, WindowRecord>();
  private readonly cleanupInterval: NodeJS.Timeout;

  constructor(cleanupMs = 60_000) {
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupMs);
    this.cleanupInterval.unref();
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, rec] of this.records.entries()) {
      if (now >= rec.resetAt) this.records.delete(key);
    }
  }

  check(
    key: string,
    rule: RateLimitRule,
    reply?: FastifyReply,
  ): { allowed: boolean; remaining: number; resetSeconds: number; limit: number } {
    const now = Date.now();
    let rec = this.records.get(key);

    if (!rec || now >= rec.resetAt) {
      rec = { count: 1, resetAt: now + rule.windowMs };
      this.records.set(key, rec);
    } else {
      rec.count++;
    }

    const remaining = Math.max(0, rule.max - rec.count);
    const resetSeconds = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
    const allowed = rec.count <= rule.max;

    if (reply) {
      reply.header('RateLimit-Limit', rule.max);
      reply.header('RateLimit-Remaining', remaining);
      reply.header('RateLimit-Reset', resetSeconds);
      if (!allowed) {
        reply.header('Retry-After', resetSeconds);
      }
    }

    if (!allowed) {
      throw new AppError('rate_limited', `Too many requests. Please wait ${resetSeconds} seconds before retrying.`, 429);
    }

    return { allowed, remaining, resetSeconds, limit: rule.max };
  }

  reset() {
    this.records.clear();
  }

  destroy() {
    clearInterval(this.cleanupInterval);
    this.records.clear();
  }
}

/** Client identifier helper: extracts IP or authenticated user ID. */
export function getClientKey(request: FastifyRequest, userId?: string | null): string {
  if (userId) return `user:${userId}`;
  const ip = request.ip || request.socket.remoteAddress || '127.0.0.1';
  return `ip:${ip}`;
}
