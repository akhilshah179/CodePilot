#!/usr/bin/env node
import { Command } from 'commander';
import { build } from './commands/build.js';

const program = new Command();
program.command('build').argument('<dir>').action((dir) => build(dir));
program.parse();
