export function formatDate(d: Date): string {
  return d.toISOString();
}

export const cn = (...classes: string[]) => classes.join(' ');
