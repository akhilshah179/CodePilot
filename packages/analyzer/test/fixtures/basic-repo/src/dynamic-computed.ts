const name = 'app';

export async function load() {
  return import(`./${name}`);
}
