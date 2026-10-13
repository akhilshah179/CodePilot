import type { EdgeLabel, OpKind } from './types.ts';

/** Human wording and edge labels for extracted operations. */
const OP_TEXT: Record<OpKind, string> = {
  sql: 'SQL query',
  query: 'Query',
  'cache-read': 'Cache read',
  'cache-write': 'Cache write',
  'cache-delete': 'Cache delete',
  publish: 'Publish',
  consume: 'Consume',
  enqueue: 'Enqueue job',
  'object-read': 'Object read',
  'object-write': 'Object write',
  http: 'HTTP call',
  rpc: 'RPC call',
  auth: 'Auth check',
  payment: 'Payments API call',
  email: 'Send email',
  ai: 'Model API call',
  search: 'Search request',
  send: 'Send message',
  webhook: 'Verify webhook signature',
};
export const opText = (op: OpKind) => OP_TEXT[op];

export function opLabel(op: OpKind, toolId: string): EdgeLabel {
  switch (op) {
    case 'sql':
      return 'SQL';
    case 'query':
    case 'search':
      return 'query';
    case 'cache-read':
      return 'cache read';
    case 'cache-write':
    case 'cache-delete':
      return 'cache write';
    case 'publish':
      return toolId === 'redis' || toolId === 'nats' || toolId === 'gcp-pubsub' || toolId === 'sns' ? 'pub/sub' : 'publish';
    case 'consume':
      return 'consume';
    case 'enqueue':
      return 'enqueue';
    case 'object-read':
    case 'object-write':
      return 'object storage';
    case 'http':
      return 'REST';
    case 'rpc':
      return 'gRPC';
    case 'auth':
      return 'auth';
    case 'email':
      return 'email';
    case 'webhook':
      return 'webhook';
    default:
      return 'API call';
  }
}

