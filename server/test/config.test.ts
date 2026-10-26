import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, parsePort } from '../src/config.ts';

describe('Configuration & Port/Host Binding for Render and Local', () => {
  const originalEnv = { ...process.env };
  const dummyTokenKey = Buffer.alloc(32);

  beforeEach(() => {
    // Reset process.env to a predictable base
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.RENDER;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('parsePort', () => {
    it('returns defaultPort when value is undefined, null, or empty string', () => {
      expect(parsePort(undefined, 8787)).toBe(8787);
      expect(parsePort(null, 8787)).toBe(8787);
      expect(parsePort('', 8787)).toBe(8787);
      expect(parsePort('   ', 8787)).toBe(8787);
    });

    it('parses valid numeric and string ports', () => {
      expect(parsePort('80')).toBe(80);
      expect(parsePort('8787')).toBe(8787);
      expect(parsePort('10000')).toBe(10000);
      expect(parsePort(10000)).toBe(10000);
      expect(parsePort('65535')).toBe(65535);
    });

    it('throws clear error on invalid ports', () => {
      expect(() => parsePort('0')).toThrow(/Invalid port: "0"/);
      expect(() => parsePort('-1')).toThrow(/Invalid port: "-1"/);
      expect(() => parsePort('65536')).toThrow(/Invalid port: "65536"/);
      expect(() => parsePort('abc')).toThrow(/Invalid port: "abc"/);
      expect(() => parsePort('8080.5')).toThrow(/Invalid port: "8080.5"/);
      expect(() => parsePort(NaN)).toThrow(/Invalid port: "NaN"/);
    });
  });

  describe('Local development defaults', () => {
    it('defaults to 127.0.0.1 and port 8787 when no environment variables are set', () => {
      process.env.NODE_ENV = 'development';
      const config = loadConfig();
      expect(config.host).toBe('127.0.0.1');
      expect(config.port).toBe(8787);
      expect(config.production).toBe(false);
    });

    it('PORT environment variable overrides local default', () => {
      process.env.NODE_ENV = 'development';
      process.env.PORT = '9000';
      const config = loadConfig();
      expect(config.port).toBe(9000);
      expect(config.host).toBe('127.0.0.1');
    });

    it('HOST environment variable can override local host if specified', () => {
      process.env.NODE_ENV = 'development';
      process.env.HOST = '0.0.0.0';
      const config = loadConfig();
      expect(config.host).toBe('0.0.0.0');
    });
  });

  describe('Production & Render environment configuration', () => {
    it('binds to 0.0.0.0 by default in production (NODE_ENV=production)', () => {
      process.env.NODE_ENV = 'production';
      const config = loadConfig({ tokenKey: dummyTokenKey });
      expect(config.host).toBe('0.0.0.0');
      expect(config.production).toBe(true);
    });

    it('binds to 0.0.0.0 and detects production when RENDER=true', () => {
      process.env.RENDER = 'true';
      const config = loadConfig({ tokenKey: dummyTokenKey });
      expect(config.host).toBe('0.0.0.0');
      expect(config.production).toBe(true);
    });

    it('on Render, process.env.PORT takes highest priority over overrides', () => {
      process.env.RENDER = 'true';
      process.env.PORT = '10000';
      const config = loadConfig({ port: 3000, tokenKey: dummyTokenKey });
      expect(config.port).toBe(10000);
      expect(config.host).toBe('0.0.0.0');
    });

    it('on Render, normalizes accidental 127.0.0.1 / localhost to 0.0.0.0 to prevent scan timeout', () => {
      process.env.RENDER = 'true';
      process.env.HOST = '127.0.0.1';
      const config = loadConfig({ tokenKey: dummyTokenKey });
      expect(config.host).toBe('0.0.0.0');

      process.env.HOST = 'localhost';
      const config2 = loadConfig({ tokenKey: dummyTokenKey });
      expect(config2.host).toBe('0.0.0.0');
    });

    it('throws when invalid PORT is provided in environment', () => {
      process.env.PORT = 'not-a-port';
      expect(() => loadConfig({ tokenKey: dummyTokenKey })).toThrow(/Invalid port: "not-a-port"/);

      process.env.PORT = '99999';
      expect(() => loadConfig({ tokenKey: dummyTokenKey })).toThrow(/Invalid port: "99999"/);
    });
  });
});
