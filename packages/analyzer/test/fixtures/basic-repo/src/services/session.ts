import { api } from '@fixture/shared';
import { tokens } from '@fixture/shared/tokens';
import { nope } from '@fixture/shared/private';
import '@fixture/broken';

export function getUser() {
  return api('/me', tokens, nope);
}
