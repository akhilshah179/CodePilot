import { getUser } from '#internal/session';

export function useSession() {
  return getUser();
}
