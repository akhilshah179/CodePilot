import type { Layer, OpKind, SourceLanguage, ToolCategory } from './types.ts';

/**
 * Technology catalog: how each technology is *recognized* (packages, import paths, container
 * images, URL schemes, client constructors, operation names). It describes what a technology
 * is, never what a particular repository does with it — that only comes from evidence.
 */

export interface ClientPattern {
  /** Regex with a named group `name` (the identifier the client is bound to) and optional `arg`. */
  re: RegExp;
  langs?: SourceLanguage[];
}

export interface OpPattern {
  /** Alternation of method names, e.g. `get|mget`. */
  methods: string;
  op: OpKind;
}

export interface RawOpPattern {
  re: RegExp;
  op: OpKind;
  /** `file`: only in files that import the tool; `repo`: anywhere once the tool is declared. */
  scope: 'file' | 'repo';
  langs?: SourceLanguage[];
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: ToolCategory;
  layer: Layer;
  /** Libraries are drawn inside the application that uses them. */
  display?: 'node' | 'chip';
  description: string;
  /** Package names; a trailing `/` or `*` matches as a prefix. */
  npm?: string[];
  pypi?: string[];
  go?: string[];
  cargo?: string[];
  gem?: string[];
  composer?: string[];
  /** `group:artifact`, or `group:` as a prefix. */
  maven?: string[];
  nuget?: string[];
  /** Source import prefixes per language (Python dotted modules, Go paths, Java packages…). */
  modules?: Partial<Record<SourceLanguage, string[]>>;
  /** Container image repository (without registry/tag). */
  images?: RegExp;
  /** URL schemes that point at this technology. */
  schemes?: string[];
  /** Env var names that suggest this technology (weak evidence on their own). */
  env?: RegExp;
  terraform?: RegExp;
  /** Helm chart dependency names. */
  helm?: RegExp;
  clients?: ClientPattern[];
  ops?: OpPattern[];
  /** The module alias itself receives operations (`requests.get`, `stripe.Customer.create`). */
  moduleOps?: boolean;
  rawOps?: RawOpPattern[];
  /** Technologies this one requires by design (e.g. BullMQ stores jobs in Redis). */
  requires?: { id: string; reason: string }[];
}

const REDIS_OPS: OpPattern[] = [
  { methods: 'get|mget|hget|hgetall|hmget|exists|ttl|pttl|smembers|sismember|zrange|zrangebyscore|zrevrange|zscore|lrange|llen|scard|getex|json\\.get', op: 'cache-read' },
  { methods: 'set|setex|setnx|psetex|mset|hset|hmset|hsetnx|incr|incrby|decr|decrby|expire|pexpire|expireat|sadd|zadd|zincrby|getset|append|json\\.set', op: 'cache-write' },
  { methods: 'del|unlink|hdel|srem|zrem|flushdb|flushall', op: 'cache-delete' },
  // List and stream pushes/pops are queue semantics, not caching.
  { methods: 'publish|xadd|lpush|rpush', op: 'publish' },
  { methods: 'subscribe|psubscribe|xread|xreadgroup|blpop|brpop|lpop|rpop', op: 'consume' },
];

const SQL_OPS: OpPattern[] = [{ methods: 'query|execute|exec|executemany|fetch|fetchrow|fetchval|fetchall|fetchone|any|one|oneOrNone|many|manyOrNone|none|prepare|queryRow|QueryRow|QueryRowContext|QueryContext|ExecContext|Query|Exec|Prepare|Select|Get', op: 'sql' }];

const HTTP_OPS: OpPattern[] = [{ methods: 'get|post|put|patch|delete|head|options|request|send|stream', op: 'http' }];

const S3_WRITE = 'putObject|upload|upload_file|upload_fileobj|put_object|copy_object|copyObject|createMultipartUpload|delete_object|deleteObject';
const S3_READ = 'getObject|get_object|download_file|download_fileobj|headObject|head_object|listObjects|listObjectsV2|list_objects|list_objects_v2|generate_presigned_url|getSignedUrl';

export const CATALOG: CatalogEntry[] = [
  // --- Frontend -------------------------------------------------------------------------------
  { id: 'react', name: 'React', category: 'frontend', layer: 'clients', display: 'chip', description: 'UI library for building component-based interfaces.', npm: ['react'] },
  { id: 'react-native', name: 'React Native', category: 'frontend', layer: 'clients', display: 'chip', description: 'Framework for native mobile apps written with React.', npm: ['react-native', 'expo'] },
  { id: 'vue', name: 'Vue', category: 'frontend', layer: 'clients', display: 'chip', description: 'Progressive framework for building user interfaces.', npm: ['vue'] },
  { id: 'svelte', name: 'Svelte', category: 'frontend', layer: 'clients', display: 'chip', description: 'Compiler-based UI framework.', npm: ['svelte'] },
  { id: 'angular', name: 'Angular', category: 'frontend', layer: 'clients', display: 'chip', description: 'TypeScript framework for web applications.', npm: ['@angular/core'] },
  { id: 'solid', name: 'SolidJS', category: 'frontend', layer: 'clients', display: 'chip', description: 'Reactive UI library.', npm: ['solid-js'] },
  { id: 'preact', name: 'Preact', category: 'frontend', layer: 'clients', display: 'chip', description: 'Small React-compatible UI library.', npm: ['preact'] },
  { id: 'react-query', name: 'TanStack Query', category: 'http-client', layer: 'clients', display: 'chip', description: 'Data fetching and caching for UI code.', npm: ['@tanstack/react-query', 'react-query', '@tanstack/vue-query'] },
  { id: 'apollo-client', name: 'Apollo Client', category: 'api', layer: 'clients', display: 'chip', description: 'GraphQL client with a normalized cache.', npm: ['@apollo/client'] },

  // --- Full-stack / server frameworks -----------------------------------------------------------------
  { id: 'nextjs', name: 'Next.js', category: 'framework', layer: 'application', display: 'chip', description: 'React framework with server rendering, route handlers and server actions.', npm: ['next'] },
  { id: 'nuxt', name: 'Nuxt', category: 'framework', layer: 'application', display: 'chip', description: 'Vue framework with server rendering and server routes.', npm: ['nuxt'] },
  { id: 'sveltekit', name: 'SvelteKit', category: 'framework', layer: 'application', display: 'chip', description: 'Svelte framework with server routes.', npm: ['@sveltejs/kit'] },
  { id: 'remix', name: 'Remix', category: 'framework', layer: 'application', display: 'chip', description: 'React framework built on web fetch APIs.', npm: ['@remix-run/node', '@remix-run/react', '@remix-run/server-runtime'] },
  { id: 'astro', name: 'Astro', category: 'framework', layer: 'application', display: 'chip', description: 'Content-focused web framework.', npm: ['astro'] },
  { id: 'vite', name: 'Vite', category: 'framework', layer: 'clients', display: 'chip', description: 'Frontend build tool and dev server.', npm: ['vite'] },
  { id: 'express', name: 'Express', category: 'framework', layer: 'application', display: 'chip', description: 'Minimal HTTP server framework for Node.js.', npm: ['express'] },
  { id: 'fastify', name: 'Fastify', category: 'framework', layer: 'application', display: 'chip', description: 'HTTP server framework for Node.js.', npm: ['fastify'] },
  { id: 'koa', name: 'Koa', category: 'framework', layer: 'application', display: 'chip', description: 'HTTP middleware framework for Node.js.', npm: ['koa'] },
  { id: 'hono', name: 'Hono', category: 'framework', layer: 'application', display: 'chip', description: 'Web framework for edge and Node runtimes.', npm: ['hono'] },
  { id: 'nestjs', name: 'NestJS', category: 'framework', layer: 'application', display: 'chip', description: 'Structured Node.js server framework.', npm: ['@nestjs/core'] },
  { id: 'elysia', name: 'Elysia', category: 'framework', layer: 'application', display: 'chip', description: 'Bun web framework.', npm: ['elysia'] },
  { id: 'fastapi', name: 'FastAPI', category: 'framework', layer: 'application', display: 'chip', description: 'Python web framework for APIs built on Starlette and Pydantic.', pypi: ['fastapi'], modules: { python: ['fastapi'] } },
  { id: 'flask', name: 'Flask', category: 'framework', layer: 'application', display: 'chip', description: 'Lightweight Python web framework.', pypi: ['flask'], modules: { python: ['flask'] } },
  { id: 'django', name: 'Django', category: 'framework', layer: 'application', display: 'chip', description: 'Python web framework with an ORM and admin.', pypi: ['django'], modules: { python: ['django'] } },
  { id: 'starlette', name: 'Starlette', category: 'framework', layer: 'application', display: 'chip', description: 'ASGI web toolkit.', pypi: ['starlette'], modules: { python: ['starlette'] } },
  { id: 'uvicorn', name: 'Uvicorn', category: 'runtime', layer: 'application', display: 'chip', description: 'ASGI web server.', pypi: ['uvicorn'], modules: { python: ['uvicorn'] } },
  { id: 'gunicorn', name: 'Gunicorn', category: 'runtime', layer: 'application', display: 'chip', description: 'WSGI HTTP server.', pypi: ['gunicorn'] },
  { id: 'gin', name: 'Gin', category: 'framework', layer: 'application', display: 'chip', description: 'Go HTTP web framework.', go: ['github.com/gin-gonic/gin'], modules: { go: ['github.com/gin-gonic/gin'] } },
  { id: 'echo', name: 'Echo', category: 'framework', layer: 'application', display: 'chip', description: 'Go web framework.', go: ['github.com/labstack/echo'], modules: { go: ['github.com/labstack/echo'] } },
  { id: 'fiber', name: 'Fiber', category: 'framework', layer: 'application', display: 'chip', description: 'Go web framework.', go: ['github.com/gofiber/fiber'], modules: { go: ['github.com/gofiber/fiber'] } },
  { id: 'chi', name: 'chi', category: 'framework', layer: 'application', display: 'chip', description: 'Go HTTP router.', go: ['github.com/go-chi/chi'], modules: { go: ['github.com/go-chi/chi'] } },
  { id: 'gorilla-mux', name: 'gorilla/mux', category: 'framework', layer: 'application', display: 'chip', description: 'Go HTTP router.', go: ['github.com/gorilla/mux'], modules: { go: ['github.com/gorilla/mux'] } },
  { id: 'spring-boot', name: 'Spring Boot', category: 'framework', layer: 'application', display: 'chip', description: 'Java application framework.', maven: ['org.springframework.boot:'], modules: { java: ['org.springframework.boot', 'org.springframework.web'] } },
  { id: 'rails', name: 'Ruby on Rails', category: 'framework', layer: 'application', display: 'chip', description: 'Ruby web framework.', gem: ['rails'] },
  { id: 'sinatra', name: 'Sinatra', category: 'framework', layer: 'application', display: 'chip', description: 'Ruby web DSL.', gem: ['sinatra'], modules: { ruby: ['sinatra'] } },
  { id: 'laravel', name: 'Laravel', category: 'framework', layer: 'application', display: 'chip', description: 'PHP web framework.', composer: ['laravel/framework'] },
  { id: 'symfony', name: 'Symfony', category: 'framework', layer: 'application', display: 'chip', description: 'PHP web framework.', composer: ['symfony/framework-bundle', 'symfony/http-kernel'] },
  { id: 'actix', name: 'Actix Web', category: 'framework', layer: 'application', display: 'chip', description: 'Rust web framework.', cargo: ['actix-web'], modules: { rust: ['actix_web'] } },
  { id: 'axum', name: 'Axum', category: 'framework', layer: 'application', display: 'chip', description: 'Rust web framework built on Tokio.', cargo: ['axum'], modules: { rust: ['axum'] } },
  { id: 'aspnet', name: 'ASP.NET Core', category: 'framework', layer: 'application', display: 'chip', description: '.NET web framework.', nuget: ['Microsoft.AspNetCore.'], modules: { csharp: ['Microsoft.AspNetCore'] } },

  // --- API styles --------------------------------------------------------------------------------------
  { id: 'graphql', name: 'GraphQL', category: 'api', layer: 'application', display: 'chip', description: 'Query language and runtime for APIs.', npm: ['graphql', '@apollo/server', 'apollo-server', 'graphql-yoga', 'mercurius', 'type-graphql', '@nestjs/graphql'], pypi: ['strawberry-graphql', 'graphene', 'ariadne'], modules: { python: ['strawberry', 'graphene', 'ariadne'] } },
  { id: 'grpc', name: 'gRPC', category: 'api', layer: 'application', display: 'chip', description: 'RPC framework over HTTP/2 with Protocol Buffers.', npm: ['@grpc/grpc-js', 'grpc'], pypi: ['grpcio'], go: ['google.golang.org/grpc'], cargo: ['tonic'], modules: { python: ['grpc'], go: ['google.golang.org/grpc'], rust: ['tonic'] } },
  { id: 'trpc', name: 'tRPC', category: 'api', layer: 'application', display: 'chip', description: 'End-to-end typed RPC for TypeScript.', npm: ['@trpc/server', '@trpc/client'] },
  { id: 'socketio', name: 'Socket.IO', category: 'realtime', layer: 'application', display: 'chip', description: 'Realtime bidirectional event transport.', npm: ['socket.io', 'socket.io-client'], pypi: ['python-socketio'] },
  { id: 'ws', name: 'ws (WebSocket)', category: 'realtime', layer: 'application', display: 'chip', description: 'WebSocket server and client for Node.js.', npm: ['ws'] },

  // --- ORMs and query builders -----------------------------------------------------------------------------
  {
    id: 'prisma', name: 'Prisma', category: 'orm', layer: 'application', display: 'chip', description: 'TypeScript ORM with a schema file and generated client.',
    npm: ['@prisma/client', 'prisma'],
    clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:globalForPrisma\.prisma\s*\?\?\s*)?new\s+PrismaClient\s*\(/ }, { re: /(?<name>[A-Za-z_$][\w$.]*)\s*=\s*new\s+PrismaClient\s*\(/ }],
    ops: [{ methods: 'findMany|findUnique|findFirst|findUniqueOrThrow|findFirstOrThrow|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy|\\$queryRaw|\\$executeRaw|\\$queryRawUnsafe|\\$executeRawUnsafe|\\$transaction', op: 'sql' }],
  },
  {
    id: 'drizzle', name: 'Drizzle ORM', category: 'orm', layer: 'application', display: 'chip', description: 'TypeScript SQL query builder and ORM.',
    npm: ['drizzle-orm'],
    clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*drizzle\s*\(/ }],
    ops: [{ methods: 'select|insert|update|delete|execute|transaction|findMany|findFirst', op: 'sql' }],
  },
  {
    id: 'typeorm', name: 'TypeORM', category: 'orm', layer: 'application', display: 'chip', description: 'ORM for TypeScript and JavaScript.',
    npm: ['typeorm'],
    clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*new\s+DataSource\s*\(/ }],
    ops: [{ methods: 'getRepository|query|transaction|manager|createQueryBuilder', op: 'sql' }],
  },
  { id: 'sequelize', name: 'Sequelize', category: 'orm', layer: 'application', display: 'chip', description: 'Promise-based ORM for Node.js.', npm: ['sequelize'], clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*new\s+Sequelize\s*\(/ }], ops: [{ methods: 'query|transaction|sync|define', op: 'sql' }] },
  { id: 'knex', name: 'Knex', category: 'orm', layer: 'application', display: 'chip', description: 'SQL query builder for Node.js.', npm: ['knex'], clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:knex|Knex)\s*\(/ }], ops: [{ methods: 'select|insert|update|del|delete|where|first|raw|transaction|from|into', op: 'sql' }] },
  { id: 'mikro-orm', name: 'MikroORM', category: 'orm', layer: 'application', display: 'chip', description: 'TypeScript ORM based on Data Mapper and Unit of Work.', npm: ['@mikro-orm/core'] },
  { id: 'mongoose', name: 'Mongoose', category: 'orm', layer: 'application', display: 'chip', description: 'MongoDB object modeling for Node.js.', npm: ['mongoose'], requires: [{ id: 'mongodb', reason: 'Mongoose is an object model for MongoDB and only connects to MongoDB.' }] },
  {
    id: 'sqlalchemy', name: 'SQLAlchemy', category: 'orm', layer: 'application', display: 'chip', description: 'Python SQL toolkit and ORM.',
    pypi: ['sqlalchemy', 'flask-sqlalchemy', 'sqlmodel'], modules: { python: ['sqlalchemy', 'flask_sqlalchemy', 'sqlmodel'] },
    clients: [
      { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*(?:sessionmaker|scoped_session|create_engine|create_async_engine|async_sessionmaker|SQLAlchemy)\s*\(/, langs: ['python'] },
      { re: /\b(?<name>[A-Za-z_]\w*)\s*:\s*(?:Session|AsyncSession|SessionDep|SessionLocal)\b/, langs: ['python'] },
      { re: /with\s+(?:Session|SessionLocal|session_scope|get_session)\s*\([^)]*\)\s+as\s+(?<name>[A-Za-z_]\w*)/, langs: ['python'] },
    ],
    ops: [{ methods: 'query|execute|add|add_all|commit|delete|get|scalars|scalar|merge|flush|refresh|exec', op: 'sql' }],
  },
  {
    id: 'django-orm', name: 'Django ORM', category: 'orm', layer: 'application', display: 'chip', description: "Django's built-in object-relational mapper.",
    modules: { python: ['django.db'] },
    rawOps: [{ re: /\.objects\.(?:filter|get|create|all|exclude|update|delete|bulk_create|bulk_update|get_or_create|update_or_create|count|aggregate|annotate|values|values_list|select_related|prefetch_related|first|last|raw)\s*\(/, op: 'sql', scope: 'repo', langs: ['python'] }],
  },
  { id: 'tortoise', name: 'Tortoise ORM', category: 'orm', layer: 'application', display: 'chip', description: 'Async ORM for Python.', pypi: ['tortoise-orm'], modules: { python: ['tortoise'] } },
  { id: 'peewee', name: 'Peewee', category: 'orm', layer: 'application', display: 'chip', description: 'Small Python ORM.', pypi: ['peewee'], modules: { python: ['peewee'] } },
  { id: 'alembic', name: 'Alembic', category: 'orm', layer: 'application', display: 'chip', description: 'Database migrations for SQLAlchemy.', pypi: ['alembic'], modules: { python: ['alembic'] } },
  {
    id: 'gorm', name: 'GORM', category: 'orm', layer: 'application', display: 'chip', description: 'ORM library for Go.',
    go: ['gorm.io/gorm', 'github.com/jinzhu/gorm'], modules: { go: ['gorm.io/gorm', 'github.com/jinzhu/gorm'] },
    clients: [{ re: /(?<name>[A-Za-z_]\w*)\s*,\s*\w+\s*:?=\s*gorm\.Open\s*\(/, langs: ['go'] }, { re: /\b(?<name>[A-Za-z_]\w*)\s+\*gorm\.DB\b/, langs: ['go'] }],
    ops: [{ methods: 'Where|Find|First|Create|Save|Delete|Update|Updates|Model|Raw|Exec|Preload|Transaction', op: 'sql' }],
  },
  { id: 'hibernate', name: 'Spring Data JPA', category: 'orm', layer: 'application', display: 'chip', description: 'JPA repositories on Hibernate.', maven: ['org.springframework.boot:spring-boot-starter-data-jpa', 'org.hibernate:', 'org.hibernate.orm:'], modules: { java: ['jakarta.persistence', 'javax.persistence', 'org.springframework.data.jpa'] } },
  { id: 'active-record', name: 'Active Record', category: 'orm', layer: 'application', display: 'chip', description: 'Rails ORM.', gem: ['activerecord'] },
  { id: 'diesel', name: 'Diesel', category: 'orm', layer: 'application', display: 'chip', description: 'Rust ORM and query builder.', cargo: ['diesel'], modules: { rust: ['diesel'] } },
  { id: 'sqlx', name: 'SQLx', category: 'orm', layer: 'application', display: 'chip', description: 'Async SQL toolkit.', cargo: ['sqlx'], go: ['github.com/jmoiron/sqlx'], modules: { rust: ['sqlx'], go: ['github.com/jmoiron/sqlx'] } },
  { id: 'eloquent', name: 'Eloquent', category: 'orm', layer: 'application', display: 'chip', description: 'Laravel ORM.', composer: ['illuminate/database'] },
  { id: 'ef-core', name: 'Entity Framework Core', category: 'orm', layer: 'application', display: 'chip', description: '.NET ORM.', nuget: ['Microsoft.EntityFrameworkCore'], modules: { csharp: ['Microsoft.EntityFrameworkCore'] } },

  // --- Databases ---------------------------------------------------------------------------------------------
  {
    id: 'postgresql', name: 'PostgreSQL', category: 'database', layer: 'data', description: 'Open-source relational database.',
    npm: ['pg', 'postgres', 'pg-promise', '@neondatabase/serverless', '@vercel/postgres', 'slonik', '@databases/pg'],
    pypi: ['psycopg2', 'psycopg2-binary', 'psycopg', 'asyncpg', 'pg8000'], go: ['github.com/jackc/pgx', 'github.com/lib/pq'], cargo: ['tokio-postgres', 'postgres'], gem: ['pg'], maven: ['org.postgresql:postgresql'], nuget: ['Npgsql'],
    modules: { python: ['psycopg2', 'psycopg', 'asyncpg', 'pg8000'], go: ['github.com/jackc/pgx', 'github.com/lib/pq'], java: ['org.postgresql'], rust: ['tokio_postgres', 'postgres'], csharp: ['Npgsql'] },
    images: /^(?:postgres|postgis\/postgis|bitnami\/postgresql|timescale\/timescaledb[\w-]*|supabase\/postgres|pgvector\/pgvector|ankane\/pgvector)$/,
    schemes: ['postgres', 'postgresql', 'postgresql+asyncpg', 'postgresql+psycopg2', 'postgresql+psycopg'],
    env: /^(?:POSTGRES_\w+|PG(?:HOST|USER|PASSWORD|DATABASE|PORT))$/,
    helm: /^postgresql(?:-ha)?$/,
    clients: [
      { re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*new\s+(?:pg\.)?(?:Pool|Client)\s*\(/, langs: ['js'] },
      { re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:postgres|neon|createPool)\s*\(/, langs: ['js'] },
      { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*(?:await\s+)?(?:psycopg2?\.connect|asyncpg\.(?:connect|create_pool)|psycopg\.(?:AsyncConnection\.)?connect)\s*\(/, langs: ['python'] },
      { re: /(?<name>[A-Za-z_]\w*)\s*,\s*\w+\s*:?=\s*(?:pgxpool\.(?:New|Connect)|pgx\.Connect|sql\.Open)\s*\(/, langs: ['go'] },
    ],
    ops: SQL_OPS,
    rawOps: [{ re: /\bsql\s*`/, op: 'sql', scope: 'file', langs: ['js'] }],
  },
  {
    id: 'mysql', name: 'MySQL', category: 'database', layer: 'data', description: 'Open-source relational database.',
    npm: ['mysql', 'mysql2', '@planetscale/database'], pypi: ['mysqlclient', 'pymysql', 'aiomysql', 'mysql-connector-python'], go: ['github.com/go-sql-driver/mysql'], gem: ['mysql2'], maven: ['mysql:mysql-connector-java', 'com.mysql:mysql-connector-j'],
    modules: { python: ['MySQLdb', 'pymysql', 'aiomysql', 'mysql.connector'], go: ['github.com/go-sql-driver/mysql'], java: ['com.mysql'] },
    images: /^(?:mysql|mariadb|bitnami\/mysql|bitnami\/mariadb|percona)$/, schemes: ['mysql', 'mysql+pymysql', 'mysql+aiomysql', 'mariadb'], env: /^(?:MYSQL_\w+|MARIADB_\w+)$/, helm: /^(?:mysql|mariadb)$/,
    clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?mysql\.(?:createPool|createConnection)\s*\(/, langs: ['js'] }],
    ops: SQL_OPS,
  },
  {
    id: 'sqlite', name: 'SQLite', category: 'database', layer: 'data', description: 'Embedded, file-based relational database.',
    npm: ['sqlite3', 'better-sqlite3', 'sqlite', '@libsql/client', 'node:sqlite', 'bun:sqlite'], pypi: ['aiosqlite'], go: ['github.com/mattn/go-sqlite3', 'modernc.org/sqlite'], cargo: ['rusqlite'], gem: ['sqlite3'],
    modules: { python: ['sqlite3', 'aiosqlite'], go: ['github.com/mattn/go-sqlite3', 'modernc.org/sqlite'], rust: ['rusqlite'] },
    schemes: ['sqlite', 'sqlite+aiosqlite', 'libsql', 'file'],
    clients: [
      { re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*new\s+(?:Database|DatabaseSync|sqlite3\.Database)\s*\(/, langs: ['js'] },
      { re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*createClient\s*\(\s*\{\s*url/, langs: ['js'] },
      { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*sqlite3\.connect\s*\(/, langs: ['python'] },
    ],
    ops: [...SQL_OPS, { methods: 'run|all|each|exec', op: 'sql' }],
  },
  {
    id: 'mongodb', name: 'MongoDB', category: 'database', layer: 'data', description: 'Document database.',
    npm: ['mongodb'], pypi: ['pymongo', 'motor', 'mongoengine', 'beanie'], go: ['go.mongodb.org/mongo-driver'], gem: ['mongoid', 'mongo'], maven: ['org.mongodb:', 'org.springframework.boot:spring-boot-starter-data-mongodb'],
    modules: { python: ['pymongo', 'motor', 'mongoengine', 'beanie'], go: ['go.mongodb.org/mongo-driver'], java: ['com.mongodb', 'org.springframework.data.mongodb'] },
    images: /^(?:mongo|mongodb\/mongodb-community-server|bitnami\/mongodb)$/, schemes: ['mongodb', 'mongodb+srv'], env: /^(?:MONGO(?:DB)?_\w+)$/, helm: /^mongodb$/,
    clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*new\s+MongoClient\s*\(/, langs: ['js'] }, { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*(?:pymongo\.)?(?:MongoClient|AsyncIOMotorClient)\s*\(/, langs: ['python'] }],
    ops: [{ methods: 'find|findOne|find_one|insertOne|insert_one|insertMany|insert_many|updateOne|update_one|updateMany|update_many|deleteOne|delete_one|deleteMany|delete_many|aggregate|countDocuments|count_documents|replaceOne|bulkWrite', op: 'query' }],
  },
  { id: 'cassandra', name: 'Cassandra', category: 'database', layer: 'data', description: 'Distributed wide-column database.', npm: ['cassandra-driver'], pypi: ['cassandra-driver'], images: /^(?:cassandra|bitnami\/cassandra|scylladb\/scylla)$/, schemes: ['cassandra'] },
  { id: 'dynamodb', name: 'Amazon DynamoDB', category: 'database', layer: 'data', description: 'Managed key-value and document database on AWS.', npm: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb', 'dynamoose'], terraform: /^aws_dynamodb_table$/, rawOps: [{ re: /new\s+(?:PutItemCommand|GetItemCommand|QueryCommand|ScanCommand|UpdateItemCommand|DeleteItemCommand|PutCommand|GetCommand|UpdateCommand|DeleteCommand|BatchWriteItemCommand)\s*\(/, op: 'query', scope: 'file' }, { re: /\.(?:put_item|get_item|query|scan|update_item|delete_item)\s*\(/, op: 'query', scope: 'file', langs: ['python'] }] },
  { id: 'firestore', name: 'Cloud Firestore', category: 'database', layer: 'data', description: 'Managed document database on Google Cloud / Firebase.', npm: ['@google-cloud/firestore'], pypi: ['google-cloud-firestore'], modules: { python: ['google.cloud.firestore'] } },
  { id: 'neo4j', name: 'Neo4j', category: 'database', layer: 'data', description: 'Graph database.', npm: ['neo4j-driver'], pypi: ['neo4j'], images: /^neo4j$/, schemes: ['neo4j', 'bolt'] },
  { id: 'clickhouse', name: 'ClickHouse', category: 'database', layer: 'data', description: 'Column-oriented analytics database.', npm: ['@clickhouse/client'], pypi: ['clickhouse-connect', 'clickhouse-driver'], images: /^(?:clickhouse\/clickhouse-server|yandex\/clickhouse-server)$/, schemes: ['clickhouse'] },
  { id: 'influxdb', name: 'InfluxDB', category: 'database', layer: 'data', description: 'Time-series database.', npm: ['@influxdata/influxdb-client'], pypi: ['influxdb-client'], images: /^influxdb$/ },
  { id: 'supabase', name: 'Supabase', category: 'service', layer: 'external', description: 'Hosted Postgres with auth, storage and realtime APIs.', npm: ['@supabase/supabase-js', '@supabase/ssr', '@supabase/auth-helpers-nextjs'], pypi: ['supabase'], modules: { python: ['supabase'] }, env: /^(?:NEXT_PUBLIC_)?SUPABASE_\w+$/, clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?create(?:Browser|Server|Route\w*|Server\w*)?Client\s*\(/, langs: ['js'] }], ops: [{ methods: 'from|rpc|select|insert|update|upsert|delete', op: 'query' }, { methods: 'auth\\.\\w+', op: 'auth' }] },
  { id: 'firebase', name: 'Firebase', category: 'service', layer: 'external', description: 'Google app platform: auth, Firestore, storage, hosting.', npm: ['firebase', 'firebase-admin'], pypi: ['firebase-admin'], modules: { python: ['firebase_admin'] } },
  { id: 'planetscale', name: 'PlanetScale', category: 'database', layer: 'data', description: 'Serverless MySQL platform.', npm: ['@planetscale/database'] },

  // --- Caches -----------------------------------------------------------------------------------------------
  {
    id: 'redis', name: 'Redis', category: 'cache', layer: 'data', description: 'In-memory data store used as a cache, message broker and queue backend.',
    npm: ['redis', 'ioredis', '@upstash/redis', '@vercel/kv', '@redis/client'], pypi: ['redis', 'aioredis', 'redis-py-cluster', 'django-redis'], go: ['github.com/redis/go-redis', 'github.com/go-redis/redis', 'github.com/gomodule/redigo'], cargo: ['redis'], gem: ['redis'], composer: ['predis/predis'], maven: ['redis.clients:jedis', 'io.lettuce:lettuce-core', 'org.springframework.boot:spring-boot-starter-data-redis'], nuget: ['StackExchange.Redis'],
    modules: { python: ['redis', 'aioredis', 'django_redis'], go: ['github.com/redis/go-redis', 'github.com/go-redis/redis', 'github.com/gomodule/redigo'], java: ['redis.clients.jedis', 'io.lettuce', 'org.springframework.data.redis'], ruby: ['redis'], php: ['Predis'], rust: ['redis'], csharp: ['StackExchange.Redis'] },
    images: /^(?:redis|redis\/redis-stack|redis\/redis-stack-server|bitnami\/redis|valkey\/valkey|eqalpha\/keydb|docker\.dragonflydb\.io\/dragonflydb\/dragonfly)$/,
    schemes: ['redis', 'rediss'], env: /^(?:REDIS_\w+|UPSTASH_REDIS_\w+|KV_(?:URL|REST_API_URL|REST_API_TOKEN))$/, terraform: /^aws_elasticache_(?:cluster|replication_group)$|^google_redis_instance$|^azurerm_redis_cache$/, helm: /^redis(?:-cluster)?$/,
    clients: [
      { re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*new\s+(?:Redis|IORedis|Redis\.Cluster)\s*\(/, langs: ['js'] },
      { re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:await\s+)?(?:createClient|createCluster|Redis\.fromEnv)\s*\(/, langs: ['js'] },
      { re: /(?<name>[A-Za-z_$][\w$.]*)\s*=\s*new\s+(?:Redis|IORedis)\s*\(/, langs: ['js'] },
      { re: /(?<name>[A-Za-z_][\w.]*)\s*(?::\s*[\w.\[\]]+\s*)?=\s*(?:await\s+)?(?:aio)?redis\.(?:asyncio\.)?(?:Redis|StrictRedis|from_url|Redis\.from_url|StrictRedis\.from_url|ConnectionPool)\s*\(/, langs: ['python'] },
      { re: /(?<name>[A-Za-z_][\w.]*)\s*(?::\s*[\w.\[\]]+\s*)?=\s*(?:Redis|StrictRedis)(?:\.from_url)?\s*\(/, langs: ['python'] },
      { re: /(?<name>[A-Za-z_]\w*)\s*:?=\s*redis\.New(?:Client|ClusterClient)\s*\(/, langs: ['go'] },
    ],
    ops: [
      ...REDIS_OPS,
      { methods: 'Get|MGet|HGet|HGetAll|Exists|TTL|SMembers|ZRange|LRange', op: 'cache-read' },
      { methods: 'Set|SetEX|SetNX|MSet|HSet|Incr|IncrBy|Expire|LPush|RPush|SAdd|ZAdd', op: 'cache-write' },
      { methods: 'Del|Unlink|HDel', op: 'cache-delete' },
      { methods: 'Publish', op: 'publish' },
      { methods: 'Subscribe|PSubscribe', op: 'consume' },
    ],
  },
  { id: 'memcached', name: 'Memcached', category: 'cache', layer: 'data', description: 'In-memory key-value cache.', npm: ['memcached', 'memjs'], pypi: ['pymemcache', 'python-memcached', 'pylibmc'], images: /^(?:memcached|bitnami\/memcached)$/, schemes: ['memcached'], modules: { python: ['pymemcache', 'memcache', 'pylibmc'] }, ops: [{ methods: 'get|get_many|get_multi', op: 'cache-read' }, { methods: 'set|set_many|set_multi|add|replace|incr|touch', op: 'cache-write' }, { methods: 'delete|delete_many', op: 'cache-delete' }] },

  // --- Search -----------------------------------------------------------------------------------------------
  { id: 'elasticsearch', name: 'Elasticsearch', category: 'search', layer: 'data', description: 'Distributed search and analytics engine.', npm: ['@elastic/elasticsearch'], pypi: ['elasticsearch'], go: ['github.com/elastic/go-elasticsearch'], modules: { python: ['elasticsearch'] }, images: /^(?:elasticsearch|docker\.elastic\.co\/elasticsearch\/elasticsearch|bitnami\/elasticsearch)$/, env: /^(?:ELASTIC(?:SEARCH)?_\w+)$/, clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*new\s+Client\s*\(\s*\{\s*node/, langs: ['js'] }, { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*(?:Async)?Elasticsearch\s*\(/, langs: ['python'] }], ops: [{ methods: 'search|msearch|count', op: 'search' }, { methods: 'index|bulk|update|delete', op: 'search' }] },
  { id: 'opensearch', name: 'OpenSearch', category: 'search', layer: 'data', description: 'Open-source search and analytics suite.', npm: ['@opensearch-project/opensearch'], pypi: ['opensearch-py'], images: /^opensearchproject\/opensearch$/ },
  { id: 'meilisearch', name: 'Meilisearch', category: 'search', layer: 'data', description: 'Search engine with typo tolerance.', npm: ['meilisearch'], pypi: ['meilisearch'], images: /^getmeili\/meilisearch$/ },
  { id: 'typesense', name: 'Typesense', category: 'search', layer: 'data', description: 'Open-source search engine.', npm: ['typesense'], pypi: ['typesense'], images: /^typesense\/typesense$/ },
  { id: 'algolia', name: 'Algolia', category: 'search', layer: 'external', description: 'Hosted search API.', npm: ['algoliasearch'], pypi: ['algoliasearch'], env: /^(?:NEXT_PUBLIC_)?ALGOLIA_\w+$/, ops: [{ methods: 'search|saveObjects|saveObject|partialUpdateObjects|deleteObject', op: 'search' }] },

  // --- Object storage ---------------------------------------------------------------------------------------------
  {
    id: 's3', name: 'Amazon S3', category: 'storage', layer: 'data', description: 'Object storage on AWS.',
    npm: ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner', '@aws-sdk/lib-storage'], maven: ['software.amazon.awssdk:s3', 'com.amazonaws:aws-java-sdk-s3'], go: ['github.com/aws/aws-sdk-go-v2/service/s3'],
    modules: { go: ['github.com/aws/aws-sdk-go-v2/service/s3'], java: ['software.amazon.awssdk.services.s3', 'com.amazonaws.services.s3'] },
    terraform: /^aws_s3_bucket$/, env: /^(?:AWS_S3_\w+|S3_\w+)$/,
    clients: [
      { re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*new\s+(?:S3Client|S3|AWS\.S3)\s*\(/, langs: ['js'] },
      { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*(?:boto3|session|self\.session|aioboto3\.Session\(\))\.(?:client|resource)\s*\(\s*["']s3["']/, langs: ['python'] },
    ],
    ops: [{ methods: S3_WRITE, op: 'object-write' }, { methods: S3_READ, op: 'object-read' }],
    rawOps: [{ re: /new\s+(?:PutObjectCommand|UploadPartCommand|CopyObjectCommand|DeleteObjectCommand|CreateMultipartUploadCommand)\s*\(/, op: 'object-write', scope: 'file' }, { re: /new\s+(?:GetObjectCommand|HeadObjectCommand|ListObjectsV2Command)\s*\(/, op: 'object-read', scope: 'file' }],
  },
  { id: 'gcs', name: 'Google Cloud Storage', category: 'storage', layer: 'data', description: 'Object storage on Google Cloud.', npm: ['@google-cloud/storage'], pypi: ['google-cloud-storage'], modules: { python: ['google.cloud.storage'] }, terraform: /^google_storage_bucket$/, clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*new\s+Storage\s*\(/, langs: ['js'] }, { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*storage\.Client\s*\(/, langs: ['python'] }], ops: [{ methods: 'upload|save|upload_from_string|upload_from_filename|createWriteStream', op: 'object-write' }, { methods: 'download|download_as_bytes|download_as_text|createReadStream|getSignedUrl|generate_signed_url', op: 'object-read' }] },
  { id: 'azure-blob', name: 'Azure Blob Storage', category: 'storage', layer: 'data', description: 'Object storage on Azure.', npm: ['@azure/storage-blob'], pypi: ['azure-storage-blob'], modules: { python: ['azure.storage.blob'] }, terraform: /^azurerm_storage_(?:account|container)$/ },
  { id: 'minio', name: 'MinIO', category: 'storage', layer: 'data', description: 'S3-compatible object storage server.', npm: ['minio'], pypi: ['minio'], images: /^(?:minio\/minio|bitnami\/minio|quay\.io\/minio\/minio)$/, modules: { python: ['minio'] } },
  { id: 'cloudinary', name: 'Cloudinary', category: 'storage', layer: 'external', description: 'Hosted media storage and transformation.', npm: ['cloudinary', 'next-cloudinary'], pypi: ['cloudinary'] },
  { id: 'uploadthing', name: 'UploadThing', category: 'storage', layer: 'external', description: 'Hosted file uploads for TypeScript apps.', npm: ['uploadthing', '@uploadthing/react'] },

  // --- Queues and workers ----------------------------------------------------------------------------------------
  {
    id: 'kafka', name: 'Apache Kafka', category: 'queue', layer: 'async', description: 'Distributed event streaming platform.',
    npm: ['kafkajs', 'node-rdkafka', '@confluentinc/kafka-javascript'], pypi: ['kafka-python', 'confluent-kafka', 'aiokafka'], go: ['github.com/segmentio/kafka-go', 'github.com/Shopify/sarama', 'github.com/IBM/sarama', 'github.com/confluentinc/confluent-kafka-go'], cargo: ['rdkafka'], maven: ['org.apache.kafka:', 'org.springframework.kafka:'],
    modules: { python: ['kafka', 'confluent_kafka', 'aiokafka'], go: ['github.com/segmentio/kafka-go', 'github.com/Shopify/sarama', 'github.com/IBM/sarama', 'github.com/confluentinc/confluent-kafka-go'], java: ['org.apache.kafka', 'org.springframework.kafka'], rust: ['rdkafka'] },
    images: /^(?:confluentinc\/cp-kafka|confluentinc\/cp-server|bitnami\/kafka|apache\/kafka|wurstmeister\/kafka|redpandadata\/redpanda|vectorized\/redpanda)$/, schemes: ['kafka'], env: /^(?:KAFKA_\w+)$/, terraform: /^aws_msk_cluster$/, helm: /^kafka$/,
    clients: [
      { re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:\w+)\.producer\s*\(/, langs: ['js'] },
      { re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:\w+)\.consumer\s*\(/, langs: ['js'] },
      { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*(?:AIOKafkaProducer|KafkaProducer|Producer)\s*\(/, langs: ['python'] },
      { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*(?:AIOKafkaConsumer|KafkaConsumer|Consumer)\s*\(\s*(?:["'](?<arg>[\w.-]+)["'])?/, langs: ['python'] },
    ],
    ops: [{ methods: 'send|send_and_wait|produce|sendBatch|WriteMessages', op: 'publish' }, { methods: 'subscribe|run|poll|consume|ReadMessage|FetchMessage', op: 'consume' }],
  },
  {
    id: 'rabbitmq', name: 'RabbitMQ', category: 'queue', layer: 'async', description: 'Message broker implementing AMQP.',
    npm: ['amqplib', 'amqp-connection-manager', '@golevelup/nestjs-rabbitmq'], pypi: ['pika', 'aio-pika', 'kombu'], go: ['github.com/streadway/amqp', 'github.com/rabbitmq/amqp091-go'], gem: ['bunny'], maven: ['com.rabbitmq:amqp-client', 'org.springframework.boot:spring-boot-starter-amqp'],
    modules: { python: ['pika', 'aio_pika'], go: ['github.com/streadway/amqp', 'github.com/rabbitmq/amqp091-go'], java: ['com.rabbitmq', 'org.springframework.amqp'] },
    images: /^(?:rabbitmq|bitnami\/rabbitmq)$/, schemes: ['amqp', 'amqps'], env: /^(?:RABBITMQ_\w+|AMQP_\w+)$/, terraform: /^aws_mq_broker$/, helm: /^rabbitmq$/,
    ops: [{ methods: 'sendToQueue|publish|basic_publish|Publish|PublishWithContext', op: 'publish' }, { methods: 'consume|basic_consume|Consume|get', op: 'consume' }],
    clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*await\s+\w+\.createChannel\s*\(/, langs: ['js'] }, { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*\w+\.channel\s*\(/, langs: ['python'] }],
  },
  { id: 'sqs', name: 'Amazon SQS', category: 'queue', layer: 'async', description: 'Managed message queue on AWS.', npm: ['@aws-sdk/client-sqs', 'sqs-consumer'], terraform: /^aws_sqs_queue$/, env: /^(?:\w*SQS_\w+)$/, rawOps: [{ re: /new\s+(?:SendMessageCommand|SendMessageBatchCommand)\s*\(/, op: 'publish', scope: 'file' }, { re: /new\s+ReceiveMessageCommand\s*\(|Consumer\.create\s*\(/, op: 'consume', scope: 'file' }, { re: /\.send_message(?:_batch)?\s*\(/, op: 'publish', scope: 'file', langs: ['python'] }, { re: /\.receive_message\s*\(/, op: 'consume', scope: 'file', langs: ['python'] }] },
  { id: 'sns', name: 'Amazon SNS', category: 'queue', layer: 'async', description: 'Managed pub/sub messaging on AWS.', npm: ['@aws-sdk/client-sns'], terraform: /^aws_sns_topic$/, rawOps: [{ re: /new\s+PublishCommand\s*\(/, op: 'publish', scope: 'file' }] },
  { id: 'gcp-pubsub', name: 'Google Pub/Sub', category: 'queue', layer: 'async', description: 'Managed messaging on Google Cloud.', npm: ['@google-cloud/pubsub'], pypi: ['google-cloud-pubsub'], modules: { python: ['google.cloud.pubsub', 'google.cloud.pubsub_v1'] }, terraform: /^google_pubsub_(?:topic|subscription)$/, ops: [{ methods: 'publish|publishMessage', op: 'publish' }, { methods: 'subscribe', op: 'consume' }] },
  { id: 'nats', name: 'NATS', category: 'queue', layer: 'async', description: 'Messaging system for pub/sub and request/reply.', npm: ['nats'], pypi: ['nats-py'], go: ['github.com/nats-io/nats.go'], modules: { python: ['nats'], go: ['github.com/nats-io/nats.go'] }, images: /^(?:nats|bitnami\/nats)$/, schemes: ['nats'], ops: [{ methods: 'publish|Publish|request|Request', op: 'publish' }, { methods: 'subscribe|Subscribe|QueueSubscribe', op: 'consume' }] },
  {
    id: 'celery', name: 'Celery', category: 'worker', layer: 'async', display: 'chip', description: 'Distributed task queue for Python; tasks run in separate worker processes.',
    pypi: ['celery'], modules: { python: ['celery'] }, env: /^CELERY_\w+$/,
    clients: [{ re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*Celery\s*\(\s*(?:["'](?<arg>[\w.-]+)["'])?/, langs: ['python'] }],
  },
  { id: 'rq', name: 'RQ', category: 'worker', layer: 'async', display: 'chip', description: 'Redis-backed job queue for Python.', pypi: ['rq'], modules: { python: ['rq'] }, requires: [{ id: 'redis', reason: 'RQ stores jobs in Redis by design.' }], clients: [{ re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*Queue\s*\(/, langs: ['python'] }], ops: [{ methods: 'enqueue|enqueue_call|enqueue_in|enqueue_at', op: 'enqueue' }] },
  { id: 'dramatiq', name: 'Dramatiq', category: 'worker', layer: 'async', display: 'chip', description: 'Background task processing for Python.', pypi: ['dramatiq'], modules: { python: ['dramatiq'] } },
  { id: 'arq', name: 'arq', category: 'worker', layer: 'async', display: 'chip', description: 'Async job queue for Python on Redis.', pypi: ['arq'], modules: { python: ['arq'] }, requires: [{ id: 'redis', reason: 'arq stores jobs in Redis by design.' }] },
  {
    id: 'bullmq', name: 'BullMQ', category: 'worker', layer: 'async', display: 'chip', description: 'Redis-backed job queue for Node.js.',
    npm: ['bullmq', 'bull', 'bee-queue', '@nestjs/bull', '@nestjs/bullmq'], requires: [{ id: 'redis', reason: 'BullMQ/Bull store jobs in Redis by design.' }],
    clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*new\s+(?:Queue|Bull)\s*(?:<[^>]*>)?\s*\(\s*(?:["'`](?<arg>[\w:.-]+)["'`])?/, langs: ['js'] }],
    ops: [{ methods: 'add|addBulk', op: 'enqueue' }, { methods: 'process', op: 'consume' }],
  },
  { id: 'sidekiq', name: 'Sidekiq', category: 'worker', layer: 'async', display: 'chip', description: 'Background jobs for Ruby on Redis.', gem: ['sidekiq'], requires: [{ id: 'redis', reason: 'Sidekiq stores jobs in Redis by design.' }] },
  { id: 'inngest', name: 'Inngest', category: 'worker', layer: 'external', description: 'Hosted event-driven background functions.', npm: ['inngest'] },
  { id: 'trigger-dev', name: 'Trigger.dev', category: 'worker', layer: 'external', description: 'Hosted background jobs for TypeScript.', npm: ['@trigger.dev/sdk'] },
  { id: 'temporal', name: 'Temporal', category: 'worker', layer: 'async', description: 'Durable workflow orchestration.', npm: ['@temporalio/client', '@temporalio/worker'], pypi: ['temporalio'], go: ['go.temporal.io/sdk'], images: /^temporalio\/(?:auto-setup|server)$/ },

  // --- Auth ------------------------------------------------------------------------------------------------------
  { id: 'nextauth', name: 'Auth.js (NextAuth)', category: 'auth', layer: 'application', display: 'chip', description: 'Authentication library for Next.js and other frameworks.', npm: ['next-auth', '@auth/core', '@auth/nextjs', '@auth/prisma-adapter', '@next-auth/prisma-adapter'], rawOps: [{ re: /\b(?:getServerSession|auth)\s*\(\s*(?:authOptions|\))/, op: 'auth', scope: 'file' }] },
  { id: 'passport', name: 'Passport', category: 'auth', layer: 'application', display: 'chip', description: 'Authentication middleware for Node.js with pluggable strategies.', npm: ['passport'], rawOps: [{ re: /passport\.authenticate\s*\(/, op: 'auth', scope: 'file' }] },
  { id: 'jwt', name: 'JSON Web Tokens', category: 'auth', layer: 'application', display: 'chip', description: 'Signed tokens for stateless authentication.', npm: ['jsonwebtoken', 'jose', '@nestjs/jwt', 'express-jwt'], pypi: ['pyjwt', 'python-jose', 'fastapi-jwt-auth', 'djangorestframework-simplejwt', 'flask-jwt-extended'], go: ['github.com/golang-jwt/jwt'], modules: { python: ['jwt', 'jose', 'flask_jwt_extended', 'rest_framework_simplejwt'], go: ['github.com/golang-jwt/jwt'] }, rawOps: [{ re: /\bjwt\.(?:sign|verify|encode|decode)\s*\(|\bjwtVerify\s*\(|new\s+SignJWT\s*\(/, op: 'auth', scope: 'file' }] },
  { id: 'bcrypt', name: 'bcrypt', category: 'auth', layer: 'application', display: 'chip', description: 'Password hashing.', npm: ['bcrypt', 'bcryptjs'], pypi: ['bcrypt', 'passlib'], modules: { python: ['bcrypt', 'passlib'] } },
  { id: 'lucia', name: 'Lucia', category: 'auth', layer: 'application', display: 'chip', description: 'Session-based auth library.', npm: ['lucia'] },
  { id: 'better-auth', name: 'Better Auth', category: 'auth', layer: 'application', display: 'chip', description: 'TypeScript authentication framework.', npm: ['better-auth'] },
  { id: 'devise', name: 'Devise', category: 'auth', layer: 'application', display: 'chip', description: 'Authentication for Rails.', gem: ['devise'] },
  { id: 'spring-security', name: 'Spring Security', category: 'auth', layer: 'application', display: 'chip', description: 'Authentication and authorization for Spring.', maven: ['org.springframework.boot:spring-boot-starter-security', 'org.springframework.security:'], modules: { java: ['org.springframework.security'] } },
  { id: 'clerk', name: 'Clerk', category: 'auth', layer: 'external', description: 'Hosted authentication and user management.', npm: ['@clerk/nextjs', '@clerk/clerk-react', '@clerk/express', '@clerk/backend', '@clerk/clerk-sdk-node'], env: /^(?:NEXT_PUBLIC_)?CLERK_\w+$/, rawOps: [{ re: /\b(?:auth|currentUser|clerkClient)\s*\(/, op: 'auth', scope: 'file' }] },
  { id: 'auth0', name: 'Auth0', category: 'auth', layer: 'external', description: 'Hosted identity platform.', npm: ['@auth0/nextjs-auth0', '@auth0/auth0-react', 'auth0', 'express-openid-connect'], pypi: ['auth0-python'], env: /^AUTH0_\w+$/ },
  { id: 'cognito', name: 'Amazon Cognito', category: 'auth', layer: 'external', description: 'Managed user pools and identity on AWS.', npm: ['@aws-sdk/client-cognito-identity-provider', 'amazon-cognito-identity-js'], terraform: /^aws_cognito_user_pool$/ },
  { id: 'oauth-github', name: 'GitHub OAuth', category: 'auth', layer: 'external', description: 'Sign-in with GitHub accounts via OAuth.', npm: ['next-auth/providers/github', '@auth/core/providers/github', 'passport-github', 'passport-github2'] },
  { id: 'oauth-google', name: 'Google OAuth', category: 'auth', layer: 'external', description: 'Sign-in with Google accounts via OAuth / OpenID Connect.', npm: ['next-auth/providers/google', '@auth/core/providers/google', 'passport-google-oauth20', 'google-auth-library'], pypi: ['google-auth'] },

  // --- Payments / communication / AI / SaaS -----------------------------------------------------------------------------
  {
    id: 'stripe', name: 'Stripe', category: 'payments', layer: 'external', description: 'Payments API.',
    npm: ['stripe', '@stripe/stripe-js', '@stripe/react-stripe-js'], pypi: ['stripe'], go: ['github.com/stripe/stripe-go'], gem: ['stripe'], composer: ['stripe/stripe-php'], maven: ['com.stripe:stripe-java'],
    modules: { python: ['stripe'], go: ['github.com/stripe/stripe-go'], java: ['com.stripe'], php: ['Stripe'] }, env: /^(?:NEXT_PUBLIC_)?STRIPE_\w+$/,
    moduleOps: true,
    clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*new\s+Stripe\s*\(/, langs: ['js'] }, { re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?loadStripe\s*\(/, langs: ['js'] }],
    ops: [{ methods: 'create|retrieve|update|list|cancel|confirm|capture|del|redirectToCheckout|confirmPayment|confirmCardPayment', op: 'payment' }, { methods: 'constructEvent|construct_event', op: 'webhook' }],
  },
  { id: 'paypal', name: 'PayPal', category: 'payments', layer: 'external', description: 'Payments API.', npm: ['@paypal/checkout-server-sdk', '@paypal/react-paypal-js'], pypi: ['paypalrestsdk'] },
  { id: 'lemonsqueezy', name: 'Lemon Squeezy', category: 'payments', layer: 'external', description: 'Payments and subscriptions platform.', npm: ['@lemonsqueezy/lemonsqueezy.js'] },
  { id: 'twilio', name: 'Twilio', category: 'messaging', layer: 'external', description: 'SMS, voice and messaging API.', npm: ['twilio'], pypi: ['twilio'], modules: { python: ['twilio'] }, env: /^TWILIO_\w+$/, clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:twilio|Twilio)\s*\(/, langs: ['js'] }, { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*Client\s*\(\s*(?:account_sid|os\.)/, langs: ['python'] }], ops: [{ methods: 'create', op: 'send' }] },
  { id: 'sendgrid', name: 'SendGrid', category: 'email', layer: 'external', description: 'Email delivery API.', npm: ['@sendgrid/mail'], pypi: ['sendgrid'], modules: { python: ['sendgrid'] }, env: /^SENDGRID_\w+$/, moduleOps: true, ops: [{ methods: 'send|sendMultiple', op: 'email' }] },
  { id: 'resend', name: 'Resend', category: 'email', layer: 'external', description: 'Email delivery API.', npm: ['resend'], pypi: ['resend'], env: /^RESEND_\w+$/, clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*new\s+Resend\s*\(/, langs: ['js'] }], ops: [{ methods: 'send|create', op: 'email' }] },
  { id: 'postmark', name: 'Postmark', category: 'email', layer: 'external', description: 'Transactional email API.', npm: ['postmark'], pypi: ['postmarker'] },
  { id: 'mailgun', name: 'Mailgun', category: 'email', layer: 'external', description: 'Email delivery API.', npm: ['mailgun.js', 'mailgun-js'], env: /^MAILGUN_\w+$/ },
  { id: 'ses', name: 'Amazon SES', category: 'email', layer: 'external', description: 'Email sending on AWS.', npm: ['@aws-sdk/client-ses', '@aws-sdk/client-sesv2'], terraform: /^aws_ses_\w+$/, rawOps: [{ re: /new\s+Send(?:Raw)?EmailCommand\s*\(/, op: 'email', scope: 'file' }] },
  { id: 'smtp', name: 'SMTP', category: 'email', layer: 'external', description: 'Email sent over SMTP.', npm: ['nodemailer'], pypi: ['aiosmtplib', 'fastapi-mail', 'flask-mail'], modules: { python: ['smtplib', 'aiosmtplib', 'fastapi_mail', 'flask_mail'] }, env: /^(?:SMTP_\w+|EMAIL_HOST\w*|MAIL_(?:HOST|SERVER|PORT)\w*)$/, images: /^(?:mailhog\/mailhog|axllent\/mailpit|maildev\/maildev)$/, clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*nodemailer\.createTransport\s*\(/, langs: ['js'] }, { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*smtplib\.SMTP(?:_SSL)?\s*\(/, langs: ['python'] }, { re: /with\s+smtplib\.SMTP(?:_SSL)?\s*\([^)]*\)\s+as\s+(?<name>[A-Za-z_]\w*)/, langs: ['python'] }], ops: [{ methods: 'sendMail|sendmail|send_message', op: 'email' }] },
  { id: 'slack', name: 'Slack API', category: 'messaging', layer: 'external', description: 'Slack messaging and bot APIs.', npm: ['@slack/web-api', '@slack/bolt'], pypi: ['slack-sdk', 'slack-bolt'], modules: { python: ['slack_sdk', 'slack_bolt'] }, env: /^SLACK_\w+$/ },
  { id: 'pusher', name: 'Pusher', category: 'realtime', layer: 'external', description: 'Hosted realtime messaging channels.', npm: ['pusher', 'pusher-js'], pypi: ['pusher'], env: /^(?:NEXT_PUBLIC_)?PUSHER_\w+$/ },
  { id: 'ably', name: 'Ably', category: 'realtime', layer: 'external', description: 'Hosted realtime messaging.', npm: ['ably'], pypi: ['ably'] },
  {
    id: 'openai', name: 'OpenAI API', category: 'ai', layer: 'external', description: 'Hosted large language model and embeddings API.',
    npm: ['openai', '@ai-sdk/openai'], pypi: ['openai', 'langchain-openai'], modules: { python: ['openai', 'langchain_openai'] }, env: /^OPENAI_\w+$/,
    moduleOps: true,
    clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*new\s+OpenAI\s*\(/, langs: ['js'] }, { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*(?:Async)?OpenAI\s*\(/, langs: ['python'] }],
    ops: [{ methods: 'create|stream|parse', op: 'ai' }],
  },
  {
    id: 'anthropic', name: 'Anthropic API', category: 'ai', layer: 'external', description: 'Hosted Claude large language model API.',
    npm: ['@anthropic-ai/sdk', '@ai-sdk/anthropic'], pypi: ['anthropic', 'langchain-anthropic'], modules: { python: ['anthropic', 'langchain_anthropic'] }, env: /^ANTHROPIC_\w+$/,
    clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*new\s+Anthropic\s*\(/, langs: ['js'] }, { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*(?:Async)?Anthropic\s*\(/, langs: ['python'] }],
    ops: [{ methods: 'create|stream|countTokens|count_tokens', op: 'ai' }],
  },
  { id: 'gemini', name: 'Google Gemini API', category: 'ai', layer: 'external', description: 'Hosted Gemini model API.', npm: ['@google/generative-ai', '@google/genai', '@ai-sdk/google'], pypi: ['google-generativeai', 'google-genai'], modules: { python: ['google.generativeai', 'google.genai'] } },
  { id: 'vercel-ai', name: 'Vercel AI SDK', category: 'ai', layer: 'application', display: 'chip', description: 'TypeScript toolkit for building AI features.', npm: ['ai'] },
  { id: 'langchain', name: 'LangChain', category: 'ai', layer: 'application', display: 'chip', description: 'Framework for LLM applications.', npm: ['langchain', '@langchain/core'], pypi: ['langchain', 'langchain-core'], modules: { python: ['langchain', 'langchain_core'] } },
  { id: 'pinecone', name: 'Pinecone', category: 'database', layer: 'external', description: 'Hosted vector database.', npm: ['@pinecone-database/pinecone'], pypi: ['pinecone-client', 'pinecone'], modules: { python: ['pinecone'] } },
  { id: 'qdrant', name: 'Qdrant', category: 'database', layer: 'data', description: 'Vector database.', npm: ['@qdrant/js-client-rest'], pypi: ['qdrant-client'], images: /^qdrant\/qdrant$/, modules: { python: ['qdrant_client'] } },

  // --- Observability / analytics --------------------------------------------------------------------------------------------
  { id: 'sentry', name: 'Sentry', category: 'observability', layer: 'external', description: 'Error tracking and performance monitoring.', npm: ['@sentry/'], pypi: ['sentry-sdk'], go: ['github.com/getsentry/sentry-go'], gem: ['sentry-ruby'], modules: { python: ['sentry_sdk'], go: ['github.com/getsentry/sentry-go'] }, env: /^(?:NEXT_PUBLIC_)?SENTRY_\w+$/ },
  { id: 'datadog', name: 'Datadog', category: 'observability', layer: 'external', description: 'Monitoring, APM and logs.', npm: ['dd-trace', '@datadog/browser-rum'], pypi: ['ddtrace', 'datadog'], images: /^(?:datadog\/agent|gcr\.io\/datadoghq\/agent)$/, env: /^DD_\w+$/ },
  { id: 'opentelemetry', name: 'OpenTelemetry', category: 'observability', layer: 'external', description: 'Vendor-neutral tracing and metrics instrumentation.', npm: ['@opentelemetry/'], pypi: ['opentelemetry-api', 'opentelemetry-sdk'], modules: { python: ['opentelemetry'] }, images: /^otel\/opentelemetry-collector(?:-contrib)?$/, env: /^OTEL_\w+$/ },
  { id: 'prometheus', name: 'Prometheus', category: 'observability', layer: 'external', description: 'Metrics collection and alerting.', npm: ['prom-client'], pypi: ['prometheus-client', 'prometheus-fastapi-instrumentator'], modules: { python: ['prometheus_client'] }, images: /^(?:prom\/prometheus|bitnami\/prometheus)$/ },
  { id: 'grafana', name: 'Grafana', category: 'observability', layer: 'external', description: 'Dashboards for metrics and logs.', images: /^grafana\/grafana(?:-oss)?$/ },
  { id: 'posthog', name: 'PostHog', category: 'analytics', layer: 'external', description: 'Product analytics.', npm: ['posthog-js', 'posthog-node'], pypi: ['posthog'], env: /^(?:NEXT_PUBLIC_)?POSTHOG_\w+$/ },
  { id: 'segment', name: 'Segment', category: 'analytics', layer: 'external', description: 'Customer data pipeline.', npm: ['@segment/analytics-next', 'analytics-node', '@segment/analytics-node'] },
  { id: 'vercel-analytics', name: 'Vercel Analytics', category: 'analytics', layer: 'external', description: 'Web analytics from Vercel.', npm: ['@vercel/analytics', '@vercel/speed-insights'] },

  // --- HTTP clients ------------------------------------------------------------------------------------------------------
  { id: 'axios', name: 'axios', category: 'http-client', layer: 'application', display: 'chip', description: 'Promise-based HTTP client.', npm: ['axios'], moduleOps: true, clients: [{ re: /(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*axios\.create\s*\(/, langs: ['js'] }], ops: HTTP_OPS },
  { id: 'requests', name: 'Requests', category: 'http-client', layer: 'application', display: 'chip', description: 'HTTP library for Python.', pypi: ['requests'], modules: { python: ['requests'] }, moduleOps: true, clients: [{ re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*requests\.Session\s*\(/, langs: ['python'] }], ops: HTTP_OPS },
  { id: 'httpx', name: 'HTTPX', category: 'http-client', layer: 'application', display: 'chip', description: 'HTTP client for Python with async support.', pypi: ['httpx'], modules: { python: ['httpx'] }, moduleOps: true, clients: [{ re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*httpx\.(?:Async)?Client\s*\(/, langs: ['python'] }, { re: /with\s+httpx\.(?:Async)?Client\s*\([^)]*\)\s+as\s+(?<name>[A-Za-z_]\w*)/, langs: ['python'] }], ops: HTTP_OPS },
  { id: 'aiohttp', name: 'aiohttp', category: 'http-client', layer: 'application', display: 'chip', description: 'Async HTTP client/server for Python.', pypi: ['aiohttp'], modules: { python: ['aiohttp'] }, clients: [{ re: /with\s+aiohttp\.ClientSession\s*\([^)]*\)\s+as\s+(?<name>[A-Za-z_]\w*)/, langs: ['python'] }, { re: /(?<name>[A-Za-z_][\w.]*)\s*=\s*aiohttp\.ClientSession\s*\(/, langs: ['python'] }], ops: HTTP_OPS },
  { id: 'got', name: 'got', category: 'http-client', layer: 'application', display: 'chip', description: 'HTTP client for Node.js.', npm: ['got'], moduleOps: true, ops: HTTP_OPS },
  { id: 'node-fetch', name: 'node-fetch', category: 'http-client', layer: 'application', display: 'chip', description: 'Fetch API implementation for Node.js.', npm: ['node-fetch', 'cross-fetch', 'isomorphic-fetch'] },
  { id: 'undici', name: 'undici', category: 'http-client', layer: 'application', display: 'chip', description: 'HTTP/1.1 client for Node.js.', npm: ['undici'] },
  { id: 'ky', name: 'ky', category: 'http-client', layer: 'application', display: 'chip', description: 'Fetch-based HTTP client.', npm: ['ky'], moduleOps: true, ops: HTTP_OPS },
  { id: 'superagent', name: 'SuperAgent', category: 'http-client', layer: 'application', display: 'chip', description: 'HTTP client for Node.js and browsers.', npm: ['superagent'], moduleOps: true, ops: HTTP_OPS },

  // --- Edge / proxies ----------------------------------------------------------------------------------------------------
  { id: 'nginx', name: 'nginx', category: 'proxy', layer: 'edge', description: 'Web server and reverse proxy.', images: /^(?:nginx|nginxinc\/nginx-unprivileged|bitnami\/nginx|jwilder\/nginx-proxy|nginxproxy\/nginx-proxy)$/, helm: /^(?:nginx|ingress-nginx)$/ },
  { id: 'traefik', name: 'Traefik', category: 'proxy', layer: 'edge', description: 'Cloud-native reverse proxy and load balancer.', images: /^traefik$/, helm: /^traefik$/ },
  { id: 'caddy', name: 'Caddy', category: 'proxy', layer: 'edge', description: 'Web server with automatic HTTPS.', images: /^caddy$/ },
  { id: 'haproxy', name: 'HAProxy', category: 'proxy', layer: 'edge', description: 'Load balancer and proxy.', images: /^haproxy$/ },
  { id: 'envoy', name: 'Envoy', category: 'proxy', layer: 'edge', description: 'Service proxy.', images: /^envoyproxy\/envoy$/ },
  { id: 'kong', name: 'Kong', category: 'proxy', layer: 'edge', description: 'API gateway.', images: /^kong(?:\/kong-gateway)?$/ },
  { id: 'api-gateway', name: 'Amazon API Gateway', category: 'proxy', layer: 'edge', description: 'Managed API gateway on AWS.', terraform: /^aws_api_gateway_\w+$|^aws_apigatewayv2_\w+$/ },
  { id: 'cloudfront', name: 'Amazon CloudFront', category: 'proxy', layer: 'edge', description: 'CDN on AWS.', terraform: /^aws_cloudfront_distribution$/ },
  { id: 'cloudflare-workers', name: 'Cloudflare Workers', category: 'hosting', layer: 'edge', description: 'Serverless functions at the edge.', npm: ['wrangler', '@cloudflare/workers-types'] },
  { id: 'nextjs-middleware', name: 'Next.js middleware', category: 'proxy', layer: 'edge', description: 'Code that runs before Next.js routes match a request.' },
  { id: 'k8s-ingress', name: 'Kubernetes Ingress', category: 'proxy', layer: 'edge', description: 'HTTP routing into a Kubernetes cluster.' },

  // --- Delivery: containers, orchestration, IaC, CI, hosting --------------------------------------------------------------------
  { id: 'docker', name: 'Docker', category: 'container', layer: 'delivery', description: 'Container images built from Dockerfiles.' },
  { id: 'docker-compose', name: 'Docker Compose', category: 'orchestration', layer: 'delivery', description: 'Multi-container definitions for local or single-host deployment.' },
  { id: 'kubernetes', name: 'Kubernetes', category: 'orchestration', layer: 'delivery', description: 'Container orchestration platform.' },
  { id: 'helm', name: 'Helm', category: 'orchestration', layer: 'delivery', description: 'Package manager for Kubernetes.' },
  { id: 'terraform', name: 'Terraform', category: 'iac', layer: 'delivery', description: 'Infrastructure as code.' },
  { id: 'pulumi', name: 'Pulumi', category: 'iac', layer: 'delivery', description: 'Infrastructure as code in general-purpose languages.', npm: ['@pulumi/pulumi'], pypi: ['pulumi'] },
  { id: 'aws-cdk', name: 'AWS CDK', category: 'iac', layer: 'delivery', description: 'Infrastructure as code for AWS.', npm: ['aws-cdk-lib', 'aws-cdk'], pypi: ['aws-cdk-lib'] },
  { id: 'serverless-framework', name: 'Serverless Framework', category: 'iac', layer: 'delivery', description: 'Deploys functions and their events to cloud providers.', npm: ['serverless'] },
  { id: 'github-actions', name: 'GitHub Actions', category: 'ci', layer: 'delivery', description: 'CI/CD workflows on GitHub.' },
  { id: 'gitlab-ci', name: 'GitLab CI', category: 'ci', layer: 'delivery', description: 'CI/CD pipelines on GitLab.' },
  { id: 'circleci', name: 'CircleCI', category: 'ci', layer: 'delivery', description: 'Hosted CI/CD.' },
  { id: 'azure-pipelines', name: 'Azure Pipelines', category: 'ci', layer: 'delivery', description: 'CI/CD on Azure DevOps.' },
  { id: 'bitbucket-pipelines', name: 'Bitbucket Pipelines', category: 'ci', layer: 'delivery', description: 'CI/CD on Bitbucket.' },
  { id: 'jenkins', name: 'Jenkins', category: 'ci', layer: 'delivery', description: 'Self-hosted CI/CD server.' },
  { id: 'travis', name: 'Travis CI', category: 'ci', layer: 'delivery', description: 'Hosted CI.' },
  { id: 'vercel', name: 'Vercel', category: 'hosting', layer: 'delivery', description: 'Hosting platform for frontend frameworks and serverless functions.', npm: ['vercel', '@vercel/node'] },
  { id: 'netlify', name: 'Netlify', category: 'hosting', layer: 'delivery', description: 'Hosting platform for web apps and functions.', npm: ['netlify-cli', '@netlify/functions'] },
  { id: 'flyio', name: 'Fly.io', category: 'hosting', layer: 'delivery', description: 'Platform that runs containers close to users.' },
  { id: 'render', name: 'Render', category: 'hosting', layer: 'delivery', description: 'Cloud hosting for web services, workers and databases.' },
  { id: 'railway', name: 'Railway', category: 'hosting', layer: 'delivery', description: 'Cloud platform for deploying apps and databases.' },
  { id: 'heroku', name: 'Heroku', category: 'hosting', layer: 'delivery', description: 'Platform-as-a-service for apps defined by a Procfile.' },
  { id: 'gae', name: 'Google App Engine', category: 'hosting', layer: 'delivery', description: 'Managed app hosting on Google Cloud.' },
  { id: 'cloud-run', name: 'Google Cloud Run', category: 'hosting', layer: 'delivery', description: 'Serverless containers on Google Cloud.', terraform: /^google_cloud_run_(?:v2_)?service$/ },
  { id: 'aws-lambda', name: 'AWS Lambda', category: 'hosting', layer: 'delivery', description: 'Serverless functions on AWS.', npm: ['@types/aws-lambda', 'aws-lambda'], terraform: /^aws_lambda_function$/ },
  { id: 'aws-ecs', name: 'Amazon ECS', category: 'hosting', layer: 'delivery', description: 'Container orchestration on AWS.', terraform: /^aws_ecs_(?:service|cluster|task_definition)$/ },
  { id: 'aws-eks', name: 'Amazon EKS', category: 'hosting', layer: 'delivery', description: 'Managed Kubernetes on AWS.', terraform: /^aws_eks_cluster$/ },
  { id: 'aws-ec2', name: 'Amazon EC2', category: 'hosting', layer: 'delivery', description: 'Virtual machines on AWS.', terraform: /^aws_instance$|^aws_launch_template$|^aws_autoscaling_group$/ },
  { id: 'aws-rds', name: 'Amazon RDS', category: 'database', layer: 'data', description: 'Managed relational databases on AWS.', terraform: /^aws_db_instance$|^aws_rds_cluster$/ },
  { id: 'gke', name: 'Google Kubernetes Engine', category: 'hosting', layer: 'delivery', description: 'Managed Kubernetes on Google Cloud.', terraform: /^google_container_cluster$/ },
  { id: 'cloud-sql', name: 'Google Cloud SQL', category: 'database', layer: 'data', description: 'Managed relational databases on Google Cloud.', terraform: /^google_sql_database_instance$/ },
  { id: 'azure-app-service', name: 'Azure App Service', category: 'hosting', layer: 'delivery', description: 'Managed web app hosting on Azure.', terraform: /^azurerm_(?:linux_|windows_)?web_app$|^azurerm_app_service$/ },
  { id: 'firebase-hosting', name: 'Firebase Hosting', category: 'hosting', layer: 'delivery', description: 'Static and dynamic web hosting from Firebase.' },
  { id: 'container-registry', name: 'Container registry', category: 'container', layer: 'delivery', description: 'Stores built container images (Docker Hub, GHCR, ECR, GCR…).', terraform: /^aws_ecr_repository$|^google_artifact_registry_repository$/ },
];

export const CATALOG_BY_ID = new Map(CATALOG.map((e) => [e.id, e]));

// --- Lookup indexes ------------------------------------------------------------------------------------------------------------

type PackageKey = 'npm' | 'pypi' | 'go' | 'cargo' | 'gem' | 'composer' | 'maven' | 'nuget';

const normalizePy = (n: string) => n.toLowerCase().replace(/[-_.]+/g, '-');

function matchName(list: string[] | undefined, name: string, eco: PackageKey): boolean {
  if (!list) return false;
  const target = eco === 'pypi' ? normalizePy(name) : eco === 'nuget' || eco === 'gem' ? name.toLowerCase() : name;
  for (const raw of list) {
    const entry = eco === 'pypi' ? normalizePy(raw) : eco === 'nuget' || eco === 'gem' ? raw.toLowerCase() : raw;
    if (entry.endsWith('/') || entry.endsWith('*') || entry.endsWith(':') || entry.endsWith('.')) {
      const prefix = entry.replace(/\*$/, '');
      if (target.startsWith(prefix)) return true;
    } else if (eco === 'go' ? target === entry || target.startsWith(entry + '/') : target === entry) {
      return true;
    }
  }
  return false;
}

/** Catalog entries whose package list contains `name` for the given ecosystem. */
export function toolsForPackage(eco: PackageKey, name: string): CatalogEntry[] {
  return CATALOG.filter((e) => matchName(e[eco], name, eco));
}

/** Catalog entries recognizing a source-level module import (Python dotted path, Go import path, …). */
export function toolsForModule(lang: SourceLanguage, module: string): CatalogEntry[] {
  if (lang === 'js') {
    // `next/link` → next, `@vercel/analytics/react` → @vercel/analytics; full specifiers match sub-path entries.
    const pkg = /^(@[^/]+\/[^/]+|[^/]+)/.exec(module)?.[1] ?? module;
    const out = toolsForPackage('npm', module);
    for (const t of pkg !== module ? toolsForPackage('npm', pkg) : []) if (!out.includes(t)) out.push(t);
    return out;
  }
  const out: CatalogEntry[] = [];
  for (const e of CATALOG) {
    const prefixes = e.modules?.[lang];
    if (!prefixes) continue;
    const sep = lang === 'python' || lang === 'java' || lang === 'csharp' ? '.' : lang === 'php' ? '\\' : lang === 'rust' ? '::' : '/';
    if (prefixes.some((p) => module === p || module.startsWith(p + sep))) out.push(e);
  }
  return out;
}

export function toolForImage(image: string): CatalogEntry | undefined {
  const repo = imageRepository(image);
  return CATALOG.find((e) => e.images?.test(repo));
}

export function toolForScheme(scheme: string): CatalogEntry | undefined {
  const s = scheme.toLowerCase();
  return CATALOG.find((e) => e.schemes?.includes(s));
}

export function toolForTerraform(type: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.terraform?.test(type));
}

export function toolForHelmChart(name: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.helm?.test(name));
}

export function toolsForEnv(name: string): CatalogEntry[] {
  return CATALOG.filter((e) => e.env?.test(name));
}

/** `docker.io/library/postgres:16-alpine@sha…` → `postgres`; keeps org paths (`bitnami/redis`). */
export function imageRepository(image: string): string {
  let s = image.trim().replace(/@sha256:[a-f0-9]+$/i, '');
  const lastSlash = s.lastIndexOf('/');
  const colon = s.indexOf(':', lastSlash + 1);
  if (colon >= 0) s = s.slice(0, colon);
  s = s.replace(/^(?:docker\.io\/)?(?:library\/)/, '').replace(/^docker\.io\//, '');
  return s.toLowerCase();
}

export function imageTag(image: string): string | undefined {
  const s = image.trim().replace(/@sha256:[a-f0-9]+$/i, '');
  const lastSlash = s.lastIndexOf('/');
  const colon = s.indexOf(':', lastSlash + 1);
  return colon >= 0 ? s.slice(colon + 1) : undefined;
}
